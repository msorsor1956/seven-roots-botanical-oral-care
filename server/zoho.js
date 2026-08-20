const ACCOUNTS_HOSTS = new Set([
  "accounts.zoho.com",
  "accounts.zoho.eu",
  "accounts.zoho.in",
  "accounts.zoho.com.au",
  "accounts.zoho.jp",
  "accounts.zohocloud.ca",
  "accounts.zoho.sa"
]);

const API_HOSTS = new Set([
  "www.zohoapis.com",
  "www.zohoapis.eu",
  "www.zohoapis.in",
  "www.zohoapis.com.au",
  "www.zohoapis.jp",
  "www.zohoapis.ca",
  "www.zohoapis.sa"
]);

const requiredSettings = [
  ["organizationId", "ZOHO_INVENTORY_ORGANIZATION_ID"],
  ["clientId", "ZOHO_CLIENT_ID"],
  ["clientSecret", "ZOHO_CLIENT_SECRET"],
  ["refreshToken", "ZOHO_REFRESH_TOKEN"],
  ["liberiaLocationId", "ZOHO_LIBERIA_LOCATION_ID"],
  ["usLocationId", "ZOHO_US_LOCATION_ID"],
  ["onlineCustomerId", "ZOHO_ONLINE_CUSTOMER_ID"]
];

const safeMessage = (value, fallback) => {
  const text = typeof value === "string" ? value.replace(/[\r\n]+/gu, " ").trim() : "";
  return (text || fallback).slice(0, 280);
};

const normalizeQuantity = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const quantity = Number(value);
  return Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : null;
};

const safeBaseUrl = (value, fallback, allowedHosts, label) => {
  let url;
  try {
    url = new URL(String(value || fallback));
  } catch {
    throw new ZohoConfigurationError(`${label} is not a valid URL.`);
  }
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new ZohoConfigurationError(`${label} must use an approved Zoho HTTPS domain.`);
  }
  return url.toString().replace(/\/$/u, "");
};

const locationStock = (item, locationId) => {
  const locations = Array.isArray(item?.locations) ? item.locations : [];
  const location = locations.find((record) => String(record.location_id || "") === String(locationId || ""));
  if (!location) return { locationId: String(locationId || ""), locationName: "", onHand: null, available: null };
  const onHand = normalizeQuantity(location.location_stock_on_hand ?? location.stock_on_hand);
  const available = normalizeQuantity(
    location.location_available_stock ??
    location.location_actual_available_stock ??
    location.available_stock ??
    location.stock_on_hand
  );
  return {
    locationId: String(location.location_id || locationId || ""),
    locationName: String(location.location_name || ""),
    onHand,
    available
  };
};

const compactZohoLocation = (location) => ({
  id: String(location?.location_id || ""),
  name: String(location?.location_name || ""),
  country: String(location?.address?.country || ""),
  status: String(location?.status || "active")
});

const compactShippingAddress = (address) => address ? {
  attention: "SEVEN ROOTS customer",
  address: [address.line1, address.line2].filter(Boolean).join(", ").slice(0, 500),
  city: String(address.city || "").slice(0, 100),
  state: String(address.state || "").slice(0, 100),
  zip: String(address.postalCode || "").slice(0, 30),
  country: String(address.country || "US").slice(0, 100)
} : undefined;

export class ZohoConfigurationError extends Error {
  constructor(message, missing = []) {
    super(message);
    this.code = "zoho_not_configured";
    this.missing = missing;
  }
}

export class ZohoApiError extends Error {
  constructor(message, status = 502, zohoCode = null) {
    super(message);
    this.code = "zoho_api_error";
    this.status = status;
    this.zohoCode = zohoCode;
  }
}

export class ZohoInventory {
  constructor(options = {}) {
    const environment = options.environment || process.env;
    this.organizationId = String(options.organizationId ?? environment.ZOHO_INVENTORY_ORGANIZATION_ID ?? "").trim();
    this.clientId = String(options.clientId ?? environment.ZOHO_CLIENT_ID ?? "").trim();
    this.clientSecret = String(options.clientSecret ?? environment.ZOHO_CLIENT_SECRET ?? "").trim();
    this.refreshToken = String(options.refreshToken ?? environment.ZOHO_REFRESH_TOKEN ?? "").trim();
    this.liberiaLocationId = String(options.liberiaLocationId ?? environment.ZOHO_LIBERIA_LOCATION_ID ?? "").trim();
    this.usLocationId = String(options.usLocationId ?? environment.ZOHO_US_LOCATION_ID ?? "").trim();
    this.onlineCustomerId = String(options.onlineCustomerId ?? environment.ZOHO_ONLINE_CUSTOMER_ID ?? "").trim();
    this.enabled = String(options.enabled ?? environment.ZOHO_INVENTORY_ENABLED ?? "false").toLowerCase() === "true";
    this.accountsBaseUrl = safeBaseUrl(
      options.accountsBaseUrl ?? environment.ZOHO_ACCOUNTS_URL,
      "https://accounts.zoho.com",
      ACCOUNTS_HOSTS,
      "ZOHO_ACCOUNTS_URL"
    );
    this.apiBaseUrl = safeBaseUrl(
      options.apiBaseUrl ?? environment.ZOHO_API_URL,
      "https://www.zohoapis.com/inventory/v1",
      API_HOSTS,
      "ZOHO_API_URL"
    );
    this.fetch = options.fetch || globalThis.fetch;
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.accessTokenPromise = null;
  }

