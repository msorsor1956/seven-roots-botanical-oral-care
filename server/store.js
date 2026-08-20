import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { formats } from "./catalog.js";

const DATA_VERSION = 3;
const MAX_STORED_EVENTS = 2000;
const MAX_STORED_RESERVATIONS = 5000;
const RESERVATION_MAX_AGE_MS = 31 * 60 * 60 * 1000;
const paidStatuses = new Set(["paid", "partially_refunded", "refunded"]);

const emptyData = () => ({
  version: DATA_VERSION,
  waitlist: [],
  inquiries: [],
  orders: [],
  payments: [],
  inventory: [],
  inventoryReservations: [],
  inventoryAdjustments: [],
  stripeEvents: []
});

const stringId = (value) => typeof value === "string" ? value : value?.id || "";
const safeQuantity = (value) => Math.max(1, Math.min(Number.parseInt(value, 10) || 1, 10));
const stripeDate = (value) => Number.isFinite(value) ? new Date(value * 1000).toISOString() : new Date().toISOString();
const isCents = (value) => Number.isInteger(value) && value >= 0;

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

const paymentStatusForOrder = (order) => {
  if (order.status === "payment_failed") return "failed";
  if (order.status === "expired") return "expired";
  if (order.status === "refunded") return "refunded";
  if (order.status === "partially_refunded") return "partially_refunded";
  if (order.status === "paid") return "paid";
  return "pending";
};

const monthKey = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "unknown" : date.toISOString().slice(0, 7);
};

export class InventoryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.code = "insufficient_inventory";
    this.details = details;
  }
}

