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

const zohoInspection = (activate = false) => ({
  checkedAt: "2026-08-20T12:00:00.000Z",
  locations: [
    { id: "loc_liberia", name: "Liberia Warehouse", country: "Liberia", status: "active" },
    { id: "loc_us", name: "U.S. Fulfillment", country: "United States", status: "active" }
  ],
  liberiaLocation: { id: "loc_liberia", name: "Liberia Warehouse", country: "Liberia", status: "active" },
  usLocation: { id: "loc_us", name: "U.S. Fulfillment", country: "United States", status: "active" },
  locationsReady: true,
  mappings: [
    { formatSlug: "travel-sleeve", formatName: "Travel Sleeve", sku: "SR-T01", matched: true, zohoItemId: "item_t01", zohoItemName: "Travel Sleeve", liberia: { locationId: "loc_liberia", locationName: "Liberia Warehouse", onHand: 90, available: 88 }, us: { locationId: "loc_us", locationName: "U.S. Fulfillment", onHand: 12, available: 11 }, ready: true },
    { formatSlug: "daily-ritual", formatName: "Daily Ritual", sku: "SR-R05", matched: true, zohoItemId: "item_r05", zohoItemName: "Daily Ritual", liberia: { locationId: "loc_liberia", locationName: "Liberia Warehouse", onHand: 42, available: 40 }, us: { locationId: "loc_us", locationName: "U.S. Fulfillment", onHand: 4, available: 4 }, ready: true },
    { formatSlug: "family-reserve", formatName: "Family Reserve", sku: "SR-F12", matched: true, zohoItemId: "item_f12", zohoItemName: "Family Reserve", liberia: { locationId: "loc_liberia", locationName: "Liberia Warehouse", onHand: 20, available: 18 }, us: { locationId: "loc_us", locationName: "U.S. Fulfillment", onHand: 7, available: 6 }, ready: true }
  ],
  mappedCount: 3,
  readyCount: 3,
  ready: true,
  activate
});

const zohoMock = ({ active = false } = {}) => {
  const mock = {
    active,
    createdOrders: [],
    status(state = {}) {
      return {
        provider: "zoho_inventory",
        configured: true,
        enabled: mock.active,
        connected: Boolean(state.lastConnectedAt || state.lastSuccessAt),
        inventoryAuthority: Boolean(state.inventoryAuthority && mock.active),
        missingSettings: [],
        organizationId: "…123456",
        dataCenter: "www.zohoapis.com",
        locations: { liberia: state.liberiaLocation || null, us: state.usLocation || null },
        mappings: state.mappings || [],
        pendingOrders: state.pendingOrders || 0,
        failedOrders: state.failedOrders || 0,
        lastAttemptAt: state.lastAttemptAt || null,
        lastSuccessAt: state.lastSuccessAt || null,
        lastError: state.lastError || "",
        activationNote: mock.active ? "Enabled" : "Readiness mode"
      };
    },
    async testConnection() { return zohoInspection(false); },
    async syncCatalog() { return zohoInspection(mock.active); },
    async createPaidSalesOrder(order, mapping) {
      mock.createdOrders.push({ orderNumber: order.orderNumber, zohoItemId: mapping.zohoItemId });
      return { salesOrderId: `zso_${order.orderNumber}`, salesOrderNumber: order.orderNumber, syncedAt: "2026-08-20T12:05:00.000Z" };
    }
  };
  return mock;
};

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
          total_details: { amount_shipping: 400, amount_tax: 0 },
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

    const payments = await fetch(`${baseUrl}/api/v1/admin/payments`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const paymentPayload = await payments.json();
    assert.equal(payments.status, 200);
    assert.equal(paymentPayload.data.length, 1);
    assert.equal(paymentPayload.data[0].orderNumber, confirmationPayload.data.orderNumber);
    assert.equal(paymentPayload.data[0].stripePaymentIntentId, "pi_test_123");
    assert.equal(paymentPayload.data[0].status, "paid");

    const report = await fetch(`${baseUrl}/api/v1/admin/financial-report`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const reportPayload = await report.json();
    assert.equal(report.status, 200);
    assert.equal(reportPayload.data.totals[0].grossSales, 4000);
    assert.equal(reportPayload.data.totals[0].productSales, 3600);
    assert.equal(reportPayload.data.totals[0].shippingRevenue, 400);
    assert.equal(reportPayload.data.totals[0].netCollected, 4000);
  }, { payments: paymentMock() });
});