  get missingSettings() {
    return requiredSettings.filter(([property]) => !this[property]).map(([, environmentName]) => environmentName);
  }

  get configured() {
    return this.missingSettings.length === 0;
  }

  get active() {
    return this.configured && this.enabled;
  }

  status(syncState = {}) {
    return {
      provider: "zoho_inventory",
      configured: this.configured,
      enabled: this.enabled,
      connected: Boolean(syncState.lastConnectedAt || syncState.lastSuccessAt),
      inventoryAuthority: Boolean(this.active && syncState.inventoryAuthority),
      missingSettings: this.missingSettings,
      organizationId: this.organizationId ? `…${this.organizationId.slice(-6)}` : "",
      dataCenter: new URL(this.apiBaseUrl).hostname,
      locations: {
        liberia: syncState.liberiaLocation || null,
        us: syncState.usLocation || null
      },
      onlineCustomer: syncState.onlineCustomer || null,
      mappings: Array.isArray(syncState.mappings) ? syncState.mappings : [],
      pendingOrders: Number(syncState.pendingOrders) || 0,
      failedOrders: Number(syncState.failedOrders) || 0,
      lastAttemptAt: syncState.lastAttemptAt || null,
      lastSuccessAt: syncState.lastSuccessAt || null,
      lastError: syncState.lastError || "",
      activationNote: this.enabled
        ? "Zoho stock becomes authoritative only after every SKU and the U.S. location pass synchronization."
        : "Connection mode is safe-readiness. Set ZOHO_INVENTORY_ENABLED=true only after a successful verification sync."
    };
  }

