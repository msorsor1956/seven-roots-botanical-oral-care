import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { formats } from "./catalog.js";
import {
  STAFF_ROLES,
  StaffAccessError,
  canAccessStaffLocation,
  cleanStaffEmail,
  cleanStaffText,
  createOpaqueToken,
  hashOpaqueToken,
  hashStaffPassword,
  hasStaffPermission,
  publicStaffUser,
  staffLocations,
  validateStaffUserInput,
  verifyStaffPassword
} from "./staff.js";

const DATA_VERSION = 5;
const MAX_STORED_EVENTS = 2000;
const MAX_STORED_RESERVATIONS = 5000;
const MAX_ZOHO_QUEUE = 5000;
const MAX_STAFF_SESSIONS = 2000;
const MAX_AUDIT_EVENTS = 10000;
const MAX_STAFF_TASKS = 5000;
const MAX_STOCK_COUNTS = 5000;
const MAX_TRANSFERS = 2500;
const RESERVATION_MAX_AGE_MS = 31 * 60 * 60 * 1000;
const STAFF_INVITE_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const STAFF_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const STAFF_LOCK_MAX_AGE_MS = 15 * 60 * 1000;
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
  warehouseInventory: [],
  stockCounts: [],
  stockTransfers: [],
  staffUsers: [],
  staffInvitations: [],
  staffSessions: [],
  staffTasks: [],
  auditLog: [],
  zohoOrderQueue: [],
  zohoSync: {
    status: "not_configured",
    inventoryAuthority: false,
    lastAttemptAt: null,
    lastConnectedAt: null,
    lastSuccessAt: null,
    lastError: "",
    liberiaLocation: null,
    usLocation: null,
    onlineCustomer: null,
    mappings: []
  },
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
  constructor(message, details = {}, code = "insufficient_inventory") {
    super(message);
    this.code = code;
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
        warehouseInventory: Array.isArray(saved.warehouseInventory) ? saved.warehouseInventory : [],
        stockCounts: Array.isArray(saved.stockCounts) ? saved.stockCounts : [],
        stockTransfers: Array.isArray(saved.stockTransfers) ? saved.stockTransfers : [],
        staffUsers: Array.isArray(saved.staffUsers) ? saved.staffUsers : [],
        staffInvitations: Array.isArray(saved.staffInvitations) ? saved.staffInvitations : [],
        staffSessions: Array.isArray(saved.staffSessions) ? saved.staffSessions : [],
        staffTasks: Array.isArray(saved.staffTasks) ? saved.staffTasks : [],
        auditLog: Array.isArray(saved.auditLog) ? saved.auditLog : [],
        zohoOrderQueue: Array.isArray(saved.zohoOrderQueue) ? saved.zohoOrderQueue : [],
        zohoSync: saved.zohoSync && typeof saved.zohoSync === "object"
          ? { ...emptyData().zohoSync, ...saved.zohoSync }
          : emptyData().zohoSync,
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
          source: "local",
          zohoItemId: "",
          zohoLocations: null,
          lastSyncedAt: null,
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
        if (!item.source) item.source = "local";
        if (!Object.hasOwn(item, "zohoItemId")) item.zohoItemId = "";
        if (!Object.hasOwn(item, "zohoLocations")) item.zohoLocations = null;
        if (!Object.hasOwn(item, "lastSyncedAt")) item.lastSyncedAt = null;
      }
    }

    for (const location of ["liberia", "us"]) {
      for (const format of formats) {
        let warehouseItem = this.data.warehouseInventory.find((record) => (
          record.location === location && record.formatSlug === format.slug
        ));
        const commerceItem = this.data.inventory.find((record) => record.formatSlug === format.slug);
        if (!warehouseItem) {
          const zohoLocation = commerceItem?.zohoLocations?.[location] || null;
          warehouseItem = {
            id: randomUUID(),
            location,
            formatSlug: format.slug,
            formatName: format.name,
            sku: format.sku,
            stockOnHand: location === "us"
              ? (Number.isInteger(commerceItem?.stockOnHand) ? commerceItem.stockOnHand : null)
              : (Number.isInteger(zohoLocation?.onHand) ? zohoLocation.onHand : null),
            reorderLevel: Number.isInteger(commerceItem?.reorderLevel) ? commerceItem.reorderLevel : 5,
            source: commerceItem?.source || "local",
            zohoItemId: commerceItem?.zohoItemId || "",
            lastSyncedAt: commerceItem?.lastSyncedAt || null,
            updatedAt: commerceItem?.updatedAt || now
          };
          this.data.warehouseInventory.push(warehouseItem);
          needsPersist = true;
        } else {
          warehouseItem.formatName = format.name;
          warehouseItem.sku = format.sku;
          if (!Number.isInteger(warehouseItem.reorderLevel)) warehouseItem.reorderLevel = 5;
          if (!warehouseItem.source) warehouseItem.source = "local";
          if (!Object.hasOwn(warehouseItem, "zohoItemId")) warehouseItem.zohoItemId = "";
          if (!Object.hasOwn(warehouseItem, "lastSyncedAt")) warehouseItem.lastSyncedAt = null;
        }
      }
    }

    for (const order of this.data.orders) {
      if (paidStatuses.has(order.status) && !order.inventoryAppliedAt) {
        order.inventoryAppliedAt = order.createdAt || now;
        needsPersist = true;
      }
      if (!isCents(order.refundedAmount)) order.refundedAmount = 0;
      if (!order.fulfillmentStatus) order.fulfillmentStatus = paidStatuses.has(order.status) ? "unfulfilled" : "not_ready";
      if (!Object.hasOwn(order, "assignedTo")) order.assignedTo = "";
      if (!Object.hasOwn(order, "fulfillmentUpdatedAt")) order.fulfillmentUpdatedAt = null;
    }

    if (this.data.payments.length === 0 && this.data.orders.length > 0) {
      for (const order of this.data.orders) this.#upsertPaymentFromOrder(order, "data.migrated", {});
      needsPersist = true;
    }

    for (const order of this.data.orders) {
      if (paidStatuses.has(order.status) && !this.data.zohoOrderQueue.some((entry) => entry.orderId === order.id)) {
        this.#queueZohoOrder(order, order.createdAt || now);
        needsPersist = true;
      }
    }

    if (this.#pruneStaleReservations()) needsPersist = true;
    if (this.#pruneStaffSecurityRecords()) needsPersist = true;
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

  #warehouseRecord(location, formatSlug) {
    return this.data.warehouseInventory.find((item) => item.location === location && item.formatSlug === formatSlug) || null;
  }

  #employeeNumber(role) {
    const prefix = role.startsWith("liberia_") ? "LR" : role.startsWith("us_") || role === "customer_support" ? "US" : "HQ";
    const count = this.data.staffUsers.filter((user) => String(user.employeeNumber || "").startsWith(`SR-${prefix}-`)).length + 1;
    return `SR-${prefix}-${String(count).padStart(4, "0")}`;
  }

  #addAudit(actor, action, entityType, entityId, options = {}) {
    const record = {
      id: randomUUID(),
      actorId: actor?.id || "system",
      actorName: cleanStaffText(actor?.name || "System", 120),
      actorRole: actor?.role || "system",
      action: cleanStaffText(action, 80),
      entityType: cleanStaffText(entityType, 80),
      entityId: cleanStaffText(entityId, 120),
      location: cleanStaffText(options.location, 20),
      summary: cleanStaffText(options.summary, 280),
      metadata: options.metadata && typeof options.metadata === "object" ? options.metadata : {},
      createdAt: new Date().toISOString()
    };
    this.data.auditLog.unshift(record);
    this.data.auditLog = this.data.auditLog.slice(0, MAX_AUDIT_EVENTS);
    return record;
  }

  #pruneStaffSecurityRecords() {
    const now = Date.now();
    const invitationsBefore = this.data.staffInvitations.length;
    const sessionsBefore = this.data.staffSessions.length;
    this.data.staffInvitations = this.data.staffInvitations
      .filter((invitation) => invitation.usedAt || new Date(invitation.expiresAt).valueOf() > now)
      .slice(0, MAX_STAFF_SESSIONS);
    this.data.staffSessions = this.data.staffSessions
      .filter((session) => !session.revokedAt && new Date(session.expiresAt).valueOf() > now)
      .slice(0, MAX_STAFF_SESSIONS);
    return invitationsBefore !== this.data.staffInvitations.length || sessionsBefore !== this.data.staffSessions.length;
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

  #queueZohoOrder(order, now = new Date().toISOString()) {
    if (!order?.id || this.data.zohoOrderQueue.some((entry) => entry.orderId === order.id)) return null;
    const entry = {
      id: randomUUID(),
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: "pending",
      attempts: 0,
      lastError: "",
      createdAt: now,
      updatedAt: now
    };
    this.data.zohoOrderQueue.unshift(entry);
    this.data.zohoOrderQueue = this.data.zohoOrderQueue.slice(0, MAX_ZOHO_QUEUE);
    order.zohoSyncStatus = "pending";
    order.zohoQueuedAt = now;
    return entry;
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
    const warehouseInventory = this.#warehouseRecord("us", order.formatSlug);
    if (warehouseInventory && Number.isInteger(warehouseInventory.stockOnHand)) {
      warehouseInventory.stockOnHand = Math.max(0, warehouseInventory.stockOnHand - quantity);
      warehouseInventory.updatedAt = now;
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
          fulfillmentStatus: "not_ready",
          assignedTo: "",
          fulfillmentUpdatedAt: null,
          createdAt: stripeDate(object.created),
          ...update
        };
        this.data.orders.unshift(order);
      }
      if (paidStatuses.has(order.status) && (!order.fulfillmentStatus || order.fulfillmentStatus === "not_ready")) {
        order.fulfillmentStatus = "unfulfilled";
      }
      this.#completeInventoryForOrder(order, now);
      if (paidStatuses.has(order.status)) this.#queueZohoOrder(order, now);
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

  zohoSyncState() {
    const pendingOrders = this.data.zohoOrderQueue.filter((entry) => entry.status === "pending").length;
    const failedOrders = this.data.zohoOrderQueue.filter((entry) => entry.status === "failed").length;
    return { ...this.data.zohoSync, pendingOrders, failedOrders };
  }

  async recordZohoTest(inspection) {
    const now = inspection.checkedAt || new Date().toISOString();
    this.data.zohoSync = {
      ...this.data.zohoSync,
      status: inspection.ready ? "ready" : "mapping_required",
      lastAttemptAt: now,
      lastConnectedAt: now,
      lastError: inspection.ready ? "" : "Every storefront SKU must have sellable stock at the configured U.S. location.",
      liberiaLocation: inspection.liberiaLocation,
      usLocation: inspection.usLocation,
      onlineCustomer: inspection.onlineCustomer,
      mappings: inspection.mappings
    };
    await this.persist();
    return this.zohoSyncState();
  }

  async recordZohoFailure(error) {
    const now = new Date().toISOString();
    this.data.zohoSync = {
      ...this.data.zohoSync,
      status: this.data.zohoSync.lastSuccessAt ? "degraded" : "connection_error",
      lastAttemptAt: now,
      lastError: String(error?.message || "Zoho synchronization failed.").slice(0, 280)
    };
    await this.persist();
    return this.zohoSyncState();
  }

  async applyZohoSync(result) {
    const now = result.checkedAt || new Date().toISOString();
    for (const mapping of result.mappings) {
      const item = this.#inventoryRecord(mapping.formatSlug);
      if (!item) continue;
      item.zohoItemId = mapping.zohoItemId;
      item.zohoLocations = { liberia: mapping.liberia, us: mapping.us };
      item.lastSyncedAt = now;
      if (result.activate && mapping.ready) {
        const previousStockOnHand = Number.isInteger(item.stockOnHand) ? item.stockOnHand : null;
        item.stockOnHand = mapping.us.available;
        item.source = "zoho";
        item.updatedAt = now;
        if (previousStockOnHand !== item.stockOnHand) {
          this.data.inventoryAdjustments.unshift({
            id: randomUUID(),
            formatSlug: item.formatSlug,
            previousStockOnHand,
            stockOnHand: item.stockOnHand,
            delta: Number.isInteger(previousStockOnHand) ? item.stockOnHand - previousStockOnHand : null,
            reason: "Zoho Inventory sync · U.S. fulfillment location",
            source: "zoho",
            createdAt: now
          });
        }
      }
      for (const location of ["liberia", "us"]) {
        const warehouseItem = this.#warehouseRecord(location, mapping.formatSlug);
        const locationStock = mapping[location];
        if (!warehouseItem || !locationStock) continue;
        const synchronizedStock = Number.isInteger(locationStock.onHand) ? locationStock.onHand : locationStock.available;
        if (Number.isInteger(synchronizedStock)) warehouseItem.stockOnHand = synchronizedStock;
        warehouseItem.source = result.activate ? "zoho" : warehouseItem.source;
        warehouseItem.zohoItemId = mapping.zohoItemId;
        warehouseItem.lastSyncedAt = now;
        warehouseItem.updatedAt = now;
        for (const count of this.data.stockCounts) {
          if (
            count.status === "approved_pending_zoho" &&
            count.location === location &&
            count.formatSlug === mapping.formatSlug &&
            count.countedStock === synchronizedStock
          ) {
            count.status = "reconciled";
            count.appliedAt = now;
            count.updatedAt = now;
          }
        }
      }
    }
    this.data.inventoryAdjustments = this.data.inventoryAdjustments.slice(0, 2000);
    this.data.zohoSync = {
      ...this.data.zohoSync,
      status: result.activate ? "active" : result.ready ? "ready" : "mapping_required",
      inventoryAuthority: Boolean(result.activate),
      lastAttemptAt: now,
      lastConnectedAt: now,
      lastSuccessAt: now,
      lastError: result.ready ? "" : "Every storefront SKU must have sellable stock at the configured U.S. location.",
      liberiaLocation: result.liberiaLocation,
      usLocation: result.usLocation,
      onlineCustomer: result.onlineCustomer,
      mappings: result.mappings
    };
    await this.persist();
    return this.zohoSyncState();
  }

  pendingZohoOrders(limit = 25) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
    return this.data.zohoOrderQueue
      .filter((entry) => ["pending", "failed"].includes(entry.status))
      .slice(0, safeLimit)
      .map((entry) => {
        const order = this.data.orders.find((item) => item.id === entry.orderId) || null;
        const inventory = order ? this.#inventoryRecord(order.formatSlug) : null;
        return { entry: { ...entry }, order, mapping: inventory ? { zohoItemId: inventory.zohoItemId } : null };
      });
  }

  async markZohoOrderSynced(orderId, result) {
    const now = result.syncedAt || new Date().toISOString();
    const entry = this.data.zohoOrderQueue.find((item) => item.orderId === orderId);
    const order = this.data.orders.find((item) => item.id === orderId);
    if (!entry || !order) return null;
    entry.status = "synced";
    entry.attempts += 1;
    entry.lastError = "";
    entry.zohoSalesOrderId = result.salesOrderId;
    entry.updatedAt = now;
    entry.syncedAt = now;
    order.zohoSyncStatus = "synced";
    order.zohoSalesOrderId = result.salesOrderId;
    order.zohoSalesOrderNumber = result.salesOrderNumber;
    order.zohoSyncedAt = now;
    await this.persist();
    return entry;
  }

  async markZohoOrderFailed(orderId, error) {
    const now = new Date().toISOString();
    const entry = this.data.zohoOrderQueue.find((item) => item.orderId === orderId);
    const order = this.data.orders.find((item) => item.id === orderId);
    if (!entry) return null;
    entry.status = "failed";
    entry.attempts += 1;
    entry.lastError = String(error?.message || "Zoho order synchronization failed.").slice(0, 280);
    entry.updatedAt = now;
    if (order) order.zohoSyncStatus = "failed";
    await this.persist();
    return entry;
  }

  zohoOrderReport(limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return this.data.zohoOrderQueue.slice(0, safeLimit).map((entry) => ({ ...entry }));
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
        source: item.source || "local",
        zohoItemId: item.zohoItemId || "",
        zohoLocations: item.zohoLocations || null,
        lastSyncedAt: item.lastSyncedAt || null,
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
    if (item.source === "zoho" && this.data.zohoSync.inventoryAuthority && Object.hasOwn(update, "stockOnHand")) {
      throw new InventoryError(
        "Stock on hand is controlled by Zoho Inventory. Update the U.S. location in Zoho, then run a sync.",
        { formatSlug },
        "inventory_read_only"
      );
    }
    const now = new Date().toISOString();
    const previousStockOnHand = Number.isInteger(item.stockOnHand) ? item.stockOnHand : null;
    if (Object.hasOwn(update, "stockOnHand")) {
      item.stockOnHand = update.stockOnHand;
      item.source = "local";
      const warehouseItem = this.#warehouseRecord("us", formatSlug);
      if (warehouseItem) {
        warehouseItem.stockOnHand = update.stockOnHand;
        warehouseItem.source = "local";
        warehouseItem.updatedAt = now;
      }
    }
    if (Object.hasOwn(update, "reorderLevel")) {
      item.reorderLevel = update.reorderLevel;
      const warehouseItem = this.#warehouseRecord("us", formatSlug);
      if (warehouseItem) warehouseItem.reorderLevel = update.reorderLevel;
    }
    item.updatedAt = now;
    this.data.inventoryAdjustments.unshift({
      id: randomUUID(),
      formatSlug,
      previousStockOnHand,
      stockOnHand: Number.isInteger(item.stockOnHand) ? item.stockOnHand : null,
      delta: Number.isInteger(previousStockOnHand) && Number.isInteger(item.stockOnHand) ? item.stockOnHand - previousStockOnHand : null,
      reason: String(update.reason || "Manual inventory count").slice(0, 180),
      source: "local",
      createdAt: now
    });
    this.data.inventoryAdjustments = this.data.inventoryAdjustments.slice(0, 2000);
    await this.persist();
    return this.inventoryReport().find((record) => record.formatSlug === formatSlug);
  }

  listStaffUsers() {
    return this.data.staffUsers.map(publicStaffUser).sort((left, right) => left.name.localeCompare(right.name));
  }

  #createStaffInvitation(user, now = new Date()) {
    const token = createOpaqueToken();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.valueOf() + STAFF_INVITE_MAX_AGE_MS).toISOString();
    for (const invitation of this.data.staffInvitations) {
      if (invitation.userId === user.id && !invitation.usedAt) invitation.usedAt = createdAt;
    }
    this.data.staffInvitations.unshift({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashOpaqueToken(token),
      createdAt,
      expiresAt,
      usedAt: null
    });
    user.invitedAt = createdAt;
    user.updatedAt = createdAt;
    if (!user.passwordHash) user.status = "invited";
    return { token, expiresAt };
  }

  async createStaffUser(input, actor = { id: "admin", name: "Owner admin", role: "owner" }) {
    const value = validateStaffUserInput(input);
    if (this.data.staffUsers.some((user) => user.email === value.email)) {
      throw new StaffAccessError("An employee with this email already exists.", "staff_email_exists", 409);
    }
    if (value.managerId && !this.data.staffUsers.some((user) => user.id === value.managerId && user.status !== "inactive")) {
      throw new StaffAccessError("The selected manager is not active.", "staff_manager_not_found", 422);
    }
    const now = new Date();
    const createdAt = now.toISOString();
    const user = {
      id: randomUUID(),
      employeeNumber: this.#employeeNumber(value.role),
      name: value.name,
      email: value.email,
      role: value.role,
      country: value.country || (value.locations.includes("liberia") ? "Liberia" : "United States"),
      locations: value.locations,
      managerId: value.managerId,
      status: "invited",
      passwordHash: "",
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
      invitedAt: createdAt,
      acceptedAt: null,
      createdAt,
      updatedAt: createdAt
    };
    this.data.staffUsers.push(user);
    const invitation = this.#createStaffInvitation(user, now);
    this.#addAudit(actor, "staff.created", "staff_user", user.id, {
      location: value.locations.join(","),
      summary: `${user.name} was invited as ${STAFF_ROLES[user.role].label}.`,
      metadata: { role: user.role, locations: [...user.locations], employeeNumber: user.employeeNumber }
    });
    await this.persist();
    return { user: publicStaffUser(user), invitation };
  }

  async issueStaffInvitation(userId, actor = { id: "admin", name: "Owner admin", role: "owner" }) {
    const user = this.data.staffUsers.find((item) => item.id === userId);
    if (!user) throw new StaffAccessError("Employee not found.", "staff_not_found", 404);
    if (user.status === "inactive") throw new StaffAccessError("Reactivate this employee before creating an invitation.", "staff_inactive", 409);
    const invitation = this.#createStaffInvitation(user);
    this.#addAudit(actor, "staff.invitation_issued", "staff_user", user.id, {
      location: user.locations.join(","),
      summary: `A new invitation was issued for ${user.name}.`
    });
    await this.persist();
    return { user: publicStaffUser(user), invitation };
  }

  async updateStaffUser(userId, input, actor = { id: "admin", name: "Owner admin", role: "owner" }) {
    const user = this.data.staffUsers.find((item) => item.id === userId);
    if (!user) throw new StaffAccessError("Employee not found.", "staff_not_found", 404);
    const merged = {
      name: Object.hasOwn(input || {}, "name") ? input.name : user.name,
      email: Object.hasOwn(input || {}, "email") ? input.email : user.email,
      role: Object.hasOwn(input || {}, "role") ? input.role : user.role,
      country: Object.hasOwn(input || {}, "country") ? input.country : user.country,
      locations: Object.hasOwn(input || {}, "locations") ? input.locations : user.locations,
      managerId: Object.hasOwn(input || {}, "managerId") ? input.managerId : user.managerId,
      status: Object.hasOwn(input || {}, "status") ? input.status : user.status
    };
    const value = validateStaffUserInput(merged);
    if (this.data.staffUsers.some((item) => item.id !== user.id && item.email === value.email)) {
      throw new StaffAccessError("An employee with this email already exists.", "staff_email_exists", 409);
    }
    if (value.managerId === user.id) throw new StaffAccessError("An employee cannot manage their own account.", "invalid_manager", 422);
    if (value.managerId && !this.data.staffUsers.some((item) => item.id === value.managerId && item.status !== "inactive")) {
      throw new StaffAccessError("The selected manager is not active.", "staff_manager_not_found", 422);
    }
    if (user.role === "owner" && value.status === "inactive") {
      const otherOwner = this.data.staffUsers.some((item) => item.id !== user.id && item.role === "owner" && item.status === "active");
      if (!otherOwner) throw new StaffAccessError("At least one active owner account is required.", "owner_required", 409);
    }
    const previous = publicStaffUser(user);
    Object.assign(user, {
      name: value.name,
      email: value.email,
      role: value.role,
      country: value.country,
      locations: value.locations,
      managerId: value.managerId,
      status: value.status || user.status,
      updatedAt: new Date().toISOString()
    });
    if (user.status === "active" && !user.passwordHash) user.status = "invited";
    if (user.status === "inactive") {
      for (const session of this.data.staffSessions) {
        if (session.userId === user.id && !session.revokedAt) session.revokedAt = user.updatedAt;
      }
    }
    this.#addAudit(actor, "staff.updated", "staff_user", user.id, {
      location: user.locations.join(","),
      summary: `${user.name}'s staff access was updated.`,
      metadata: { previousRole: previous.role, role: user.role, status: user.status, locations: [...user.locations] }
    });
    await this.persist();
    return publicStaffUser(user);
  }

  #createStaffSession(user, now = new Date()) {
    const token = createOpaqueToken();
    const csrfToken = createOpaqueToken();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.valueOf() + STAFF_SESSION_MAX_AGE_MS).toISOString();
    const session = {
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashOpaqueToken(token),
      csrfToken,
      createdAt,
      lastSeenAt: createdAt,
      expiresAt,
      revokedAt: null
    };
    this.data.staffSessions.unshift(session);
    this.data.staffSessions = this.data.staffSessions.slice(0, MAX_STAFF_SESSIONS);
    return { token, csrfToken, expiresAt, user: publicStaffUser(user) };
  }

  async acceptStaffInvitation(token, password) {
    const now = new Date();
    const invitation = this.data.staffInvitations.find((item) => (
      !item.usedAt && item.tokenHash === hashOpaqueToken(token) && new Date(item.expiresAt).valueOf() > now.valueOf()
    ));
    if (!invitation) throw new StaffAccessError("This invitation is invalid or has expired.", "staff_invitation_invalid", 401);
    const user = this.data.staffUsers.find((item) => item.id === invitation.userId);
    if (!user || user.status === "inactive") throw new StaffAccessError("This employee account is not available.", "staff_inactive", 403);
    user.passwordHash = await hashStaffPassword(password);
    user.status = "active";
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    user.acceptedAt = now.toISOString();
    user.updatedAt = now.toISOString();
    invitation.usedAt = now.toISOString();
    for (const session of this.data.staffSessions) {
      if (session.userId === user.id && !session.revokedAt) session.revokedAt = now.toISOString();
    }
    const login = this.#createStaffSession(user, now);
    this.#addAudit(user, "staff.invitation_accepted", "staff_user", user.id, {
      location: user.locations.join(","),
      summary: `${user.name} activated their staff account.`
    });
    await this.persist();
    return login;
  }

  async authenticateStaff(email, password) {
    const normalizedEmail = cleanStaffEmail(email);
    const user = this.data.staffUsers.find((item) => item.email === normalizedEmail);
    const now = new Date();
    if (!user) {
      await hashStaffPassword("not-a-real-staff-password");
      throw new StaffAccessError("Email or password is incorrect.", "staff_invalid_credentials", 401);
    }
    if (user.status !== "active" || !user.passwordHash) {
      throw new StaffAccessError("Email or password is incorrect.", "staff_invalid_credentials", 401);
    }
    if (user.lockedUntil && new Date(user.lockedUntil).valueOf() > now.valueOf()) {
      throw new StaffAccessError("This account is temporarily locked. Try again later.", "staff_account_locked", 429);
    }
    const valid = await verifyStaffPassword(password, user.passwordHash);
    if (!valid) {
      user.failedLoginCount = (Number(user.failedLoginCount) || 0) + 1;
      if (user.failedLoginCount >= 5) user.lockedUntil = new Date(now.valueOf() + STAFF_LOCK_MAX_AGE_MS).toISOString();
      user.updatedAt = now.toISOString();
      await this.persist();
      throw new StaffAccessError("Email or password is incorrect.", "staff_invalid_credentials", 401);
    }
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    user.lastLoginAt = now.toISOString();
    user.updatedAt = now.toISOString();
    const login = this.#createStaffSession(user, now);
    this.#addAudit(user, "staff.login", "staff_session", login.user.id, {
      location: user.locations.join(","),
      summary: `${user.name} signed in.`
    });
    await this.persist();
    return login;
  }

  async staffSession(token) {
    if (!token) return null;
    this.#pruneStaffSecurityRecords();
    const session = this.data.staffSessions.find((item) => item.tokenHash === hashOpaqueToken(token) && !item.revokedAt);
    if (!session) return null;
    const user = this.data.staffUsers.find((item) => item.id === session.userId && item.status === "active");
    if (!user) return null;
    if (Date.now() - new Date(session.lastSeenAt).valueOf() > 15 * 60 * 1000) {
      session.lastSeenAt = new Date().toISOString();
      await this.persist();
    }
    return { session, user, publicUser: publicStaffUser(user) };
  }

  async endStaffSession(token) {
    const tokenHash = hashOpaqueToken(token);
    const session = this.data.staffSessions.find((item) => item.tokenHash === tokenHash && !item.revokedAt);
    if (!session) return false;
    const user = this.data.staffUsers.find((item) => item.id === session.userId);
    session.revokedAt = new Date().toISOString();
    if (user) this.#addAudit(user, "staff.logout", "staff_session", session.id, { summary: `${user.name} signed out.` });
    await this.persist();
    return true;
  }

  staffInventoryReport(actor) {
    if (!hasStaffPermission(actor, "inventory.view")) return [];
    return this.data.warehouseInventory
      .filter((item) => canAccessStaffLocation(actor, item.location))
      .map((item) => ({
        id: item.id,
        location: item.location,
        formatSlug: item.formatSlug,
        formatName: item.formatName,
        sku: item.sku,
        tracking: Number.isInteger(item.stockOnHand),
        stockOnHand: Number.isInteger(item.stockOnHand) ? item.stockOnHand : null,
        reorderLevel: item.reorderLevel,
        status: !Number.isInteger(item.stockOnHand)
          ? "not_tracked"
          : item.stockOnHand === 0
            ? "sold_out"
            : item.stockOnHand <= item.reorderLevel ? "low_stock" : "in_stock",
        source: item.source,
        lastSyncedAt: item.lastSyncedAt,
        updatedAt: item.updatedAt
      }))
      .sort((left, right) => left.location.localeCompare(right.location) || left.formatName.localeCompare(right.formatName));
  }

  staffStockCounts(actor, limit = 200) {
    if (!hasStaffPermission(actor, "inventory.view")) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    return this.data.stockCounts.filter((count) => canAccessStaffLocation(actor, count.location)).slice(0, safeLimit);
  }

  async createStockCount(actor, input) {
    if (!hasStaffPermission(actor, "inventory.count")) throw new StaffAccessError("You cannot submit inventory counts.");
    const location = cleanStaffText(input?.location, 20).toLowerCase();
    const formatSlug = cleanStaffText(input?.formatSlug, 80).toLowerCase();
    const counted = Number(input?.countedStock);
    if (!canAccessStaffLocation(actor, location)) throw new StaffAccessError("This location is outside your assignment.");
    if (!formats.some((format) => format.slug === formatSlug)) throw new StaffAccessError("Product format not found.", "format_not_found", 404);
    if (!Number.isInteger(counted) || counted < 0 || counted > 1_000_000) {
      throw new StaffAccessError("Counted stock must be a whole number from 0 to 1,000,000.", "invalid_stock_count", 422);
    }
    const item = this.#warehouseRecord(location, formatSlug);
    const now = new Date().toISOString();
    const count = {
      id: randomUUID(),
      countNumber: `SC-${now.slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`,
      location,
      formatSlug,
      formatName: item?.formatName || formatSlug,
      sku: item?.sku || "",
      expectedStock: Number.isInteger(item?.stockOnHand) ? item.stockOnHand : null,
      countedStock: counted,
      variance: Number.isInteger(item?.stockOnHand) ? counted - item.stockOnHand : null,
      reason: cleanStaffText(input?.reason || "Physical inventory count", 240),
      status: "submitted",
      submittedBy: actor.id,
      submittedByName: actor.name,
      reviewedBy: "",
      reviewedByName: "",
      createdAt: now,
      updatedAt: now,
      reviewedAt: null,
      appliedAt: null
    };
    this.data.stockCounts.unshift(count);
    this.data.stockCounts = this.data.stockCounts.slice(0, MAX_STOCK_COUNTS);
    this.#addAudit(actor, "inventory.count_submitted", "stock_count", count.id, {
      location,
      summary: `${count.countNumber} recorded ${counted} ${count.formatName} packs.`,
      metadata: { formatSlug, expectedStock: count.expectedStock, countedStock: counted, variance: count.variance }
    });
    await this.persist();
    return count;
  }

  async reviewStockCount(actor, countId, decision) {
    if (!hasStaffPermission(actor, "inventory.approve")) throw new StaffAccessError("You cannot approve inventory counts.");
    const count = this.data.stockCounts.find((item) => item.id === countId);
    if (!count) throw new StaffAccessError("Stock count not found.", "stock_count_not_found", 404);
    if (!canAccessStaffLocation(actor, count.location)) throw new StaffAccessError("This location is outside your assignment.");
    if (count.status !== "submitted") throw new StaffAccessError("This stock count has already been reviewed.", "stock_count_reviewed", 409);
    if (count.submittedBy === actor.id) throw new StaffAccessError("A second employee must review this count.", "second_approver_required", 409);
    const normalizedDecision = cleanStaffText(decision, 20).toLowerCase();
    if (!["approve", "reject"].includes(normalizedDecision)) throw new StaffAccessError("Choose approve or reject.", "invalid_decision", 422);
    const now = new Date().toISOString();
    count.reviewedBy = actor.id;
    count.reviewedByName = actor.name;
    count.reviewedAt = now;
    count.updatedAt = now;
    if (normalizedDecision === "reject") count.status = "rejected";
    else {
      const item = this.#warehouseRecord(count.location, count.formatSlug);
      const zohoControlled = item?.source === "zoho" && this.data.zohoSync.inventoryAuthority;
      count.status = zohoControlled ? "approved_pending_zoho" : "approved";
      if (item && !zohoControlled) {
        item.stockOnHand = count.countedStock;
        item.source = "local";
        item.updatedAt = now;
        count.appliedAt = now;
        if (count.location === "us") {
          const commerceItem = this.#inventoryRecord(count.formatSlug);
          if (commerceItem) {
            commerceItem.stockOnHand = count.countedStock;
            commerceItem.source = "local";
            commerceItem.updatedAt = now;
          }
        }
      }
    }
    this.#addAudit(actor, `inventory.count_${normalizedDecision}d`, "stock_count", count.id, {
      location: count.location,
      summary: `${count.countNumber} was ${normalizedDecision === "approve" ? "approved" : "rejected"}.`,
      metadata: { status: count.status, countedStock: count.countedStock }
    });
    await this.persist();
    return count;
  }

  #taskVisibleTo(actor, task) {
    if (!(task.location === "both" || canAccessStaffLocation(actor, task.location))) return false;
    if (task.type === "finance" && !hasStaffPermission(actor, "finance.view")) return false;
    if (["fulfillment", "returns", "support"].includes(task.type) && !hasStaffPermission(actor, "orders.view")) return false;
    if (["receiving", "quality", "packing", "stock_count"].includes(task.type) && !hasStaffPermission(actor, "inventory.view")) return false;
    if (task.type === "transfer" && !hasStaffPermission(actor, "transfers.view")) return false;
    return hasStaffPermission(actor, "tasks.manage") || !task.assignedTo || task.assignedTo === actor.id || task.createdBy === actor.id;
  }

  staffTasks(actor, limit = 250) {
    if (!hasStaffPermission(actor, "tasks.view")) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 250, 500));
    return this.data.staffTasks.filter((task) => this.#taskVisibleTo(actor, task)).slice(0, safeLimit);
  }

  async createStaffTask(actor, input) {
    if (!hasStaffPermission(actor, "tasks.manage")) throw new StaffAccessError("You cannot create staff tasks.");
    const location = cleanStaffText(input?.location, 20).toLowerCase();
    const type = cleanStaffText(input?.type || "general", 30).toLowerCase();
    const title = cleanStaffText(input?.title, 140);
    const priority = cleanStaffText(input?.priority || "normal", 20).toLowerCase();
    const allowedTypes = new Set(["receiving", "quality", "packing", "stock_count", "transfer", "fulfillment", "returns", "support", "finance", "general"]);
    if (location !== "both" && !canAccessStaffLocation(actor, location)) throw new StaffAccessError("This location is outside your assignment.");
    if (location === "both" && actor.role !== "owner") throw new StaffAccessError("Only an owner can create a cross-location task.");
    if (!allowedTypes.has(type)) throw new StaffAccessError("Choose a valid task type.", "invalid_task_type", 422);
    if (title.length < 3) throw new StaffAccessError("Enter a clear task title.", "invalid_task_title", 422);
    if (!["normal", "urgent"].includes(priority)) throw new StaffAccessError("Choose normal or urgent priority.", "invalid_priority", 422);
    const assignedTo = cleanStaffText(input?.assignedTo, 80);
    if (assignedTo) {
      const assignee = this.data.staffUsers.find((user) => user.id === assignedTo && user.status === "active");
      if (!assignee || (location !== "both" && !canAccessStaffLocation(assignee, location))) {
        throw new StaffAccessError("The assignee is not active at this location.", "invalid_assignee", 422);
      }
    }
    let dueAt = null;
    if (input?.dueAt) {
      const parsedDueAt = new Date(input.dueAt);
      if (Number.isNaN(parsedDueAt.getTime())) {
        throw new StaffAccessError("Enter a valid due date.", "invalid_due_date", 422);
      }
      dueAt = parsedDueAt.toISOString();
    }
    const now = new Date().toISOString();
    const task = {
      id: randomUUID(),
      title,
      description: cleanStaffText(input?.description, 1000),
      type,
      location,
      priority,
      status: "open",
      assignedTo,
      createdBy: actor.id,
      createdByName: actor.name,
      dueAt,
      note: "",
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
    this.data.staffTasks.unshift(task);
    this.data.staffTasks = this.data.staffTasks.slice(0, MAX_STAFF_TASKS);
    this.#addAudit(actor, "task.created", "staff_task", task.id, {
      location,
      summary: `Task created: ${task.title}.`,
      metadata: { type, assignedTo, priority }
    });
    await this.persist();
    return task;
  }

  async updateStaffTask(actor, taskId, input) {
    if (!hasStaffPermission(actor, "tasks.update")) throw new StaffAccessError("You cannot update staff tasks.");
    const task = this.data.staffTasks.find((item) => item.id === taskId);
    if (!task || !this.#taskVisibleTo(actor, task)) throw new StaffAccessError("Task not found.", "task_not_found", 404);
    const manager = hasStaffPermission(actor, "tasks.manage");
    const status = Object.hasOwn(input || {}, "status") ? cleanStaffText(input.status, 20).toLowerCase() : task.status;
    if (!["open", "in_progress", "blocked", "completed"].includes(status)) throw new StaffAccessError("Choose a valid task status.", "invalid_task_status", 422);
    if (!manager && task.assignedTo && task.assignedTo !== actor.id) throw new StaffAccessError("This task is assigned to another employee.");
    if (!manager && Object.hasOwn(input || {}, "assignedTo") && input.assignedTo !== actor.id) throw new StaffAccessError("You can only claim a task for yourself.");
    if (Object.hasOwn(input || {}, "assignedTo")) {
      const assignedTo = cleanStaffText(input.assignedTo, 80);
      if (assignedTo) {
        const assignee = this.data.staffUsers.find((user) => user.id === assignedTo && user.status === "active");
        if (!assignee || (task.location !== "both" && !canAccessStaffLocation(assignee, task.location))) {
          throw new StaffAccessError("The assignee is not active at this location.", "invalid_assignee", 422);
        }
      }
      task.assignedTo = assignedTo;
    } else if (!task.assignedTo && !manager) task.assignedTo = actor.id;
    if (manager && Object.hasOwn(input || {}, "priority")) {
      const priority = cleanStaffText(input.priority, 20).toLowerCase();
      if (!["normal", "urgent"].includes(priority)) throw new StaffAccessError("Choose normal or urgent priority.", "invalid_priority", 422);
      task.priority = priority;
    }
    task.status = status;
    task.note = Object.hasOwn(input || {}, "note") ? cleanStaffText(input.note, 800) : task.note;
    task.updatedAt = new Date().toISOString();
    task.completedAt = status === "completed" ? task.updatedAt : null;
    this.#addAudit(actor, "task.updated", "staff_task", task.id, {
      location: task.location,
      summary: `${task.title} moved to ${status.replaceAll("_", " ")}.`,
      metadata: { status, assignedTo: task.assignedTo }
    });
    await this.persist();
    return task;
  }

  staffTransfers(actor, limit = 200) {
    if (!hasStaffPermission(actor, "transfers.view")) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    return this.data.stockTransfers.filter((transfer) => (
      canAccessStaffLocation(actor, transfer.fromLocation) || canAccessStaffLocation(actor, transfer.toLocation)
    )).slice(0, safeLimit);
  }

  async createStockTransfer(actor, input) {
    if (!hasStaffPermission(actor, "transfers.create")) throw new StaffAccessError("You cannot create stock transfers.");
    const fromLocation = cleanStaffText(input?.fromLocation || "liberia", 20).toLowerCase();
    const toLocation = cleanStaffText(input?.toLocation || "us", 20).toLowerCase();
    if (fromLocation !== "liberia" || toLocation !== "us") {
      throw new StaffAccessError("Phase 1 transfers must move from Liberia to U.S. fulfillment.", "invalid_transfer_route", 422);
    }
    if (!canAccessStaffLocation(actor, fromLocation) && actor.role !== "owner") throw new StaffAccessError("This location is outside your assignment.");
    const rawItems = Array.isArray(input?.items) ? input.items : [];
    const items = [];
    for (const raw of rawItems) {
      const formatSlug = cleanStaffText(raw?.formatSlug, 80).toLowerCase();
      const quantity = Number(raw?.quantity);
      const format = formats.find((item) => item.slug === formatSlug);
      if (!format || !Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) continue;
      items.push({ formatSlug, formatName: format.name, sku: format.sku, quantity });
    }
    if (!items.length) throw new StaffAccessError("Add at least one product quantity to the transfer.", "invalid_transfer_items", 422);
    const now = new Date().toISOString();
    const transfer = {
      id: randomUUID(),
      transferNumber: `SR-TR-${now.slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 5).toUpperCase()}`,
      fromLocation,
      toLocation,
      items,
      status: "draft",
      carrier: "",
      trackingNumber: "",
      freightReference: cleanStaffText(input?.freightReference, 120),
      notes: cleanStaffText(input?.notes, 500),
      zohoTransferOrderId: "",
      zohoTransferOrderNumber: "",
      createdBy: actor.id,
      createdByName: actor.name,
      approvedBy: "",
      approvedByName: "",
      dispatchedBy: "",
      dispatchedByName: "",
      receivedBy: "",
      receivedByName: "",
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
      dispatchedAt: null,
      receivedAt: null
    };
    this.data.stockTransfers.unshift(transfer);
    this.data.stockTransfers = this.data.stockTransfers.slice(0, MAX_TRANSFERS);
    this.#addAudit(actor, "transfer.created", "stock_transfer", transfer.id, {
      location: fromLocation,
      summary: `${transfer.transferNumber} was prepared for U.S. fulfillment.`,
      metadata: { items: transfer.items.map((item) => ({ sku: item.sku, quantity: item.quantity })) }
    });
    await this.persist();
    return transfer;
  }

  transferForAction(actor, transferId, permission, expectedStatus) {
    if (!hasStaffPermission(actor, permission)) throw new StaffAccessError("You do not have permission for this transfer action.");
    const transfer = this.data.stockTransfers.find((item) => item.id === transferId);
    if (!transfer) throw new StaffAccessError("Transfer not found.", "transfer_not_found", 404);
    if (expectedStatus && transfer.status !== expectedStatus) throw new StaffAccessError(`This transfer must be ${expectedStatus.replaceAll("_", " ")} first.`, "invalid_transfer_status", 409);
    return transfer;
  }

  async approveStockTransfer(actor, transferId, zohoResult = null) {
    const transfer = this.transferForAction(actor, transferId, "transfers.approve", "draft");
    const now = new Date().toISOString();
    transfer.status = "approved";
    transfer.approvedBy = actor.id;
    transfer.approvedByName = actor.name;
    transfer.approvedAt = now;
    transfer.updatedAt = now;
    if (zohoResult) {
      transfer.zohoTransferOrderId = zohoResult.transferOrderId || "";
      transfer.zohoTransferOrderNumber = zohoResult.transferOrderNumber || transfer.transferNumber;
    }
    this.#addAudit(actor, "transfer.approved", "stock_transfer", transfer.id, {
      location: transfer.fromLocation,
      summary: `${transfer.transferNumber} was approved.`,
      metadata: { zohoTransferOrderId: transfer.zohoTransferOrderId }
    });
    await this.persist();
    return transfer;
  }

  async dispatchStockTransfer(actor, transferId, input = {}) {
    const transfer = this.transferForAction(actor, transferId, "transfers.dispatch", "approved");
    const carrier = cleanStaffText(input?.carrier || transfer.carrier, 120);
    const trackingNumber = cleanStaffText(input?.trackingNumber || transfer.trackingNumber, 160);
    const freightReference = cleanStaffText(input?.freightReference || transfer.freightReference, 160);
    if (!freightReference && (!carrier || !trackingNumber)) {
      throw new StaffAccessError(
        "Add a freight reference or both a carrier and tracking number before dispatch.",
        "missing_shipment_reference",
        422
      );
    }
    const zohoControlled = this.data.zohoSync.inventoryAuthority;
    if (!zohoControlled) {
      for (const transferItem of transfer.items) {
        const inventory = this.#warehouseRecord(transfer.fromLocation, transferItem.formatSlug);
        if (Number.isInteger(inventory?.stockOnHand) && inventory.stockOnHand < transferItem.quantity) {
          throw new InventoryError(`Not enough ${transferItem.formatName} stock in Liberia.`, {
            formatSlug: transferItem.formatSlug,
            available: inventory.stockOnHand
          });
        }
      }
    }
    const now = new Date().toISOString();
    if (!zohoControlled) {
      for (const transferItem of transfer.items) {
        const inventory = this.#warehouseRecord(transfer.fromLocation, transferItem.formatSlug);
        if (Number.isInteger(inventory?.stockOnHand)) {
          inventory.stockOnHand -= transferItem.quantity;
          inventory.updatedAt = now;
        }
      }
    }
    transfer.status = "in_transit";
    transfer.carrier = carrier;
    transfer.trackingNumber = trackingNumber;
    transfer.freightReference = freightReference;
    transfer.dispatchedBy = actor.id;
    transfer.dispatchedByName = actor.name;
    transfer.dispatchedAt = now;
    transfer.updatedAt = now;
    this.#addAudit(actor, "transfer.dispatched", "stock_transfer", transfer.id, {
      location: transfer.fromLocation,
      summary: `${transfer.transferNumber} is in transit to U.S. fulfillment.`,
      metadata: { carrier: transfer.carrier, trackingNumber: transfer.trackingNumber }
    });
    await this.persist();
    return transfer;
  }

  async receiveStockTransfer(actor, transferId) {
    const transfer = this.transferForAction(actor, transferId, "transfers.receive", "in_transit");
    const zohoControlled = this.data.zohoSync.inventoryAuthority;
    const now = new Date().toISOString();
    if (!zohoControlled) {
      for (const transferItem of transfer.items) {
        const inventory = this.#warehouseRecord(transfer.toLocation, transferItem.formatSlug);
        if (inventory) {
          inventory.stockOnHand = (Number.isInteger(inventory.stockOnHand) ? inventory.stockOnHand : 0) + transferItem.quantity;
          inventory.source = "local";
          inventory.updatedAt = now;
        }
        if (transfer.toLocation === "us") {
          const commerceItem = this.#inventoryRecord(transferItem.formatSlug);
          if (commerceItem) {
            commerceItem.stockOnHand = (Number.isInteger(commerceItem.stockOnHand) ? commerceItem.stockOnHand : 0) + transferItem.quantity;
            commerceItem.source = "local";
            commerceItem.updatedAt = now;
          }
        }
      }
    }
    transfer.status = "received";
    transfer.receivedBy = actor.id;
    transfer.receivedByName = actor.name;
    transfer.receivedAt = now;
    transfer.updatedAt = now;
    this.#addAudit(actor, "transfer.received", "stock_transfer", transfer.id, {
      location: transfer.toLocation,
      summary: `${transfer.transferNumber} was received at U.S. fulfillment.`
    });
    await this.persist();
    return transfer;
  }

  staffOrders(actor, limit = 200) {
    if (!hasStaffPermission(actor, "orders.view")) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    return this.data.orders.filter((order) => paidStatuses.has(order.status)).slice(0, safeLimit).map((order) => {
      const base = {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        fulfillmentStatus: order.fulfillmentStatus || "unfulfilled",
        assignedTo: order.assignedTo || "",
        formatSlug: order.formatSlug,
        formatName: order.formatName,
        sku: order.sku,
        quantity: order.quantity,
        customer: { name: order.customer?.name || "", email: order.customer?.email || "" },
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        fulfillmentUpdatedAt: order.fulfillmentUpdatedAt || null,
        carrier: order.carrier || "",
        trackingNumber: order.trackingNumber || ""
      };
      if (hasStaffPermission(actor, "orders.fulfill")) base.shipping = order.shipping || null;
      if (hasStaffPermission(actor, "finance.view")) {
        Object.assign(base, {
          amountSubtotal: order.amountSubtotal,
          amountShipping: order.amountShipping,
          amountTax: order.amountTax,
          amountTotal: order.amountTotal,
          refundedAmount: order.refundedAmount,
          currency: order.currency,
          stripePaymentIntentId: order.stripePaymentIntentId
        });
      }
      return base;
    });
  }

  async updateOrderFulfillment(actor, orderId, input) {
    if (!hasStaffPermission(actor, "orders.fulfill")) throw new StaffAccessError("You cannot update order fulfillment.");
    if (!canAccessStaffLocation(actor, "us")) throw new StaffAccessError("Order fulfillment is assigned to the U.S. location.");
    const order = this.data.orders.find((item) => item.id === orderId && paidStatuses.has(item.status));
    if (!order) throw new StaffAccessError("Paid order not found.", "order_not_found", 404);
    const nextStatus = cleanStaffText(input?.status, 30).toLowerCase();
    const currentStatus = order.fulfillmentStatus || "unfulfilled";
    const transitions = {
      unfulfilled: new Set(["picking"]),
      picking: new Set(["unfulfilled", "packed"]),
      packed: new Set(["picking", "shipped"]),
      shipped: new Set(["delivered", "returned"]),
      delivered: new Set(["returned"]),
      returned: new Set([])
    };
    if (!transitions[currentStatus]?.has(nextStatus)) {
      throw new StaffAccessError(`Order cannot move from ${currentStatus.replaceAll("_", " ")} to ${nextStatus.replaceAll("_", " ")}.`, "invalid_fulfillment_transition", 409);
    }
    if (nextStatus === "shipped") {
      const carrier = cleanStaffText(input?.carrier, 120);
      const trackingNumber = cleanStaffText(input?.trackingNumber, 160);
      if (!carrier || !trackingNumber) throw new StaffAccessError("Carrier and tracking number are required before shipment.", "tracking_required", 422);
      order.carrier = carrier;
      order.trackingNumber = trackingNumber;
      order.shippedAt = new Date().toISOString();
    }
    order.assignedTo = cleanStaffText(input?.assignedTo || order.assignedTo || actor.id, 80);
    order.fulfillmentStatus = nextStatus;
    order.fulfillmentUpdatedAt = new Date().toISOString();
    if (nextStatus === "delivered") order.deliveredAt = order.fulfillmentUpdatedAt;
    if (nextStatus === "returned") order.returnedAt = order.fulfillmentUpdatedAt;
    this.#addAudit(actor, "order.fulfillment_updated", "order", order.id, {
      location: "us",
      summary: `${order.orderNumber} moved to ${nextStatus.replaceAll("_", " ")}.`,
      metadata: { previousStatus: currentStatus, status: nextStatus, carrier: order.carrier || "", trackingNumber: order.trackingNumber || "" }
    });
    await this.persist();
    return this.staffOrders(actor, 500).find((item) => item.id === order.id);
  }

  staffAudit(actor, limit = 200) {
    if (!hasStaffPermission(actor, "audit.view")) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    const locations = staffLocations(actor);
    return this.data.auditLog.filter((record) => (
      !record.location || record.location === "both" || record.location.split(",").some((location) => locations.includes(location))
    )).slice(0, safeLimit);
  }

  staffWorkspace(actor) {
    const tasks = this.staffTasks(actor);
    const transfers = this.staffTransfers(actor);
    const inventory = this.staffInventoryReport(actor);
    const stockCounts = this.staffStockCounts(actor);
    const orders = this.staffOrders(actor);
    return {
      user: publicStaffUser(actor),
      summary: {
        openTasks: tasks.filter((task) => task.status !== "completed").length,
        urgentTasks: tasks.filter((task) => task.priority === "urgent" && task.status !== "completed").length,
        activeTransfers: transfers.filter((transfer) => !["received", "cancelled"].includes(transfer.status)).length,
        pendingCounts: stockCounts.filter((count) => ["submitted", "approved_pending_zoho"].includes(count.status)).length,
        ordersToFulfill: orders.filter((order) => !["delivered", "returned"].includes(order.fulfillmentStatus)).length,
        lowStock: inventory.filter((item) => ["low_stock", "sold_out"].includes(item.status)).length
      },
      tasks,
      transfers,
      inventory,
      stockCounts,
      orders,
      finance: hasStaffPermission(actor, "finance.view") ? this.financialReport() : null,
      audit: hasStaffPermission(actor, "audit.view") ? this.staffAudit(actor) : []
    };
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