export class JsonStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "seven-roots-data.json");
    this.data = emptyData();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    let needsPersist = false;
    let savedVersion = 0;
    try {
      const saved = JSON.parse(await readFile(this.filePath, "utf8"));
      savedVersion = Number(saved.version) || 0;
      this.data = {
        version: DATA_VERSION,
        waitlist: Array.isArray(saved.waitlist) ? saved.waitlist : [],
        inquiries: Array.isArray(saved.inquiries) ? saved.inquiries : [],
        orders: Array.isArray(saved.orders) ? saved.orders : [],
        payments: Array.isArray(saved.payments) ? saved.payments : [],
        inventory: Array.isArray(saved.inventory) ? saved.inventory : [],
        inventoryReservations: Array.isArray(saved.inventoryReservations) ? saved.inventoryReservations : [],
        inventoryAdjustments: Array.isArray(saved.inventoryAdjustments) ? saved.inventoryAdjustments : [],
        stripeEvents: Array.isArray(saved.stripeEvents) ? saved.stripeEvents.slice(0, MAX_STORED_EVENTS) : []
      };
      needsPersist = savedVersion !== DATA_VERSION;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.data = emptyData();
      needsPersist = true;
    }

    const now = new Date().toISOString();
    const migratingInventory = savedVersion < DATA_VERSION || this.data.inventory.length === 0;
    for (const format of formats) {
      let item = this.data.inventory.find((record) => record.formatSlug === format.slug);
      if (!item) {
        item = {
          id: randomUUID(),
          formatSlug: format.slug,
          formatName: format.name,
          sku: format.sku,
          stockOnHand: null,
          reorderLevel: 5,
          unitsSold: migratingInventory
            ? this.data.orders.filter((order) => paidStatuses.has(order.status) && order.formatSlug === format.slug)
              .reduce((total, order) => total + safeQuantity(order.quantity), 0)
            : 0,
          updatedAt: now
        };
        this.data.inventory.push(item);
        needsPersist = true;
      } else {
        item.formatName = format.name;
        item.sku = format.sku;
        if (!Number.isInteger(item.unitsSold)) item.unitsSold = 0;
        if (!Number.isInteger(item.reorderLevel)) item.reorderLevel = 5;
      }
    }

    for (const order of this.data.orders) {
      if (paidStatuses.has(order.status) && !order.inventoryAppliedAt) {
        order.inventoryAppliedAt = order.createdAt || now;
        needsPersist = true;
      }
      if (!isCents(order.refundedAmount)) order.refundedAmount = 0;
    }

    if (this.data.payments.length === 0 && this.data.orders.length > 0) {
      for (const order of this.data.orders) this.#upsertPaymentFromOrder(order, "data.migrated", {});
      needsPersist = true;
    }

    if (this.#pruneStaleReservations()) needsPersist = true;
    if (needsPersist) await this.persist();
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

  #inventoryRecord(formatSlug) {
    return this.data.inventory.find((item) => item.formatSlug === formatSlug) || null;
  }

  #activeReserved(formatSlug) {
    return this.data.inventoryReservations
      .filter((reservation) => reservation.formatSlug === formatSlug && reservation.status === "active" && reservation.trackedAtCheckout)
      .reduce((total, reservation) => total + safeQuantity(reservation.quantity), 0);
  }

  #pruneStaleReservations() {
    const cutoff = Date.now() - RESERVATION_MAX_AGE_MS;
    let changed = false;
    for (const reservation of this.data.inventoryReservations) {
      if (reservation.status !== "active") continue;
      const created = new Date(reservation.createdAt).valueOf();
      if (!Number.isFinite(created) || created >= cutoff) continue;
      reservation.status = "stale";
      reservation.releasedAt = new Date().toISOString();
      changed = true;
    }
    this.data.inventoryReservations = this.data.inventoryReservations.slice(0, MAX_STORED_RESERVATIONS);
    return changed;
  }

  async reserveInventory(format, quantity, token) {
    this.#pruneStaleReservations();
    const safeToken = String(token || "").slice(0, 160);
    const existing = this.data.inventoryReservations.find((reservation) => reservation.token === safeToken);
    if (existing) {
      if (existing.formatSlug !== format.slug || existing.quantity !== quantity) {
        throw new InventoryError("This checkout request was already used for a different product.");
      }
      if (existing.status === "active") return existing;
      throw new InventoryError("This checkout request has already been finalized. Start a new checkout.", { formatSlug: format.slug });
    }

    const inventory = this.#inventoryRecord(format.slug);
    const tracked = Number.isInteger(inventory?.stockOnHand);
    if (tracked) {
      const available = Math.max(0, inventory.stockOnHand - this.#activeReserved(format.slug));
      if (available < quantity) {
        throw new InventoryError(
          available === 0 ? `${format.name} is currently sold out.` : `Only ${available} ${format.name} ${available === 1 ? "pack is" : "packs are"} available.`,
          { formatSlug: format.slug, available }
        );
      }
    }

    const reservation = {
      id: randomUUID(),
      token: safeToken,
      stripeSessionId: "",
      formatSlug: format.slug,
      quantity,
      trackedAtCheckout: tracked,
      status: "active",
      createdAt: new Date().toISOString()
    };
    this.data.inventoryReservations.unshift(reservation);
    this.data.inventoryReservations = this.data.inventoryReservations.slice(0, MAX_STORED_RESERVATIONS);
    await this.persist();
    return reservation;
  }

  async attachInventoryReservation(token, stripeSessionId) {
    const reservation = this.data.inventoryReservations.find((item) => item.token === String(token || "").slice(0, 160) && item.status === "active");
    if (!reservation) return null;
    reservation.stripeSessionId = stripeSessionId;
    await this.persist();
    return reservation;
  }

  async releaseInventoryReservation(token, reason = "checkout_failed") {
    const reservation = this.data.inventoryReservations.find((item) => item.token === String(token || "").slice(0, 160) && item.status === "active");
    if (!reservation) return null;
    reservation.status = reason;
    reservation.releasedAt = new Date().toISOString();
    await this.persist();
    return reservation;
  }

  #completeInventoryForOrder(order, now) {
    if (order.inventoryAppliedAt || !paidStatuses.has(order.status)) return;
    const inventory = this.#inventoryRecord(order.formatSlug);
    const reservation = this.data.inventoryReservations.find((item) => item.stripeSessionId === order.stripeSessionId && item.status === "active");
    const quantity = safeQuantity(order.quantity);
    if (inventory) {
      inventory.unitsSold = Math.max(0, Number(inventory.unitsSold) || 0) + quantity;
      if (Number.isInteger(inventory.stockOnHand)) {
        inventory.stockOnHand = Math.max(0, inventory.stockOnHand - quantity);
      }
      inventory.updatedAt = now;
    }
    if (reservation) {
      reservation.status = "converted";
      reservation.releasedAt = now;
    }
    order.inventoryAppliedAt = now;
  }

  #releaseSessionReservation(stripeSessionId, status, now) {
    const reservation = this.data.inventoryReservations.find((item) => item.stripeSessionId === stripeSessionId && item.status === "active");
    if (!reservation) return;
    reservation.status = status;
    reservation.releasedAt = now;
  }

  #upsertPaymentFromOrder(order, eventType, stripeObject) {
    let payment = this.data.payments.find((item) => (
      (order.stripePaymentIntentId && item.stripePaymentIntentId === order.stripePaymentIntentId) ||
      (order.stripeSessionId && item.stripeSessionId === order.stripeSessionId)
    ));
    const now = new Date().toISOString();
    const update = {
      provider: "stripe",
      stripePaymentIntentId: order.stripePaymentIntentId || payment?.stripePaymentIntentId || "",
      stripeChargeId: stripeObject.object === "charge" ? stripeObject.id || payment?.stripeChargeId || "" : payment?.stripeChargeId || "",
      stripeSessionId: order.stripeSessionId || payment?.stripeSessionId || "",
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: paymentStatusForOrder(order),
      amount: isCents(order.amountTotal) ? order.amountTotal : payment?.amount ?? null,
      amountRefunded: isCents(order.refundedAmount) ? order.refundedAmount : payment?.amountRefunded || 0,
      currency: order.currency || payment?.currency || "",
      customer: {
        name: order.customer?.name || payment?.customer?.name || "",
        email: order.customer?.email || payment?.customer?.email || ""
      },
      livemode: Boolean(order.livemode),
      lastEventType: eventType,
      updatedAt: now
    };
    if (payment) Object.assign(payment, update);
    else {
      payment = { id: randomUUID(), createdAt: order.createdAt || now, ...update };
      this.data.payments.unshift(payment);
    }
    return payment;
  }

  #upsertFailedPayment(paymentIntent, eventType) {
    let payment = this.data.payments.find((item) => item.stripePaymentIntentId === paymentIntent.id);
    const now = new Date().toISOString();
    const update = {
      provider: "stripe",
      stripePaymentIntentId: paymentIntent.id,
      status: "failed",
      amount: isCents(paymentIntent.amount) ? paymentIntent.amount : payment?.amount ?? null,
      amountRefunded: payment?.amountRefunded || 0,
      currency: String(paymentIntent.currency || payment?.currency || "").toUpperCase(),
      failureMessage: String(paymentIntent.last_payment_error?.message || "Payment was not completed.").slice(0, 280),
      livemode: Boolean(paymentIntent.livemode),
      lastEventType: eventType,
      updatedAt: now
    };
    if (payment) Object.assign(payment, update);
    else {
      payment = {
        id: randomUUID(),
        stripeChargeId: "",
        stripeSessionId: "",
        orderId: "",
        orderNumber: "",
        customer: { name: "", email: String(paymentIntent.receipt_email || "") },
        createdAt: stripeDate(paymentIntent.created),
        ...update
      };
      this.data.payments.unshift(payment);
    }
    return payment;
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
      const totalDetails = object.total_details || {};
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
        amountSubtotal: isCents(object.amount_subtotal) ? object.amount_subtotal : order?.amountSubtotal ?? null,
        amountShipping: isCents(totalDetails.amount_shipping) ? totalDetails.amount_shipping : order?.amountShipping ?? 0,
        amountTax: isCents(totalDetails.amount_tax) ? totalDetails.amount_tax : order?.amountTax ?? 0,
        amountTotal: isCents(object.amount_total) ? object.amount_total : order?.amountTotal ?? null,
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
      this.#completeInventoryForOrder(order, now);
      if (["expired", "payment_failed"].includes(order.status)) this.#releaseSessionReservation(sessionId, order.status, now);
      this.#upsertPaymentFromOrder(order, event.type, object);
    }

    if (event.type === "charge.refunded") {
      const paymentIntentId = stringId(object.payment_intent);
      order = this.data.orders.find((item) => item.stripePaymentIntentId === paymentIntentId) || null;
      if (order) {
        order.refundedAmount = isCents(object.amount_refunded) ? object.amount_refunded : order.refundedAmount;
        order.status = object.refunded ? "refunded" : "partially_refunded";
        order.updatedAt = new Date().toISOString();
        this.#upsertPaymentFromOrder(order, event.type, object);
      }
    }

    if (event.type === "payment_intent.payment_failed") {
      order = this.data.orders.find((item) => item.stripePaymentIntentId === object.id) || null;
      if (order) {
        order.status = "payment_failed";
        order.paymentStatus = "unpaid";
        order.updatedAt = new Date().toISOString();
        this.#releaseSessionReservation(order.stripeSessionId, "payment_failed", order.updatedAt);
        this.#upsertPaymentFromOrder(order, event.type, object);
      } else this.#upsertFailedPayment(object, event.type);
    }

    this.data.stripeEvents.unshift(event.id);
    this.data.stripeEvents = this.data.stripeEvents.slice(0, MAX_STORED_EVENTS);
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
      amountSubtotal: order.amountSubtotal,
      amountShipping: order.amountShipping,
      amountTax: order.amountTax,
      amountTotal: order.amountTotal,
      currency: order.currency,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    };
  }

  inventoryReport() {
    this.#pruneStaleReservations();
    return this.data.inventory.map((item) => {
      const tracked = Number.isInteger(item.stockOnHand);
      const reserved = tracked ? this.#activeReserved(item.formatSlug) : 0;
      const available = tracked ? Math.max(0, item.stockOnHand - reserved) : null;
      const status = !tracked ? "not_tracked" : available === 0 ? "sold_out" : available <= item.reorderLevel ? "low_stock" : "in_stock";
      return {
        id: item.id,
        formatSlug: item.formatSlug,
        formatName: item.formatName,
        sku: item.sku,
        tracking: tracked,
        stockOnHand: tracked ? item.stockOnHand : null,
        reserved,
        available,
        reorderLevel: item.reorderLevel,
        unitsSold: item.unitsSold,
        status,
        updatedAt: item.updatedAt
      };
    });
  }

  publicAvailability(formatSlug) {
    const item = this.inventoryReport().find((record) => record.formatSlug === formatSlug);
    if (!item || !item.tracking) return { status: "available", tracked: false };
    return { status: item.available === 0 ? "sold_out" : "available", tracked: true };
  }

  async updateInventory(formatSlug, update) {
    const item = this.#inventoryRecord(formatSlug);
    if (!item) return null;
    const now = new Date().toISOString();
    const previousStockOnHand = Number.isInteger(item.stockOnHand) ? item.stockOnHand : null;
    if (Object.hasOwn(update, "stockOnHand")) item.stockOnHand = update.stockOnHand;
    if (Object.hasOwn(update, "reorderLevel")) item.reorderLevel = update.reorderLevel;
    item.updatedAt = now;
    this.data.inventoryAdjustments.unshift({
      id: randomUUID(),
      formatSlug,
      previousStockOnHand,
      stockOnHand: Number.isInteger(item.stockOnHand) ? item.stockOnHand : null,
      delta: Number.isInteger(previousStockOnHand) && Number.isInteger(item.stockOnHand) ? item.stockOnHand - previousStockOnHand : null,
      reason: String(update.reason || "Manual inventory count").slice(0, 180),
      createdAt: now
    });
    this.data.inventoryAdjustments = this.data.inventoryAdjustments.slice(0, 2000);
    await this.persist();
    return this.inventoryReport().find((record) => record.formatSlug === formatSlug);
  }

  financialReport() {
    const totals = new Map();
    const monthly = new Map();
    const products = new Map();
    const statuses = { paid: 0, pending: 0, failed: 0, expired: 0, refunded: 0, partiallyRefunded: 0 };

    for (const payment of this.data.payments) {
      if (payment.status === "partially_refunded") statuses.partiallyRefunded += 1;
      else if (Object.hasOwn(statuses, payment.status)) statuses[payment.status] += 1;
    }

    for (const order of this.data.orders) {
      if (!paidStatuses.has(order.status) || !order.currency || !isCents(order.amountTotal)) continue;
      const currency = order.currency;
      const refunded = isCents(order.refundedAmount) ? order.refundedAmount : 0;
      const shipping = isCents(order.amountShipping) ? order.amountShipping : 0;
      const tax = isCents(order.amountTax) ? order.amountTax : 0;
      const productSales = isCents(order.amountSubtotal) ? order.amountSubtotal : Math.max(0, order.amountTotal - shipping - tax);
      const total = totals.get(currency) || { currency, grossSales: 0, productSales: 0, shippingRevenue: 0, taxCollected: 0, refunds: 0, netCollected: 0, paidOrders: 0, averageOrderValue: 0 };
      total.grossSales += order.amountTotal;
      total.productSales += productSales;
      total.shippingRevenue += shipping;
      total.taxCollected += tax;
      total.refunds += refunded;
      total.netCollected += Math.max(0, order.amountTotal - refunded);
      total.paidOrders += 1;
      totals.set(currency, total);

      const month = monthKey(order.createdAt);
      const monthlyKey = `${month}:${currency}`;
      const period = monthly.get(monthlyKey) || { month, currency, grossSales: 0, refunds: 0, netCollected: 0, paidOrders: 0 };
      period.grossSales += order.amountTotal;
      period.refunds += refunded;
      period.netCollected += Math.max(0, order.amountTotal - refunded);
      period.paidOrders += 1;
      monthly.set(monthlyKey, period);

      const productKey = `${order.formatSlug || order.sku || "unknown"}:${currency}`;
      const product = products.get(productKey) || {
        formatSlug: order.formatSlug || "",
        formatName: order.formatName || order.sku || "Unknown format",
        sku: order.sku || "",
        currency,
        orders: 0,
        quantity: 0,
        productSales: 0,
        refunds: 0,
        netCollected: 0
      };
      product.orders += 1;
      product.quantity += safeQuantity(order.quantity);
      product.productSales += productSales;
      product.refunds += refunded;
      product.netCollected += Math.max(0, order.amountTotal - refunded);
      products.set(productKey, product);
    }

    for (const total of totals.values()) {
      total.averageOrderValue = total.paidOrders ? Math.round(total.netCollected / total.paidOrders) : 0;
    }

    return {
      generatedAt: new Date().toISOString(),
      note: "Net collected is gross sales less refunds, before Stripe fees, fulfillment costs, and operating expenses.",
      totals: [...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency)),
      monthly: [...monthly.values()].sort((left, right) => right.month.localeCompare(left.month) || left.currency.localeCompare(right.currency)),
      productPerformance: [...products.values()].sort((left, right) => right.netCollected - left.netCollected),
      paymentStatus: statuses
    };
  }

  summary() {
    const formatInterest = this.data.waitlist.reduce((summary, entry) => {
      summary[entry.preferredFormat] = (summary[entry.preferredFormat] || 0) + 1;
      return summary;
    }, {});
    const paidRevenue = this.data.orders.reduce((summary, order) => {
      if (!paidStatuses.has(order.status) || !order.currency || !isCents(order.amountTotal)) return summary;
      const netAmount = Math.max(0, order.amountTotal - (order.refundedAmount || 0));
      summary[order.currency] = (summary[order.currency] || 0) + netAmount;
      return summary;
    }, {});
    const inventory = this.inventoryReport();
    return {
      waitlistTotal: this.data.waitlist.length,
      inquiryTotal: this.data.inquiries.length,
      orderTotal: this.data.orders.length,
      paymentTotal: this.data.payments.length,
      paidOrderTotal: this.data.orders.filter((order) => order.status === "paid").length,
      pendingOrderTotal: this.data.orders.filter((order) => order.status === "pending").length,
      trackedStockAvailable: inventory.filter((item) => item.tracking).reduce((total, item) => total + item.available, 0),
      trackedFormatTotal: inventory.filter((item) => item.tracking).length,
      lowStockTotal: inventory.filter((item) => ["low_stock", "sold_out"].includes(item.status)).length,
      paidRevenue,
      formatInterest
    };
  }

  list(collection, limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return Array.isArray(this.data[collection]) ? this.data[collection].slice(0, safeLimit) : [];
  }
}
