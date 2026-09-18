const normalizeBaseUrl = (value) => {
  try {
    const url = new URL(value || "");
    return ["https:", "http:"].includes(url.protocol) ? url.origin : "";
  } catch { return ""; }
};

export class PayPalConfigurationError extends Error {
  constructor(message = "PayPal checkout is not available yet.") {
    super(message);
    this.code = "paypal_not_configured";
  }
}

export class PayPalPayments {
  constructor(options = {}) {
    const environment = options.environment || process.env;
    this.clientId = options.clientId ?? environment.PAYPAL_CLIENT_ID ?? "";
    this.clientSecret = options.clientSecret ?? environment.PAYPAL_CLIENT_SECRET ?? "";
    this.environment = String(options.mode ?? environment.PAYPAL_ENVIRONMENT ?? "sandbox").toLowerCase();
    this.publicBaseUrl = normalizeBaseUrl(options.publicBaseUrl ?? environment.PUBLIC_BASE_URL ?? "");
    this.shippingCents = Math.max(0, Number.parseInt(options.shippingCents ?? environment.PAYPAL_SHIPPING_CENTS ?? "0", 10) || 0);
    this.fetch = options.fetch || globalThis.fetch;
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret && this.publicBaseUrl && ["sandbox", "live"].includes(this.environment));
  }

  get apiBase() {
    return this.environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  }

  async #accessToken() {
    if (!this.configured) throw new PayPalConfigurationError();
    const authorization = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await this.fetch(`${this.apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${authorization}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials"
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) throw new Error("PayPal authentication failed.");
    return payload.access_token;
  }

  async #request(path, { method = "GET", body, requestId } = {}) {
    const token = await this.#accessToken();
    const response = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(requestId ? { "PayPal-Request-Id": requestId } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || "PayPal could not complete the request.");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async createOrder({ format, quantity, unitAmount, currency, requestId }) {
    if (!Number.isInteger(unitAmount) || unitAmount < 0 || !currency) throw new PayPalConfigurationError("This product price is unavailable for PayPal.");
    const itemTotal = unitAmount * quantity;
    const total = itemTotal + this.shippingCents;
    const money = (cents) => (cents / 100).toFixed(2);
    const order = await this.#request("/v2/checkout/orders", {
      method: "POST",
      requestId: `seven-roots-${requestId}`.slice(0, 108),
      body: {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: requestId,
          custom_id: `${format.slug}|${quantity}`,
          description: `${format.name} · ${format.sku}`,
          amount: {
            currency_code: currency.toUpperCase(),
            value: money(total),
            breakdown: {
              item_total: { currency_code: currency.toUpperCase(), value: money(itemTotal) },
              shipping: { currency_code: currency.toUpperCase(), value: money(this.shippingCents) }
            }
          },
          items: [{
            name: format.name,
            sku: format.sku,
            quantity: String(quantity),
            category: "PHYSICAL_GOODS",
            unit_amount: { currency_code: currency.toUpperCase(), value: money(unitAmount) }
          }]
        }],
        payment_source: { paypal: { experience_context: {
          brand_name: "SEVEN ROOTS",
          user_action: "PAY_NOW",
          shipping_preference: "GET_FROM_FILE",
          return_url: `${this.publicBaseUrl}/order-success?paypal=return`,
          cancel_url: `${this.publicBaseUrl}/?checkout=cancelled#formats`
        } } }
      }
    });
    const approvalUrl = order.links?.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href;
    if (!order.id || !approvalUrl) throw new Error("PayPal did not return an approval URL.");
    return { id: order.id, url: approvalUrl };
  }

  async captureOrder(orderId, requestId) {
    if (!/^[A-Z0-9]{8,32}$/iu.test(orderId)) throw new Error("Invalid PayPal order reference.");
    const capture = await this.#request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST",
      requestId: `seven-roots-capture-${requestId}`.slice(0, 108)
    });
    capture.livemode = this.environment === "live";
    return capture;
  }
}

export const createPayPalPayments = (options) => new PayPalPayments(options);