  #assertConfigured() {
    if (this.configured) return;
    throw new ZohoConfigurationError("Zoho Inventory is waiting for its Railway connection settings.", this.missingSettings);
  }

  async #refreshAccessToken() {
    this.#assertConfigured();
    const body = new URLSearchParams({
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "refresh_token"
    });
    let response;
    try {
      response = await this.fetch(`${this.accountsBaseUrl}/oauth/v2/token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(12_000)
      });
    } catch {
      throw new ZohoApiError("Zoho authorization could not be reached. Check the selected data center.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      throw new ZohoApiError("Zoho rejected the OAuth connection settings.", response.status || 502, payload.code || null);
    }
    this.accessToken = payload.access_token;
    const expiresIn = Math.max(60, Number(payload.expires_in_sec ?? payload.expires_in ?? 3600) || 3600);
    this.accessTokenExpiresAt = Date.now() + (expiresIn - 30) * 1000;
    return this.accessToken;
  }

  async #token(force = false) {
    if (!force && this.accessToken && this.accessTokenExpiresAt > Date.now()) return this.accessToken;
    if (force) {
      this.accessToken = "";
      this.accessTokenExpiresAt = 0;
    }
    if (!this.accessTokenPromise) {
      this.accessTokenPromise = this.#refreshAccessToken().finally(() => { this.accessTokenPromise = null; });
    }
    return this.accessTokenPromise;
  }

  async #request(pathname, { method = "GET", query = {}, body, retry = true } = {}) {
    this.#assertConfigured();
    const url = new URL(`${this.apiBaseUrl}/${String(pathname).replace(/^\/+|\/+$/gu, "")}`);
    url.searchParams.set("organization_id", this.organizationId);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Zoho-oauthtoken ${await this.#token()}`,
          ...(body ? { "content-type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(12_000)
      });
    } catch {
      throw new ZohoApiError("Zoho Inventory could not be reached. Try again shortly.");
    }
    if (response.status === 401 && retry) {
      await this.#token(true);
      return this.#request(pathname, { method, query, body, retry: false });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || (Number.isFinite(Number(payload.code)) && Number(payload.code) !== 0)) {
      throw new ZohoApiError(
        safeMessage(payload.message, `Zoho Inventory returned HTTP ${response.status || 502}.`),
        response.status || 502,
        payload.code ?? null
      );
    }
    return payload;
  }

  async listLocations() {
    const payload = await this.#request("locations", { query: { is_hierarchical_response: false } });
    return (Array.isArray(payload.locations) ? payload.locations : []).map(compactZohoLocation);
  }

  async listItems() {
    const items = [];
    for (let page = 1; page <= 10; page += 1) {
      const payload = await this.#request("items", { query: { page, per_page: 200, status: "active" } });
      const pageItems = Array.isArray(payload.items) ? payload.items : [];
      items.push(...pageItems);
      const hasMore = payload.page_context?.has_more_page ?? pageItems.length === 200;
      if (!hasMore) break;
    }
    return items;
  }

  async getOnlineCustomer() {
    const payload = await this.#request(`contacts/${encodeURIComponent(this.onlineCustomerId)}`);
    const contact = payload.contact || {};
    return {
      id: String(contact.contact_id || this.onlineCustomerId),
      name: String(contact.contact_name || contact.company_name || "SEVEN ROOTS Online Store"),
      status: String(contact.status || "active")
    };
  }

  async inspectCatalog(catalog) {
    const [locations, items, onlineCustomer] = await Promise.all([this.listLocations(), this.listItems(), this.getOnlineCustomer()]);
    const locationById = new Map(locations.map((location) => [location.id, location]));
    const itemBySku = new Map(items.map((item) => [String(item.sku || "").trim().toUpperCase(), item]));
    const mappings = catalog.map((format) => {
      const item = itemBySku.get(format.sku.toUpperCase());
      const liberia = locationStock(item, this.liberiaLocationId);
      const us = locationStock(item, this.usLocationId);
      return {
        formatSlug: format.slug,
        formatName: format.name,
        sku: format.sku,
        matched: Boolean(item?.item_id),
        zohoItemId: item?.item_id ? String(item.item_id) : "",
        zohoItemName: String(item?.name || ""),
        liberia,
        us,
        ready: Boolean(item?.item_id && Number.isInteger(us.available))
      };
    });
    const liberiaLocation = locationById.get(this.liberiaLocationId) || null;
    const usLocation = locationById.get(this.usLocationId) || null;
    return {
      checkedAt: new Date().toISOString(),
      locations,
      liberiaLocation,
      usLocation,
      onlineCustomer,
      locationsReady: Boolean(liberiaLocation && usLocation),
      mappings,
      mappedCount: mappings.filter((mapping) => mapping.matched).length,
      readyCount: mappings.filter((mapping) => mapping.ready).length,
      ready: Boolean(liberiaLocation && usLocation && onlineCustomer.id && mappings.length && mappings.every((mapping) => mapping.ready))
    };
  }

  async testConnection(catalog) {
    return this.inspectCatalog(catalog);
  }

  async syncCatalog(catalog) {
    const inspection = await this.inspectCatalog(catalog);
    return { ...inspection, activate: Boolean(this.enabled && inspection.ready) };
  }

  async #findTransferOrder(transferNumber) {
    for (let page = 1; page <= 10; page += 1) {
      const payload = await this.#request("transferorders", { query: { page, per_page: 200, search_text: transferNumber } });
      const transfers = Array.isArray(payload.transfer_orders)
        ? payload.transfer_orders
        : Array.isArray(payload.transferorders) ? payload.transferorders : [];
      const existing = transfers.find((transfer) => transfer.transfer_order_number === transferNumber);
      if (existing) return existing;
      const hasMore = payload.page_context?.has_more_page ?? transfers.length === 200;
      if (!hasMore) break;
    }
    return null;
  }

  async createTransferOrder(transfer, mappings) {
    this.#assertConfigured();
    if (!this.enabled) throw new ZohoConfigurationError("Zoho transfer write-back is disabled until verification is complete.");
    const mappingBySlug = new Map((Array.isArray(mappings) ? mappings : []).map((mapping) => [mapping.formatSlug, mapping]));
    const lineItems = transfer.items.map((item) => {
      const mapping = mappingBySlug.get(item.formatSlug);
      if (!mapping?.zohoItemId) throw new ZohoConfigurationError(`No Zoho item is mapped for ${item.sku || item.formatSlug}.`);
      return {
        item_id: mapping.zohoItemId,
        name: mapping.zohoItemName || item.formatName,
        description: `SEVEN ROOTS ${item.sku}`,
        quantity_transfer: item.quantity,
        unit: "qty"
      };
    });
    let transferOrder = await this.#findTransferOrder(transfer.transferNumber);
    if (!transferOrder) {
      const payload = await this.#request("transferorders", {
        method: "POST",
        query: { ignore_auto_number_generation: true },
        body: {
          transfer_order_number: transfer.transferNumber,
          date: String(transfer.createdAt || new Date().toISOString()).slice(0, 10),
          description: String(transfer.notes || "Liberia to U.S. fulfillment transfer").slice(0, 500),
          from_location_id: this.liberiaLocationId,
          to_location_id: this.usLocationId,
          line_items: lineItems
        }
      });
      transferOrder = payload.transfer_order || null;
    }
    const transferOrderId = String(transferOrder?.transfer_order_id || "");
    if (!transferOrderId) throw new ZohoApiError("Zoho created no identifiable transfer order.");
    return {
      transferOrderId,
      transferOrderNumber: String(transferOrder.transfer_order_number || transfer.transferNumber),
      status: String(transferOrder.status || "draft"),
      syncedAt: new Date().toISOString()
    };
  }

  async markTransferInTransit(transferOrderId) {
    this.#assertConfigured();
    if (!this.enabled) throw new ZohoConfigurationError("Zoho transfer write-back is disabled until verification is complete.");
    if (!transferOrderId) throw new ZohoConfigurationError("This transfer has no Zoho transfer order ID.");
    await this.#request(`transferorders/${encodeURIComponent(transferOrderId)}/intransit`, { method: "POST" });
    return { transferOrderId, status: "in_transit", syncedAt: new Date().toISOString() };
  }

  async markTransferReceived(transferOrderId) {
    this.#assertConfigured();
    if (!this.enabled) throw new ZohoConfigurationError("Zoho transfer write-back is disabled until verification is complete.");
    if (!transferOrderId) throw new ZohoConfigurationError("This transfer has no Zoho transfer order ID.");
    await this.#request(`transferorders/${encodeURIComponent(transferOrderId)}/markastransferred`, { method: "POST" });
    return { transferOrderId, status: "transferred", syncedAt: new Date().toISOString() };
  }

  async #findSalesOrder(referenceNumber) {
    for (let page = 1; page <= 10; page += 1) {
      const payload = await this.#request("salesorders", { query: { page, per_page: 200 } });
      const orders = Array.isArray(payload.salesorders) ? payload.salesorders : [];
      const existing = orders.find((order) => order.reference_number === referenceNumber || order.salesorder_number === referenceNumber);
      if (existing) return existing;
      const hasMore = payload.page_context?.has_more_page ?? orders.length === 200;
      if (!hasMore) break;
    }
    return null;
  }

  async createPaidSalesOrder(order, mapping) {
    this.#assertConfigured();
    if (!this.enabled) throw new ZohoConfigurationError("Zoho write-back is disabled until verification is complete.");
    if (!mapping?.zohoItemId) throw new ZohoConfigurationError(`No Zoho item is mapped for ${order.sku || order.formatSlug}.`);
    const existing = await this.#findSalesOrder(order.orderNumber);
    let salesOrder = existing;
    if (!salesOrder) {
      const quantity = Math.max(1, Number(order.quantity) || 1);
      const productTotal = Number.isInteger(order.amountSubtotal) ? order.amountSubtotal : 0;
      const payload = await this.#request("salesorders", {
        method: "POST",
        query: { ignore_auto_number_generation: true },
        body: {
          customer_id: this.onlineCustomerId,
          salesorder_number: order.orderNumber,
          date: String(order.createdAt || new Date().toISOString()).slice(0, 10),
          reference_number: order.orderNumber,
          location_id: this.usLocationId,
          line_items: [{
            item_id: mapping.zohoItemId,
            quantity,
            ...(productTotal ? { rate: Number((productTotal / quantity / 100).toFixed(2)) } : {})
          }],
          shipping_charge: Number(((order.amountShipping || 0) / 100).toFixed(2)),
          notes: `Paid through Stripe. Payment reference: ${String(order.stripePaymentIntentId || order.stripeSessionId || "").slice(0, 120)}`,
          ...(order.shipping?.address ? { shipping_address: compactShippingAddress(order.shipping.address) } : {})
        }
      });
      salesOrder = payload.salesorder || null;
    }
    const salesOrderId = String(salesOrder?.salesorder_id || "");
    if (!salesOrderId) throw new ZohoApiError("Zoho created no identifiable sales order.");
    if (String(salesOrder.status || "").toLowerCase() !== "confirmed") {
      await this.#request(`salesorders/${encodeURIComponent(salesOrderId)}/status/confirmed`, { method: "POST" });
    }
    return {
      salesOrderId,
      salesOrderNumber: String(salesOrder.salesorder_number || order.orderNumber),
      syncedAt: new Date().toISOString()
    };
  }
}

export const createZohoInventory = (options) => new ZohoInventory(options);

export const normalizeZohoLocationStock = locationStock;
