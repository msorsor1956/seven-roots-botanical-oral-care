import assert from "node:assert/strict";
import test from "node:test";
import { formats } from "../server/catalog.js";
import { ZohoConfigurationError, ZohoInventory } from "../server/zoho.js";

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json" }
});

const connectedOptions = (fetch) => ({
  organizationId: "organization_123456",
  clientId: "client_123",
  clientSecret: "client_secret_123",
  refreshToken: "refresh_token_123",
  liberiaLocationId: "loc_liberia",
  usLocationId: "loc_us",
  onlineCustomerId: "customer_web",
  enabled: true,
  fetch
});

test("Zoho adapter refreshes once, validates locations and maps exact storefront SKUs", async () => {
  const requests = [];
  const fetchMock = async (input, options = {}) => {
    const url = new URL(input);
    requests.push({ url, options });
    if (url.hostname === "accounts.zoho.com") {
      return jsonResponse({ access_token: "temporary_access_token", expires_in_sec: 3600 });
    }
    assert.equal(options.headers.authorization, "Zoho-oauthtoken temporary_access_token");
    if (url.pathname.endsWith("/locations")) {
      return jsonResponse({ code: 0, locations: [
        { location_id: "loc_liberia", location_name: "Liberia Warehouse", address: { country: "Liberia" }, status: "active" },
        { location_id: "loc_us", location_name: "U.S. Fulfillment", address: { country: "United States" }, status: "active" }
      ] });
    }
    if (url.pathname.endsWith("/items")) {
      return jsonResponse({ code: 0, items: formats.map((format, index) => ({
        item_id: `item_${index}`,
        name: format.name,
        sku: format.sku,
        locations: [
          { location_id: "loc_liberia", location_name: "Liberia Warehouse", location_stock_on_hand: "30", location_available_stock: "28" },
          { location_id: "loc_us", location_name: "U.S. Fulfillment", location_stock_on_hand: "9", location_available_stock: String(8 - index) }
        ]
      })) });
    }
    if (url.pathname.endsWith("/contacts/customer_web")) {
      return jsonResponse({ code: 0, contact: { contact_id: "customer_web", contact_name: "SEVEN ROOTS Online Store", status: "active" } });
    }
    throw new Error(`Unexpected Zoho test URL: ${url}`);
  };

  const zoho = new ZohoInventory(connectedOptions(fetchMock));
  const inspection = await zoho.testConnection(formats);
  assert.equal(inspection.ready, true);
  assert.equal(inspection.mappedCount, 3);
  assert.equal(inspection.mappings[1].us.available, 7);
  assert.equal(inspection.mappings[1].liberia.available, 28);
  assert.equal(inspection.onlineCustomer.name, "SEVEN ROOTS Online Store");
  assert.equal(requests.filter((request) => request.url.hostname === "accounts.zoho.com").length, 1);
  assert.equal(requests.every((request) => !request.url.searchParams.has("access_token")), true);
});

test("Zoho adapter creates and confirms an idempotent paid sales order", async () => {
  const requests = [];
  const fetchMock = async (input, options = {}) => {
    const url = new URL(input);
    requests.push({ url, options });
    if (url.hostname === "accounts.zoho.com") return jsonResponse({ access_token: "temporary_access_token", expires_in_sec: 3600 });
    if (url.pathname.endsWith("/salesorders") && options.method === "GET") return jsonResponse({ code: 0, salesorders: [] });
    if (url.pathname.endsWith("/salesorders") && options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.salesorder_number, "SR-20260820-ABC123");
      assert.equal(body.location_id, "loc_us");
      assert.equal(body.line_items[0].item_id, "item_r05");
      assert.equal(body.shipping_charge, 5.95);
      return jsonResponse({ code: 0, salesorder: { salesorder_id: "salesorder_123", salesorder_number: body.salesorder_number, status: "draft" } }, 201);
    }
    if (url.pathname.endsWith("/salesorders/salesorder_123/status/confirmed")) return jsonResponse({ code: 0, message: "confirmed" });
    throw new Error(`Unexpected Zoho test URL: ${url}`);
  };

  const zoho = new ZohoInventory(connectedOptions(fetchMock));
  const result = await zoho.createPaidSalesOrder({
    orderNumber: "SR-20260820-ABC123",
    formatSlug: "daily-ritual",
    sku: "SR-R05",
    quantity: 2,
    amountSubtotal: 3998,
    amountShipping: 595,
    stripePaymentIntentId: "pi_test_reference",
    createdAt: "2026-08-20T12:00:00.000Z",
    shipping: { address: { line1: "123 Root Street", city: "Indianapolis", state: "IN", postalCode: "46201", country: "US" } }
  }, { zohoItemId: "item_r05" });
  assert.equal(result.salesOrderId, "salesorder_123");
  assert.equal(requests.filter((request) => request.options.method === "POST" && request.url.pathname.endsWith("/salesorders")).length, 1);
  assert.equal(requests.some((request) => request.url.pathname.endsWith("/status/confirmed")), true);
});

test("Zoho adapter creates and completes an idempotent warehouse transfer order", async () => {
  const requests = [];
  const fetchMock = async (input, options = {}) => {
    const url = new URL(input);
    requests.push({ url, options });
    if (url.hostname === "accounts.zoho.com") return jsonResponse({ access_token: "temporary_access_token", expires_in_sec: 3600 });
    if (url.pathname.endsWith("/transferorders") && options.method === "GET") {
      return jsonResponse({ code: 0, transfer_orders: [], page_context: { has_more_page: false } });
    }
    if (url.pathname.endsWith("/transferorders") && options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.transfer_order_number, "SR-TR-20260820-ROOTS");
      assert.equal(body.from_location_id, "loc_liberia");
      assert.equal(body.to_location_id, "loc_us");
      assert.equal(body.line_items[0].item_id, "item_r05");
      assert.equal(body.line_items[0].quantity_transfer, 12);
      return jsonResponse({ code: 0, transfer_order: {
        transfer_order_id: "transfer_123",
        transfer_order_number: body.transfer_order_number,
        status: "draft"
      } }, 201);
    }
    if (url.pathname.endsWith("/transferorders/transfer_123/intransit")) return jsonResponse({ code: 0, message: "in transit" });
    if (url.pathname.endsWith("/transferorders/transfer_123/markastransferred")) return jsonResponse({ code: 0, message: "transferred" });
    throw new Error(`Unexpected Zoho test URL: ${url}`);
  };

  const zoho = new ZohoInventory(connectedOptions(fetchMock));
  const result = await zoho.createTransferOrder({
    transferNumber: "SR-TR-20260820-ROOTS",
    createdAt: "2026-08-20T12:00:00.000Z",
    notes: "Liberia replenishment",
    items: [{ formatSlug: "daily-ritual", formatName: "Daily Ritual", sku: "SR-R05", quantity: 12 }]
  }, [{ formatSlug: "daily-ritual", zohoItemId: "item_r05", zohoItemName: "Daily Ritual" }]);
  assert.equal(result.transferOrderId, "transfer_123");
  await zoho.markTransferInTransit(result.transferOrderId);
  await zoho.markTransferReceived(result.transferOrderId);
  assert.equal(requests.some((request) => request.url.pathname.endsWith("/intransit")), true);
  assert.equal(requests.some((request) => request.url.pathname.endsWith("/markastransferred")), true);
});

test("Zoho adapter rejects non-Zoho API domains", () => {
  assert.throws(
    () => new ZohoInventory({ ...connectedOptions(async () => jsonResponse({})), apiBaseUrl: "https://example.com/inventory/v1" }),
    ZohoConfigurationError
  );
});
