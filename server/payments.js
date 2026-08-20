import { randomBytes } from "node:crypto";

const STRIPE_API_VERSION = "2026-06-24.dahlia";
const PRICE_CACHE_MS = 5 * 60 * 1000;

const envPriceIds = (environment) => ({
  "travel-sleeve": environment.STRIPE_PRICE_TRAVEL_SLEEVE || "",
  "daily-ritual": environment.STRIPE_PRICE_DAILY_RITUAL || "",
  "family-reserve": environment.STRIPE_PRICE_FAMILY_RESERVE || ""
});

const normalizeBaseUrl = (value) => {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!(["https:", "http:"].includes(url.protocol))) return "";
    return url.origin;
  } catch {
    return "";
  }
};

const randomLetters = () => [...randomBytes(8)].map((byte) => String.fromCharCode(97 + (byte % 26))).join("");

export class PaymentConfigurationError extends Error {
  constructor(message = "Secure checkout is not available yet.") {
    super(message);
    this.code = "checkout_not_configured";
  }
}

export class StripePayments {
  constructor(options = {}) {
    const environment = options.environment || process.env;
    this.apiKey = options.apiKey ?? environment.STRIPE_API_KEY ?? "";
    this.webhookSecret = options.webhookSecret ?? environment.STRIPE_WEBHOOK_SECRET ?? "";
    this.publicBaseUrl = normalizeBaseUrl(options.publicBaseUrl ?? environment.PUBLIC_BASE_URL ?? "");
    this.priceIds = options.priceIds || envPriceIds(environment);
    this.shippingCountries = String(options.shippingCountries ?? environment.STRIPE_SHIPPING_COUNTRIES ?? "")
      .split(",").map((country) => country.trim().toUpperCase()).filter((country) => /^[A-Z]{2}$/u.test(country));
    this.shippingRateIds = String(options.shippingRateIds ?? environment.STRIPE_SHIPPING_RATE_IDS ?? "")
      .split(",").map((rate) => rate.trim()).filter(Boolean);
    this.integrationIdentifier = options.integrationIdentifier || `seven_roots_${randomLetters()}`;
    this.client = options.client || null;
    this.priceCache = new Map();
  }

  get configured() {
    return Boolean(
      (this.client || this.apiKey) &&
      this.webhookSecret &&
      this.publicBaseUrl &&
      this.shippingCountries.length &&
      Object.values(this.priceIds).every(Boolean)
    );
  }

  async stripe() {
    if (this.client) return this.client;
    if (!this.apiKey) throw new PaymentConfigurationError();
    const { default: Stripe } = await import("stripe");
    this.client = new Stripe(this.apiKey, {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 2,
      timeout: 20_000
    });
    return this.client;
  }

  async retrievePrice(slug) {
    const priceId = this.priceIds[slug];
    if (!priceId) throw new PaymentConfigurationError();
    const cached = this.priceCache.get(priceId);
    if (cached && cached.expiresAt > Date.now()) return cached.price;
    const client = await this.stripe();
    const price = await client.prices.retrieve(priceId);
    if (!price.active || price.type !== "one_time" || !Number.isInteger(price.unit_amount) || !price.currency) {
      throw new PaymentConfigurationError("This product price is not available for checkout.");
    }
    this.priceCache.set(priceId, { price, expiresAt: Date.now() + PRICE_CACHE_MS });
    return price;
  }

  async publicFormats(formats) {
    if (!(this.client || this.apiKey) || !Object.values(this.priceIds).every(Boolean)) {
      return formats.map((format) => ({ ...format, pricing: null }));
    }
    try {
      return await Promise.all(formats.map(async (format) => {
        const price = await this.retrievePrice(format.slug);
        return {
          ...format,
          status: this.configured ? "available" : "configuration-pending",
          interestOpen: !this.configured,
          pricing: {
            unitAmount: price.unit_amount,
            currency: price.currency.toUpperCase()
          }
        };
      }));
    } catch {
      return formats.map((format) => ({ ...format, pricing: null }));
    }
  }

  async createCheckout({ format, quantity, requestId }) {
    if (!this.configured) throw new PaymentConfigurationError();
    const price = await this.retrievePrice(format.slug);
    const client = await this.stripe();
    const metadata = {
      format_slug: format.slug,
      format_name: format.name,
      sku: format.sku,
      unit_count: String(format.count),
      quantity: String(quantity)
    };
    const params = {
      mode: "payment",
      integration_identifier: this.integrationIdentifier,
      line_items: [{ price: price.id, quantity }],
      customer_creation: "always",
      shipping_address_collection: { allowed_countries: this.shippingCountries },
      success_url: `${this.publicBaseUrl}/order-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.publicBaseUrl}/?checkout=cancelled#formats`,
      metadata,
      payment_intent_data: { metadata }
    };
    if (this.shippingRateIds.length) {
      params.shipping_options = this.shippingRateIds.map((shippingRate) => ({ shipping_rate: shippingRate }));
    }
    const session = await client.checkout.sessions.create(params, { idempotencyKey: `seven_roots_${requestId}` });
    if (!session.url) throw new Error("Stripe did not return a Checkout URL.");
    return { id: session.id, url: session.url };
  }

  async constructWebhookEvent(rawBody, signature) {
    if (!this.webhookSecret) throw new PaymentConfigurationError("Stripe webhooks are not configured.");
    if (!signature) throw new Error("Missing Stripe-Signature header.");
    const client = await this.stripe();
    return client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}

export const createPayments = (options) => new StripePayments(options);