test("reserves tracked inventory and decrements it once after signed payment", async () => {
  await withServer(async (baseUrl) => {
    const inventoryUpdate = await fetch(`${baseUrl}/api/v1/admin/inventory/daily-ritual`, {
      method: "PATCH",
      headers: { authorization: "Bearer test-admin-key", "content-type": "application/json" },
      body: JSON.stringify({ stockOnHand: 3, reorderLevel: 1, reason: "Opening physical count" })
    });
    assert.equal(inventoryUpdate.status, 200);
    assert.equal((await inventoryUpdate.json()).data.available, 3);

    const checkout = await fetch(`${baseUrl}/api/v1/checkout/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "inventory-checkout-1" },
      body: JSON.stringify({ formatSlug: "daily-ritual", quantity: 2 })
    });
    assert.equal(checkout.status, 201);

    const reserved = await fetch(`${baseUrl}/api/v1/admin/inventory`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const reservedItem = (await reserved.json()).data.find((item) => item.formatSlug === "daily-ritual");
    assert.equal(reservedItem.stockOnHand, 3);
    assert.equal(reservedItem.reserved, 2);
    assert.equal(reservedItem.available, 1);

    const oversell = await fetch(`${baseUrl}/api/v1/checkout/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "inventory-checkout-2" },
      body: JSON.stringify({ formatSlug: "daily-ritual", quantity: 2 })
    });
    const oversellPayload = await oversell.json();
    assert.equal(oversell.status, 409);
    assert.equal(oversellPayload.error.code, "insufficient_inventory");
    assert.equal(oversellPayload.error.details.available, 1);

    const event = {
      id: "evt_inventory_paid_1",
      type: "checkout.session.completed",
      livemode: false,
      data: {
        object: {
          id: "cs_test_checkout123",
          created: 1787184000,
          payment_status: "paid",
          payment_intent: "pi_inventory_123",
          amount_subtotal: 3600,
          amount_total: 4000,
          total_details: { amount_shipping: 400, amount_tax: 0 },
          currency: "usd",
          metadata: { format_slug: "daily-ritual", format_name: "Daily Ritual", sku: "SR-R05", quantity: "2" },
          customer_details: { name: "Amina Johnson", email: "amina@example.com" }
        }
      }
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const webhook = await fetch(`${baseUrl}/api/v1/stripe/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": "test-signature" },
        body: JSON.stringify(event)
      });
      assert.equal(webhook.status, 200);
    }

    const completed = await fetch(`${baseUrl}/api/v1/admin/inventory`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const completedItem = (await completed.json()).data.find((item) => item.formatSlug === "daily-ritual");
    assert.equal(completedItem.stockOnHand, 1);
    assert.equal(completedItem.reserved, 0);
    assert.equal(completedItem.available, 1);
    assert.equal(completedItem.unitsSold, 2);
    assert.equal(completedItem.status, "low_stock");

    const publicCatalog = await fetch(`${baseUrl}/api/v1/formats/daily-ritual`);
    const publicPayload = await publicCatalog.json();
    assert.equal(publicPayload.data.availability.status, "available");
    assert.equal(publicPayload.data.availability.stockOnHand, undefined);
  }, { payments: paymentMock() });
});

test("releases a stock reservation when Stripe expires Checkout", async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/api/v1/admin/inventory/daily-ritual`, {
      method: "PATCH",
      headers: { authorization: "Bearer test-admin-key", "content-type": "application/json" },
      body: JSON.stringify({ stockOnHand: 2, reorderLevel: 1 })
    });
    await fetch(`${baseUrl}/api/v1/checkout/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "inventory-expiry-1" },
      body: JSON.stringify({ formatSlug: "daily-ritual", quantity: 2 })
    });

    const expiredEvent = {
      id: "evt_inventory_expired_1",
      type: "checkout.session.expired",
      livemode: false,
      data: {
        object: {
          id: "cs_test_checkout123",
          created: 1787184000,
          payment_status: "unpaid",
          amount_subtotal: 3600,
          amount_total: 4000,
          total_details: { amount_shipping: 400, amount_tax: 0 },
          currency: "usd",
          metadata: { format_slug: "daily-ritual", format_name: "Daily Ritual", sku: "SR-R05", quantity: "2" }
        }
      }
    };
    const webhook = await fetch(`${baseUrl}/api/v1/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "test-signature" },
      body: JSON.stringify(expiredEvent)
    });
    assert.equal(webhook.status, 200);

    const inventory = await fetch(`${baseUrl}/api/v1/admin/inventory`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const item = (await inventory.json()).data.find((record) => record.formatSlug === "daily-ritual");
    assert.equal(item.stockOnHand, 2);
    assert.equal(item.reserved, 0);
    assert.equal(item.available, 2);
    assert.equal(item.unitsSold, 0);
  }, { payments: paymentMock() });
});

