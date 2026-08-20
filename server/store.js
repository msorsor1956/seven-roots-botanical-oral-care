import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const emptyData = () => ({ version: 2, waitlist: [], inquiries: [], orders: [], stripeEvents: [] });

const stringId = (value) => typeof value === "string" ? value : value?.id || "";
const safeQuantity = (value) => Math.max(1, Math.min(Number.parseInt(value, 10) || 1, 10));
const stripeDate = (value) => Number.isFinite(value) ? new Date(value * 1000).toISOString() : new Date().toISOString();

const checkoutStatus = (eventType, session) => {
  if (eventType === "checkout.session.async_payment_failed") return "payment_failed";
  if (eventType === "checkout.session.expired") return "expired";
  if (eventType === "checkout.session.async_payment_succeeded") return "paid";
  if (["paid", "no_payment_required"].includes(session.payment_status)) return "paid";
  return "pending";
};

const compactAddress = (address) => address ? {
  line1: address.line1 || "",
  line2: address.line2 || "",
  city: address.city || "",
  state: address.state || "",
  postalCode: address.postal_code || "",
  country: address.country || ""
} : null;

export class JsonStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "seven-roots-data.json");
    this.data = emptyData();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.filePath, "utf8"));
      this.data = {
        version: 2,
        waitlist: Array.isArray(saved.waitlist) ? saved.waitlist : [],
        inquiries: Array.isArray(saved.inquiries) ? saved.inquiries : [],
        orders: Array.isArray(saved.orders) ? saved.orders : [],
        stripeEvents: Array.isArray(saved.stripeEvents) ? saved.stripeEvents.slice(0, 2000) : []
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
    return this;
  }

  async persist() {
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }

  async addWaitlist(entry) {
    const now = new Date().toISOString();
    const existing = this.data.waitlist.find((item) => item.email === entry.email);
    if (existing) {
      existing.name = entry.name;
      existing.preferredFormat = entry.preferredFormat;
      existing.country = entry.country;
      existing.source = entry.source;
      existing.updatedAt = now;
      await this.persist();
      return { record: existing, created: false };
    }
    const record = {
      id: randomUUID(),
      name: entry.name,
      email: entry.email,
      preferredFormat: entry.preferredFormat,
      country: entry.country,
      source: entry.source,
      status: "new",
      createdAt: now,
      updatedAt: now
    };
    this.data.waitlist.unshift(record);
    await this.persist();
    return { record, created: true };
  }

  async addInquiry(entry) {
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      name: entry.name,
      email: entry.email,
      phone: entry.phone,
      organization: entry.organization,
      inquiryType: entry.inquiryType,
      message: entry.message,
      status: "new",
      createdAt: now
    };
    this.data.inquiries.unshift(record);
    await this.persist();
    return record;
  }

  async applyStripeEvent(event) {
    if (!event?.id || !event?.type) throw new Error("Invalid Stripe event.");
    if (this.data.stripeEvents.includes(event.id)) return { duplicate: true, order: null };

    const object = event.data?.object || {};
    let order = null;
    if (event.type.startsWith("checkout.session.")) {
      const sessionId = object.id;
      const now = new Date().toISOString();
      order = this.data.orders.find((item) => item.stripeSessionId === sessionId);
      const shippingDetails = object.collected_information?.shipping_details || object.shipping_details || null;
      const customer = object.customer_details || {};
      const metadata = object.metadata || {};
      const update = {
        stripeSessionId: sessionId,
        stripePaymentIntentId: stringId(object.payment_intent),
        livemode: Boolean(event.livemode),
        status: checkoutStatus(event.type, object),
        paymentStatus: object.payment_status || "unpaid",
        formatSlug: metadata.format_slug || order?.formatSlug || "",
        formatName: metadata.format_name || order?.formatName || "",
        sku: metadata.sku || order?.sku || "",
        quantity: safeQuantity(metadata.quantity || order?.quantity),
        amountSubtotal: Number.isInteger(object.amount_subtotal) ? object.amount_subtotal : order?.amountSubtotal ?? null,
        amountTotal: Number.isInteger(object.amount_total) ? object.amount_total : order?.amountTotal ?? null,
        currency: String(object.currency || order?.currency || "").toUpperCase(),
        customer: {
          name: customer.name || shippingDetails?.name || order?.customer?.name || "",
          email: customer.email || object.customer_email || order?.customer?.email || "",
          phone: customer.phone || order?.customer?.phone || ""
        },
        shipping: shippingDetails ? {
          name: shippingDetails.name || "",
          address: compactAddress(shippingDetails.address)
        } : order?.shipping || null,
        updatedAt: now
      };
      if (order) Object.assign(order, update);
      else {
        order = {
          id: randomUUID(),
          orderNumber: `SR-${stripeDate(object.created).slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`,
          refundedAmount: 0,
          createdAt: stripeDate(object.created),
          ...update
        };
        this.data.orders.unshift(order);
      }
    }

    if (event.type === "charge.refunded") {
      const paymentIntentId = stringId(object.payment_intent);
      order = this.data.orders.find((item) => item.stripePaymentIntentId === paymentIntentId) || null;
      if (order) {
        order.refundedAmount = Number.isInteger(object.amount_refunded) ? object.amount_refunded : order.refundedAmount;
        order.status = object.refunded ? "refunded" : "partially_refunded";
        order.updatedAt = new Date().toISOString();
      }
    }

    if (event.type === "payment_intent.payment_failed") {
      order = this.data.orders.find((item) => item.stripePaymentIntentId === object.id) || null;
      if (order) {
        order.status = "payment_failed";
        order.paymentStatus = "unpaid";
        order.updatedAt = new Date().toISOString();
      }
    }

    this.data.stripeEvents.unshift(event.id);
    this.data.stripeEvents = this.data.stripeEvents.slice(0, 2000);
    await this.persist();
    return { duplicate: false, order };
  }

  publicOrder(stripeSessionId) {
    const order = this.data.orders.find((item) => item.stripeSessionId === stripeSessionId);
    if (!order) return null;
    return {
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      formatSlug: order.formatSlug,
      formatName: order.formatName,
      sku: order.sku,
      quantity: order.quantity,
      amountTotal: order.amountTotal,
      currency: order.currency,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    };
  }

  summary() {
    const formatInterest = this.data.waitlist.reduce((summary, entry) => {
      summary[entry.preferredFormat] = (summary[entry.preferredFormat] || 0) + 1;
      return summary;
    }, {});
    const paidRevenue = this.data.orders.reduce((summary, order) => {
      if (!["paid", "partially_refunded", "refunded"].includes(order.status) || !order.currency || !Number.isInteger(order.amountTotal)) return summary;
      const netAmount = Math.max(0, order.amountTotal - (order.refundedAmount || 0));
      summary[order.currency] = (summary[order.currency] || 0) + netAmount;
      return summary;
    }, {});
    return {
      waitlistTotal: this.data.waitlist.length,
      inquiryTotal: this.data.inquiries.length,
      orderTotal: this.data.orders.length,
      paidOrderTotal: this.data.orders.filter((order) => order.status === "paid").length,
      pendingOrderTotal: this.data.orders.filter((order) => order.status === "pending").length,
      paidRevenue,
      formatInterest
    };
  }

  list(collection, limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return Array.isArray(this.data[collection]) ? this.data[collection].slice(0, safeLimit) : [];
  }
}
