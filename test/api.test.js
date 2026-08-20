import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApplication } from "../server/app.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function withServer(run, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "seven-roots-test-"));
  const { server } = await createApplication({ rootDir: projectRoot, dataDir, adminApiKey: "test-admin-key", ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

const paymentMock = () => ({
  configured: true,
  async publicFormats(items) {
    return items.map((item, index) => ({
      ...item,
      status: "available",
      interestOpen: false,
      pricing: { unitAmount: [500, 1800, 3600][index] ?? 1800, currency: "USD" }
    }));
  },
  async createCheckout({ format, quantity, requestId }) {
    assert.equal(format.slug, "daily-ritual");
    assert.equal(quantity, 2);
    assert.ok(requestId);
    return { id: "cs_test_checkout123", url: "https://checkout.stripe.com/c/pay/test-session" };
  },
  async constructWebhookEvent(rawBody, signature) {
    if (signature !== "test-signature") throw new Error("Invalid signature");
    return JSON.parse(rawBody.toString("utf8"));
  }
});

test("serves the storefront and health endpoint", async () => {
  await withServer(async (baseUrl) => {
    const home = await fetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /SEVEN ROOTS/);
    const health = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    const admin = await fetch(`${baseUrl}/admin`);
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /PRIVATE STUDIO/);
    const missing = await fetch(`${baseUrl}/not-a-real-page`);
    assert.equal(missing.status, 404);
  });
});

test("returns the pre-launch product catalog without invented prices", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/formats`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.length, 3);
    assert.equal(payload.data[1].sku, "SR-R05");
    assert.equal(payload.data[1].pricing, null);
  });
});

test("validates and stores waitlist submissions", async () => {
  await withServer(async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/v1/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-email" })
    });
    assert.equal(invalid.status, 422);

    const validBody = {
      name: "Amina Johnson",
      email: "Amina@example.com",
      preferredFormat: "Daily Ritual",
      country: "United States",
      consent: true
    };
    const created = await fetch(`${baseUrl}/api/v1/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody)
    });
    assert.equal(created.status, 201);

    const updated = await fetch(`${baseUrl}/api/v1/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, preferredFormat: "Family Reserve" })
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).meta.created, false);

    const summary = await fetch(`${baseUrl}/api/v1/admin/summary`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    assert.equal(summary.status, 200);
    const payload = await summary.json();
    assert.equal(payload.data.waitlistTotal, 1);
    assert.equal(payload.data.formatInterest["family-reserve"], 1);
  });
});

test("protects private lead data", async () => {
  await withServer(async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/api/v1/admin/waitlist`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${baseUrl}/api/v1/admin/waitlist`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    assert.equal(authorized.status, 200);
  });
});

test("stores partner inquiries behind private admin access", async () => {
  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/v1/inquiries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Musa Kamara",
        email: "musa@example.com",
        organization: "Traceable Botanicals Cooperative",
        inquiryType: "sourcing",
        message: "We would like to discuss a verified botanical supply partnership.",
        consent: true
      })
    });
    assert.equal(created.status, 201);
    const inquiries = await fetch(`${baseUrl}/api/v1/admin/inquiries`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const payload = await inquiries.json();
    assert.equal(inquiries.status, 200);
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0].inquiryType, "sourcing");
  });
});

test("rejects unapproved browser origins", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "origin_not_allowed");
  });
});

test("creates a server-priced Stripe Checkout Session", async () => {
  await withServer(async (baseUrl) => {
    const catalog = await fetch(`${baseUrl}/api/v1/formats`);
    const catalogPayload = await catalog.json();
    assert.equal(catalogPayload.meta.pricingStatus, "available");
    assert.equal(catalogPayload.data[1].pricing.unitAmount, 1800);

    const invalid = await fetch(`${baseUrl}/api/v1/checkout/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ formatSlug: "daily-ritual", quantity: 12 })
    });
    assert.equal(invalid.status, 422);

    const checkout = await fetch(`${baseUrl}/api/v1/checkout/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "checkout-request-1" },
      body: JSON.stringify({ formatSlug: "daily-ritual", quantity: 2, amount: 1 })
    });
    const payload = await checkout.json();
    assert.equal(checkout.status, 201);
    assert.match(payload.data.url, /^https:\/\/checkout\.stripe\.com\//u);
  }, { payments: paymentMock() });
});

test("verifies Stripe webhooks and stores an idempotent order", async () => {
  await withServer(async (baseUrl) => {
    const event = {
      id: "evt_checkout_completed_1",
      type: "checkout.session.completed",
      livemode: false,
      data: {
        object: {
          id: "cs_test_completed123",
          created: 1787184000,
          payment_status: "paid",
          payment_intent: "pi_test_123",
          amount_subtotal: 3600,
          amount_total: 4000,
          currency: "usd",
          metadata: {
            format_slug: "daily-ritual",
            format_name: "Daily Ritual",
            sku: "SR-R05",
            quantity: "2"
          },
          customer_details: { name: "Amina Johnson", email: "amina@example.com", phone: "+13175550100" },
          collected_information: {
            shipping_details: {
              name: "Amina Johnson",
              address: { line1: "123 Root Street", city: "Indianapolis", state: "IN", postal_code: "46201", country: "US" }
            }
          }
        }
      }
    };

    const invalid = await fetch(`${baseUrl}/api/v1/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "wrong" },
      body: JSON.stringify(event)
    });
    assert.equal(invalid.status, 400);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const webhook = await fetch(`${baseUrl}/api/v1/stripe/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": "test-signature" },
        body: JSON.stringify(event)
      });
      assert.equal(webhook.status, 200);
    }

    const confirmation = await fetch(`${baseUrl}/api/v1/orders/lookup?session_id=cs_test_completed123`);
    const confirmationPayload = await confirmation.json();
    assert.equal(confirmation.status, 200);
    assert.equal(confirmationPayload.data.status, "paid");
    assert.equal(confirmationPayload.data.formatName, "Daily Ritual");
    assert.equal(confirmationPayload.data.customer, undefined);

    const orders = await fetch(`${baseUrl}/api/v1/admin/orders`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const orderPayload = await orders.json();
    assert.equal(orders.status, 200);
    assert.equal(orderPayload.data.length, 1);
    assert.equal(orderPayload.data[0].customer.email, "amina@example.com");

    const summary = await fetch(`${baseUrl}/api/v1/admin/summary`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const summaryPayload = await summary.json();
    assert.equal(summaryPayload.data.paidOrderTotal, 1);
    assert.equal(summaryPayload.data.paidRevenue.USD, 4000);
  }, { payments: paymentMock() });
});