test("records Stripe refunds without duplicating the payment ledger", async () => {
  await withServer(async (baseUrl) => {
    const sendEvent = (event) => fetch(`${baseUrl}/api/v1/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "test-signature" },
      body: JSON.stringify(event)
    });
    const completed = {
      id: "evt_refund_order_paid_1",
      type: "checkout.session.completed",
      livemode: false,
      data: {
        object: {
          id: "cs_test_refund123",
          created: 1787184000,
          payment_status: "paid",
          payment_intent: "pi_refund_123",
          amount_subtotal: 3600,
          amount_total: 4000,
          total_details: { amount_shipping: 400, amount_tax: 0 },
          currency: "usd",
          metadata: { format_slug: "daily-ritual", format_name: "Daily Ritual", sku: "SR-R05", quantity: "2" },
          customer_details: { name: "Amina Johnson", email: "amina@example.com" }
        }
      }
    };
    assert.equal((await sendEvent(completed)).status, 200);

    const partialRefund = {
      id: "evt_refund_partial_1",
      type: "charge.refunded",
      livemode: false,
      data: {
        object: {
          object: "charge",
          id: "ch_refund_123",
          payment_intent: "pi_refund_123",
          amount: 4000,
          amount_refunded: 1000,
          refunded: false,
          currency: "usd"
        }
      }
    };
    assert.equal((await sendEvent(partialRefund)).status, 200);

    const payments = await fetch(`${baseUrl}/api/v1/admin/payments`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const paymentItems = (await payments.json()).data;
    assert.equal(paymentItems.length, 1);
    assert.equal(paymentItems[0].status, "partially_refunded");
    assert.equal(paymentItems[0].amountRefunded, 1000);
    assert.equal(paymentItems[0].stripeChargeId, "ch_refund_123");

    const report = await fetch(`${baseUrl}/api/v1/admin/financial-report`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const totals = (await report.json()).data.totals[0];
    assert.equal(totals.grossSales, 4000);
    assert.equal(totals.refunds, 1000);
    assert.equal(totals.netCollected, 3000);
  }, { payments: paymentMock() });
});

test("reports a disconnected Zoho bridge without exposing credentials", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/admin/zoho/status`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.configured, false);
    assert.equal(payload.data.enabled, false);
    assert.ok(payload.data.missingSettings.includes("ZOHO_REFRESH_TOKEN"));
    assert.equal(JSON.stringify(payload).includes("clientSecret"), false);

    const testConnection = await fetch(`${baseUrl}/api/v1/admin/zoho/test`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-key" }
    });
    assert.equal(testConnection.status, 503);
    assert.equal((await testConnection.json()).error.code, "zoho_not_configured");
  });
});

test("synchronizes Liberia and U.S. Zoho stock and protects authoritative counts", async () => {
  const zoho = zohoMock({ active: true });
  await withServer(async (baseUrl) => {
    const testConnection = await fetch(`${baseUrl}/api/v1/admin/zoho/test`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-key" }
    });
    assert.equal(testConnection.status, 200);

    const sync = await fetch(`${baseUrl}/api/v1/admin/zoho/sync`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-key" }
    });
    const syncPayload = await sync.json();
    assert.equal(sync.status, 200);
    assert.equal(syncPayload.data.inventoryAuthority, true);
    assert.equal(syncPayload.data.mappings.length, 3);

    const inventory = await fetch(`${baseUrl}/api/v1/admin/inventory`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const ritual = (await inventory.json()).data.find((item) => item.formatSlug === "daily-ritual");
    assert.equal(ritual.source, "zoho");
    assert.equal(ritual.stockOnHand, 4);
    assert.equal(ritual.zohoLocations.liberia.available, 40);
    assert.equal(ritual.zohoLocations.us.available, 4);

    const oversell = await fetch(`${baseUrl}/api/v1/checkout/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "zoho-stock-limit" },
      body: JSON.stringify({ formatSlug: "daily-ritual", quantity: 5 })
    });
    assert.equal(oversell.status, 409);
    assert.equal((await oversell.json()).error.details.available, 4);

    const manualOverwrite = await fetch(`${baseUrl}/api/v1/admin/inventory/daily-ritual`, {
      method: "PATCH",
      headers: { authorization: "Bearer test-admin-key", "content-type": "application/json" },
      body: JSON.stringify({ stockOnHand: 100 })
    });
    assert.equal(manualOverwrite.status, 409);
    assert.equal((await manualOverwrite.json()).error.code, "inventory_read_only");
  }, { payments: paymentMock(), zoho });
});

test("exports paid Stripe orders to Zoho exactly once through the durable outbox", async () => {
  const zoho = zohoMock({ active: false });
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/api/v1/admin/zoho/sync`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-key" }
    });
    const event = {
      id: "evt_zoho_order_paid_1",
      type: "checkout.session.completed",
      livemode: true,
      data: {
        object: {
          id: "cs_test_zoho123",
          created: 1787184000,
          payment_status: "paid",
          payment_intent: "pi_zoho_123",
          amount_subtotal: 3600,
          amount_total: 4195,
          total_details: { amount_shipping: 595, amount_tax: 0 },
          currency: "usd",
          metadata: { format_slug: "daily-ritual", format_name: "Daily Ritual", sku: "SR-R05", quantity: "2" },
          customer_details: { name: "Amina Johnson", email: "amina@example.com" }
        }
      }
    };
    const webhook = await fetch(`${baseUrl}/api/v1/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "test-signature" },
      body: JSON.stringify(event)
    });
    assert.equal(webhook.status, 200);

    const queued = await fetch(`${baseUrl}/api/v1/admin/zoho/orders`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    assert.equal((await queued.json()).data[0].status, "pending");

    zoho.active = true;
    const activationSync = await fetch(`${baseUrl}/api/v1/admin/zoho/sync`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-key" }
    });
    assert.equal(activationSync.status, 200);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sync = await fetch(`${baseUrl}/api/v1/admin/zoho/orders/sync`, {
        method: "POST",
        headers: { authorization: "Bearer test-admin-key" }
      });
      assert.equal(sync.status, 200);
    }
    assert.equal(zoho.createdOrders.length, 1);
    assert.equal(zoho.createdOrders[0].zohoItemId, "item_r05");

    const completed = await fetch(`${baseUrl}/api/v1/admin/zoho/orders`, {
      headers: { authorization: "Bearer test-admin-key" }
    });
    const completedEntry = (await completed.json()).data[0];
    assert.equal(completedEntry.status, "synced");
    assert.match(completedEntry.zohoSalesOrderId, /^zso_SR-/u);
  }, { payments: paymentMock(), zoho });
});
