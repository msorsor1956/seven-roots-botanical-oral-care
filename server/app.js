import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formats, formatBySlug } from "./catalog.js";
import { createPayments, PaymentConfigurationError } from "./payments.js";
import { InventoryError, JsonStore } from "./store.js";
import { validateInquiry, validateWaitlist } from "./validation.js";
import { createZohoInventory, ZohoApiError, ZohoConfigurationError } from "./zoho.js";
import {
  StaffAccessError,
  StaffValidationError,
  clearStaffSessionCookie,
  hasStaffPermission,
  readStaffSessionCookie,
  roleCatalog,
  secureStaffValueEqual,
  staffSessionCookie
} from "./staff.js";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(serverDir, "..");
const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".png", "image/png"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"]
]);

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const sendJson = (response, status, payload, extraHeaders = {}) => {
  response.writeHead(status, { ...jsonHeaders, "Cache-Control": "no-store", ...extraHeaders });
  response.end(JSON.stringify(payload));
};

const publicRecord = (record) => ({ id: record.id, preferredFormat: record.preferredFormat, createdAt: record.createdAt });

const hashValue = (value) => createHash("sha256").update(value).digest();
const secureEqual = (left, right) => {
  if (!left || !right) return false;
  return timingSafeEqual(hashValue(left), hashValue(right));
};

const extractBearer = (request) => {
  const value = request.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
};

const clientKey = (request) => {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || request.socket.remoteAddress || "unknown";
};

const createRateLimiter = ({ windowMs, max }) => {
  const clients = new Map();
  return (request) => {
    const now = Date.now();
    const key = clientKey(request);
    const state = clients.get(key);
    if (!state || state.resetAt <= now) {
      clients.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    state.count += 1;
    return { allowed: state.count <= max, retryAfter: Math.ceil((state.resetAt - now) / 1000) };
  };
};

const readJson = async (request) => {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Send this request as application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024) throw new HttpError(413, "payload_too_large", "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "invalid_json", "Request body contains invalid JSON.");
  }
};

const readRaw = async (request, maxBytes = 512 * 1024) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "payload_too_large", "Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const safeStaticPath = (rootDir, pathname) => {
  const exact = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/404.html", "404.html"],
    ["/styles.css", "styles.css"],
    ["/app.js", "app.js"],
    ["/product-360.js", "product-360.js"],
    ["/admin", "admin.html"],
    ["/admin.html", "admin.html"],
    ["/admin.css", "admin.css"],
    ["/admin.js", "admin.js"],
    ["/staff", "staff.html"],
    ["/staff.html", "staff.html"],
    ["/staff.css", "staff.css"],
    ["/staff.js", "staff.js"],
    ["/order-success", "order-success.html"],
    ["/order-success.html", "order-success.html"],
    ["/order-success.css", "order-success.css"],
    ["/order-success.js", "order-success.js"],
    ["/robots.txt", "robots.txt"],
    ["/sitemap.xml", "sitemap.xml"],
    ["/favicon.ico", "assets/seven-roots-mark.svg"]
  ]);
  if (exact.has(pathname)) return path.join(rootDir, exact.get(pathname));
  if (!pathname.startsWith("/assets/")) return null;
  const relative = pathname.slice(1);
  const candidate = path.resolve(rootDir, relative);
  const assetRoot = `${path.resolve(rootDir, "assets")}${path.sep}`;
  return candidate.startsWith(assetRoot) ? candidate : null;
};

const serveFile = async (request, response, filePath, status = 200) => {
  try {
    const file = await stat(filePath);
    if (!file.isFile()) return false;
    const extension = path.extname(filePath).toLowerCase();
    const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
    response.writeHead(status, {
      "Content-Type": contentTypes.get(extension) || "application/octet-stream",
      "Content-Length": file.size,
      "Cache-Control": immutable ? "public, max-age=604800, immutable" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff"
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

export async function createApplication(options = {}) {
  const rootDir = path.resolve(options.rootDir || defaultRoot);
  const environment = options.environment || process.env.NODE_ENV || "development";
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(rootDir, ".data"));
  const adminApiKey = options.adminApiKey ?? process.env.ADMIN_API_KEY ?? "";
  const configuredOrigins = String(options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? "")
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  const store = options.store || await new JsonStore(dataDir).init();
  const payments = options.payments || createPayments(options.paymentOptions);
  const zoho = options.zoho || createZohoInventory(options.zohoOptions);
  const writeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
  const checkoutLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
  const connectorLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 12 });
  const staffAuthLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 12 });
  let zohoProcessing = false;

  const processZohoOutbox = async (limit = 25) => {
    if (!zoho.active || !store.zohoSyncState().inventoryAuthority || zohoProcessing) {
      return { processed: 0, synced: 0, failed: 0, skipped: true };
    }
    zohoProcessing = true;
    let synced = 0;
    let failed = 0;
    try {
      const pending = store.pendingZohoOrders(limit);
      for (const task of pending) {
        if (!task.order || !task.mapping?.zohoItemId) {
          await store.markZohoOrderFailed(task.entry.orderId, new Error("The paid order has no verified Zoho SKU mapping."));
          failed += 1;
          continue;
        }
        try {
          const result = await zoho.createPaidSalesOrder(task.order, task.mapping);
          await store.markZohoOrderSynced(task.entry.orderId, result);
          synced += 1;
        } catch (error) {
          await store.markZohoOrderFailed(task.entry.orderId, error);
          failed += 1;
        }
      }
      return { processed: synced + failed, synced, failed, skipped: false };
    } finally {
      zohoProcessing = false;
    }
  };

  const adminActor = { id: "owner-admin-key", name: "Owner admin", role: "owner", locations: ["liberia", "us"] };
  const requireStaff = async (request, permission = "") => {
    const authentication = await store.staffSession(readStaffSessionCookie(request));
    if (!authentication) throw new HttpError(401, "staff_unauthorized", "Sign in with an active staff account.");
    if (permission && !hasStaffPermission(authentication.user, permission)) {
      throw new HttpError(403, "staff_forbidden", "Your role does not allow this action.");
    }
    return authentication;
  };
  const requireStaffMutation = async (request, permission = "") => {
    const authentication = await requireStaff(request, permission);
    if (!secureStaffValueEqual(request.headers["x-csrf-token"], authentication.session.csrfToken)) {
      throw new HttpError(403, "csrf_failed", "Refresh the staff dashboard and try again.");
    }
    return authentication;
  };

  const refreshZohoWarehouseSnapshot = async () => {
    if (!zoho.active || !store.zohoSyncState().inventoryAuthority) return null;
    try {
      const result = await zoho.syncCatalog(formats);
      return await store.applyZohoSync(result);
    } catch (error) {
      await store.recordZohoFailure(error);
      return null;
    }
  };

  const retryTimer = setInterval(() => {
    void processZohoOutbox(10).catch((error) => console.error("Zoho order sync:", error?.message || "failed"));
  }, 5 * 60 * 1000);
  retryTimer.unref();

  const server = http.createServer(async (request, response) => {
    const suppliedRequestId = typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"].trim() : "";
    const requestId = /^[A-Za-z0-9_.:-]{1,120}$/u.test(suppliedRequestId) ? suppliedRequestId : randomUUID();
    const origin = String(request.headers.origin || "");
    const hostOrigin = request.headers.host ? `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}` : "";
    const originAllowed = !origin || origin === hostOrigin || configuredOrigins.includes(origin);

    response.setHeader("X-Request-Id", requestId);
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (environment === "production") response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (originAllowed && origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Vary", "Origin");
    }

    try {
      const url = new URL(request.url, hostOrigin || "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (request.method === "OPTIONS" && pathname.startsWith("/api/")) {
        if (!originAllowed) throw new HttpError(403, "origin_not_allowed", "This browser origin is not allowed.");
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CSRF-Token, X-Request-Id",
          "Access-Control-Max-Age": "86400"
        });
        response.end();
        return;
      }

      if (pathname.startsWith("/api/") && !originAllowed) {
        throw new HttpError(403, "origin_not_allowed", "This browser origin is not allowed.");
      }

      if (request.method === "GET" && pathname === "/api/v1/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "seven-roots-api",
          version: "1.5.0",
          storage: "file",
          payments: payments.configured ? "ready" : "configuration_required",
          inventoryIntegration: zoho.active ? "zoho_enabled" : "local"
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/formats") {
        const publicFormats = await payments.publicFormats(formats);
        const availableFormats = publicFormats.map((format) => ({
          ...format,
          availability: store.publicAvailability(format.slug)
        }));
        sendJson(response, 200, {
          data: availableFormats,
          meta: { count: availableFormats.length, pricingStatus: payments.configured ? "available" : "configuration_required" }
        });
        return;
      }

      if (request.method === "GET" && pathname.startsWith("/api/v1/formats/")) {
        const slug = pathname.slice("/api/v1/formats/".length);
        const format = formatBySlug.get(slug);
        if (!format) throw new HttpError(404, "format_not_found", "Product format not found.");
        const [publicFormat] = await payments.publicFormats([format]);
        sendJson(response, 200, { data: { ...publicFormat, availability: store.publicAvailability(format.slug) } });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/checkout/sessions") {
        const rate = checkoutLimiter(request);
        if (!rate.allowed) throw new HttpError(429, "rate_limited", "Too many checkout attempts. Please try again later.", { retryAfter: rate.retryAfter });
        const input = await readJson(request);
        const formatSlug = String(input.formatSlug || "").trim();
        const quantity = Number(input.quantity ?? 1);
        const details = {};
        if (!formatBySlug.has(formatSlug)) details.formatSlug = "Choose an available product format.";
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) details.quantity = "Quantity must be a whole number from 1 to 10.";
        if (Object.keys(details).length) throw new HttpError(422, "validation_failed", "Check the checkout details.", details);
        const format = formatBySlug.get(formatSlug);
        await store.reserveInventory(format, quantity, requestId);
        let session;
        try {
          session = await payments.createCheckout({ format, quantity, requestId });
        } catch (error) {
          await store.releaseInventoryReservation(requestId, "checkout_failed");
          if (error instanceof PaymentConfigurationError || error?.code === "checkout_not_configured") {
            throw new HttpError(503, "checkout_not_configured", error.message);
          }
          throw error;
        }
        await store.attachInventoryReservation(requestId, session.id);
        sendJson(response, 201, { data: session, message: "Secure checkout is ready." });
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/orders/lookup") {
        const sessionId = String(url.searchParams.get("session_id") || "");
        if (!/^cs_[A-Za-z0-9_]+$/u.test(sessionId)) throw new HttpError(422, "invalid_session", "A valid Checkout Session is required.");
        const order = store.publicOrder(sessionId);
        if (!order) throw new HttpError(404, "order_pending", "Your payment is still being confirmed. Please try again shortly.");
        sendJson(response, 200, { data: order });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/stripe/webhook") {
        const rawBody = await readRaw(request);
        let event;
        try {
          event = await payments.constructWebhookEvent(rawBody, String(request.headers["stripe-signature"] || ""));
        } catch (error) {
          if (error instanceof PaymentConfigurationError || error?.code === "checkout_not_configured") {
            throw new HttpError(503, "stripe_webhook_not_configured", "Stripe webhooks are not configured.");
          }
          throw new HttpError(400, "invalid_stripe_signature", "The Stripe webhook signature could not be verified.");
        }
        const result = await store.applyStripeEvent(event);
        sendJson(response, 200, { received: true, duplicate: result.duplicate });
        if (!result.duplicate && result.order?.status === "paid") {
          void processZohoOutbox(5).catch((error) => console.error("Zoho order sync:", error?.message || "failed"));
        }
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/waitlist") {
        const rate = writeLimiter(request);
        if (!rate.allowed) throw new HttpError(429, "rate_limited", "Too many requests. Please try again later.", { retryAfter: rate.retryAfter });
        const input = await readJson(request);
        const validation = validateWaitlist(input);
        if (validation.value.website) {
          sendJson(response, 202, { data: { accepted: true } });
          return;
        }
        if (!validation.valid) throw new HttpError(422, "validation_failed", "Check the highlighted fields.", validation.errors);
        const result = await store.addWaitlist(validation.value);
        sendJson(response, result.created ? 201 : 200, {
          data: publicRecord(result.record),
          meta: { created: result.created },
          message: result.created ? "You joined the SEVEN ROOTS pre-launch list." : "Your SEVEN ROOTS preferences were updated."
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/inquiries") {
        const rate = writeLimiter(request);
        if (!rate.allowed) throw new HttpError(429, "rate_limited", "Too many requests. Please try again later.", { retryAfter: rate.retryAfter });
        const input = await readJson(request);
        const validation = validateInquiry(input);
        if (validation.value.website) {
          sendJson(response, 202, { data: { accepted: true } });
          return;
        }
        if (!validation.valid) throw new HttpError(422, "validation_failed", "Check the highlighted fields.", validation.errors);
        const record = await store.addInquiry(validation.value);
        sendJson(response, 201, { data: { id: record.id, createdAt: record.createdAt }, message: "Your inquiry was received." });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/staff/auth/accept-invite") {
        const rate = staffAuthLimiter(request);
        if (!rate.allowed) throw new HttpError(429, "rate_limited", "Too many sign-in attempts. Try again later.", { retryAfter: rate.retryAfter });
        const input = await readJson(request);
        const authentication = await store.acceptStaffInvitation(String(input.token || ""), input.password);
        sendJson(response, 201, {
          data: { user: authentication.user, csrfToken: authentication.csrfToken, expiresAt: authentication.expiresAt },
          message: "Your staff account is active."
        }, { "Set-Cookie": staffSessionCookie(authentication.token, { secure: environment === "production" }) });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/staff/auth/login") {
        const rate = staffAuthLimiter(request);
        if (!rate.allowed) throw new HttpError(429, "rate_limited", "Too many sign-in attempts. Try again later.", { retryAfter: rate.retryAfter });
        const input = await readJson(request);
        const authentication = await store.authenticateStaff(input.email, input.password);
        sendJson(response, 200, {
          data: { user: authentication.user, csrfToken: authentication.csrfToken, expiresAt: authentication.expiresAt },
          message: "Staff access verified."
        }, { "Set-Cookie": staffSessionCookie(authentication.token, { secure: environment === "production" }) });
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/staff/auth/session") {
        const authentication = await requireStaff(request);
        sendJson(response, 200, {
          data: {
            user: authentication.publicUser,
            csrfToken: authentication.session.csrfToken,
            expiresAt: authentication.session.expiresAt
          }
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/staff/auth/logout") {
        await requireStaffMutation(request);
        await store.endStaffSession(readStaffSessionCookie(request));
        sendJson(response, 200, { data: { signedOut: true }, message: "Staff session ended." }, {
          "Set-Cookie": clearStaffSessionCookie({ secure: environment === "production" })
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/staff/workspace") {
        const authentication = await requireStaff(request);
        sendJson(response, 200, {
          data: {
            ...store.staffWorkspace(authentication.user),
            zoho: zoho.status(store.zohoSyncState())
          }
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/staff/tasks") {
        const authentication = await requireStaffMutation(request, "tasks.manage");
        const task = await store.createStaffTask(authentication.user, await readJson(request));
        sendJson(response, 201, { data: task, message: "Task created." });
        return;
      }

      if (request.method === "PATCH" && pathname.startsWith("/api/v1/staff/tasks/")) {
        const authentication = await requireStaffMutation(request, "tasks.update");
        const taskId = pathname.slice("/api/v1/staff/tasks/".length);
        const task = await store.updateStaffTask(authentication.user, taskId, await readJson(request));
        sendJson(response, 200, { data: task, message: "Task updated." });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/staff/inventory/counts") {
        const authentication = await requireStaffMutation(request, "inventory.count");
        const count = await store.createStockCount(authentication.user, await readJson(request));
        sendJson(response, 201, { data: count, message: "Physical count submitted for review." });
        return;
      }

      if (request.method === "POST" && pathname.startsWith("/api/v1/staff/inventory/counts/") && pathname.endsWith("/review")) {
        const authentication = await requireStaffMutation(request, "inventory.approve");
        const countId = pathname.slice("/api/v1/staff/inventory/counts/".length, -"/review".length);
        const input = await readJson(request);
        const count = await store.reviewStockCount(authentication.user, countId, input.decision);
        sendJson(response, 200, {
          data: count,
          message: count.status === "approved_pending_zoho"
            ? "Count approved. Apply the adjustment in Zoho, then synchronize inventory."
            : `Count ${count.status}.`
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/staff/transfers") {
        const authentication = await requireStaffMutation(request, "transfers.create");
        const transfer = await store.createStockTransfer(authentication.user, await readJson(request));
        sendJson(response, 201, { data: transfer, message: "Transfer draft created for owner approval." });
        return;
      }

      if (request.method === "POST" && pathname.startsWith("/api/v1/staff/transfers/") && pathname.endsWith("/approve")) {
        const authentication = await requireStaffMutation(request, "transfers.approve");
        const transferId = pathname.slice("/api/v1/staff/transfers/".length, -"/approve".length);
        const transfer = store.transferForAction(authentication.user, transferId, "transfers.approve", "draft");
        let zohoResult = null;
        const syncState = store.zohoSyncState();
        if (zoho.active) {
          if (!syncState.inventoryAuthority) throw new HttpError(409, "zoho_inventory_not_ready", "Run a successful Zoho inventory sync before approving transfers.");
          zohoResult = await zoho.createTransferOrder(transfer, syncState.mappings);
        }
        const approved = await store.approveStockTransfer(authentication.user, transferId, zohoResult);
        sendJson(response, 200, { data: approved, message: "Transfer approved." });
        return;
      }

      if (request.method === "POST" && pathname.startsWith("/api/v1/staff/transfers/") && pathname.endsWith("/dispatch")) {
        const authentication = await requireStaffMutation(request, "transfers.dispatch");
        const transferId = pathname.slice("/api/v1/staff/transfers/".length, -"/dispatch".length);
        const dispatchInput = await readJson(request);
        const transfer = store.transferForAction(authentication.user, transferId, "transfers.dispatch", "approved");
        if (zoho.active) {
          if (!transfer.zohoTransferOrderId) throw new HttpError(409, "zoho_transfer_missing", "Approve this transfer in Zoho before dispatching it.");
          await zoho.markTransferInTransit(transfer.zohoTransferOrderId);
        }
        const dispatched = await store.dispatchStockTransfer(authentication.user, transferId, dispatchInput);
        if (zoho.active) await refreshZohoWarehouseSnapshot();
        sendJson(response, 200, { data: dispatched, message: "Transfer marked in transit." });
        return;
      }

      if (request.method === "POST" && pathname.startsWith("/api/v1/staff/transfers/") && pathname.endsWith("/receive")) {
        const authentication = await requireStaffMutation(request, "transfers.receive");
        const transferId = pathname.slice("/api/v1/staff/transfers/".length, -"/receive".length);
        const transfer = store.transferForAction(authentication.user, transferId, "transfers.receive", "in_transit");
        if (zoho.active) {
          if (!transfer.zohoTransferOrderId) throw new HttpError(409, "zoho_transfer_missing", "This transfer has no Zoho transfer order.");
          await zoho.markTransferReceived(transfer.zohoTransferOrderId);
        }
        const received = await store.receiveStockTransfer(authentication.user, transferId);
        if (zoho.active) await refreshZohoWarehouseSnapshot();
        sendJson(response, 200, { data: received, message: "Transfer received and reconciled." });
        return;
      }

      if (request.method === "PATCH" && pathname.startsWith("/api/v1/staff/orders/") && pathname.endsWith("/fulfillment")) {
        const authentication = await requireStaffMutation(request, "orders.fulfill");
        const orderId = pathname.slice("/api/v1/staff/orders/".length, -"/fulfillment".length);
        const order = await store.updateOrderFulfillment(authentication.user, orderId, await readJson(request));
        sendJson(response, 200, { data: order, message: "Order fulfillment updated." });
        return;
      }

      if (pathname.startsWith("/api/v1/admin/")) {
        if (!adminApiKey) throw new HttpError(503, "admin_not_configured", "Admin access has not been configured.");
        if (!secureEqual(extractBearer(request), adminApiKey)) throw new HttpError(401, "unauthorized", "A valid admin API key is required.");
        if (request.method === "GET" && pathname === "/api/v1/admin/staff/roles") {
          sendJson(response, 200, { data: roleCatalog() });
          return;
        }
        if (request.method === "GET" && pathname === "/api/v1/admin/staff") {
          sendJson(response, 200, { data: store.listStaffUsers() });
          return;
        }
        if (request.method === "POST" && pathname === "/api/v1/admin/staff") {
          const created = await store.createStaffUser(await readJson(request), adminActor);
          const invitationUrl = `${hostOrigin || "http://localhost"}/staff?invite=${encodeURIComponent(created.invitation.token)}`;
          sendJson(response, 201, {
            data: { user: created.user, invitationUrl, expiresAt: created.invitation.expiresAt },
            message: "Employee invited. Copy the one-time link now; it will not be shown again."
          });
          return;
        }
        if (request.method === "POST" && pathname.startsWith("/api/v1/admin/staff/") && pathname.endsWith("/invitations")) {
          const userId = pathname.slice("/api/v1/admin/staff/".length, -"/invitations".length);
          const created = await store.issueStaffInvitation(userId, adminActor);
          const invitationUrl = `${hostOrigin || "http://localhost"}/staff?invite=${encodeURIComponent(created.invitation.token)}`;
          sendJson(response, 201, {
            data: { user: created.user, invitationUrl, expiresAt: created.invitation.expiresAt },
            message: "A new one-time invitation link was created."
          });
          return;
        }
        if (request.method === "PATCH" && pathname.startsWith("/api/v1/admin/staff/")) {
          const userId = pathname.slice("/api/v1/admin/staff/".length);
          const user = await store.updateStaffUser(userId, await readJson(request), adminActor);
          sendJson(response, 200, { data: user, message: "Employee access updated." });
          return;
        }
        if (request.method === "GET" && pathname === "/api/v1/admin/audit") {
          sendJson(response, 200, { data: store.staffAudit(adminActor, url.searchParams.get("limit")) });
          return;
        }
        if (request.method === "GET" && pathname === "/api/v1/admin/summary") {
          sendJson(response, 200, { data: store.summary() });
          return;
        }
        if (request.method === "GET" && pathname === "/api/v1/admin/waitlist") {
          sendJson(response, 200, { data: store.list("waitlist", url.searchParams.get("limit")) });
          return;
        }
        if (request.method === "GET" && pathname === "/api/v1/admin/inquiries") {
          sendJson(response, 200, { data: store.list("inquiries", url.searchParams.get("limit")) });
          return;
        }
        if (request.method === "GET" && pathname === "/api/v1/admin/orders") {
          sendJson(response, 200, { data: store.list("orders", url.searchParams.get("limit")) });
          return;
        }
        if (request.method === "GET" && pathname === "/api/v1/admin/payments") {
          sendJson(response, 200, { data: store.list("payments", url.searchParams.get("limit")) });
          return;
        }
        if (request.method === "GET" && pathname === "/api/v1/admin/inventory") {
          sendJson(response, 200, { data: store.inventoryReport() });
          return;
        }
        if (request.method === "GET" && pathname === "/api/v1/admin/financial-report") {
          sendJson(response, 200, { data: store.financialReport() });
          return;
        }
        if (request.method === "GET" && pathname === "/api/v1/admin/inventory-adjustments") {
          sendJson(response, 200, { data: store.list("inventoryAdjustments", url.searchParams.get("limit")) });
          return;
        }
        if (request.method === "GET" && pathname === "/api/v1/admin/zoho/status") {
          sendJson(response, 200, { data: zoho.status(store.zohoSyncState()) });
          return;
        }
        if (request.method === "GET" && pathname === "/api/v1/admin/zoho/orders") {
          sendJson(response, 200, { data: store.zohoOrderReport(url.searchParams.get("limit")) });
          return;
        }
        if (request.method === "POST" && pathname === "/api/v1/admin/zoho/test") {
          const rate = connectorLimiter(request);
          if (!rate.allowed) throw new HttpError(429, "rate_limited", "Too many Zoho connection attempts. Try again later.", { retryAfter: rate.retryAfter });
          try {
            const inspection = await zoho.testConnection(formats);
            const syncState = await store.recordZohoTest(inspection);
            sendJson(response, 200, {
              data: zoho.status(syncState),
              message: inspection.ready ? "Zoho connection and SKU mappings are verified." : "Zoho connected, but one or more SKU or location mappings need attention."
            });
          } catch (error) {
            await store.recordZohoFailure(error);
            throw error;
          }
          return;
        }
        if (request.method === "POST" && pathname === "/api/v1/admin/zoho/sync") {
          const rate = connectorLimiter(request);
          if (!rate.allowed) throw new HttpError(429, "rate_limited", "Too many Zoho synchronization attempts. Try again later.", { retryAfter: rate.retryAfter });
          try {
            const result = await zoho.syncCatalog(formats);
            const syncState = await store.applyZohoSync(result);
            sendJson(response, 200, {
              data: zoho.status(syncState),
              message: result.activate ? "Zoho now controls U.S. checkout inventory." : "Zoho inventory was verified in readiness mode; checkout stock was not changed."
            });
          } catch (error) {
            await store.recordZohoFailure(error);
            throw error;
          }
          return;
        }
        if (request.method === "POST" && pathname === "/api/v1/admin/zoho/orders/sync") {
          const rate = connectorLimiter(request);
          if (!rate.allowed) throw new HttpError(429, "rate_limited", "Too many Zoho synchronization attempts. Try again later.", { retryAfter: rate.retryAfter });
          const result = await processZohoOutbox(100);
          sendJson(response, 200, {
            data: { ...result, status: zoho.status(store.zohoSyncState()) },
            message: result.skipped ? "Zoho write-back is waiting for a verified, enabled connection." : `${result.synced} paid order${result.synced === 1 ? "" : "s"} synchronized.`
          });
          return;
        }
        if (request.method === "PATCH" && pathname.startsWith("/api/v1/admin/inventory/")) {
          const formatSlug = pathname.slice("/api/v1/admin/inventory/".length);
          if (!formatBySlug.has(formatSlug)) throw new HttpError(404, "format_not_found", "Product format not found.");
          const input = await readJson(request);
          const update = {};
          const details = {};
          if (Object.hasOwn(input, "stockOnHand")) {
            if (input.stockOnHand !== null && (!Number.isInteger(input.stockOnHand) || input.stockOnHand < 0 || input.stockOnHand > 1_000_000)) {
              details.stockOnHand = "Stock on hand must be a whole number from 0 to 1,000,000, or null to stop tracking.";
            } else update.stockOnHand = input.stockOnHand;
          }
          if (Object.hasOwn(input, "reorderLevel")) {
            if (!Number.isInteger(input.reorderLevel) || input.reorderLevel < 0 || input.reorderLevel > 100_000) {
              details.reorderLevel = "Reorder level must be a whole number from 0 to 100,000.";
            } else update.reorderLevel = input.reorderLevel;
          }
          if (!Object.keys(update).length && !Object.keys(details).length) details.inventory = "Provide stockOnHand or reorderLevel.";
          if (typeof input.reason === "string") update.reason = input.reason.trim().slice(0, 180);
          if (Object.keys(details).length) throw new HttpError(422, "validation_failed", "Check the inventory update.", details);
          const inventory = await store.updateInventory(formatSlug, update);
          sendJson(response, 200, { data: inventory, message: `${inventory.formatName} inventory was updated.` });
          return;
        }
      }

      if (pathname.startsWith("/api/")) throw new HttpError(404, "route_not_found", "API route not found.");

      if (request.method === "GET" || request.method === "HEAD") {
        const staticPath = safeStaticPath(rootDir, pathname);
        if (staticPath && await serveFile(request, response, staticPath)) return;
        if (await serveFile(request, response, path.join(rootDir, "404.html"), 404)) return;
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    } catch (error) {
      const inventoryError = error instanceof InventoryError;
      const zohoError = error instanceof ZohoConfigurationError || error instanceof ZohoApiError;
      const staffError = error instanceof StaffAccessError || error instanceof StaffValidationError;
      const status = error instanceof HttpError
        ? error.status
        : error instanceof StaffAccessError
          ? error.status
          : error instanceof StaffValidationError
            ? 422
        : inventoryError
          ? 409
          : error instanceof ZohoConfigurationError
            ? 503
            : error instanceof ZohoApiError
              ? 502
              : 500;
      if (status === 500) console.error(`[${requestId}]`, error);
      if (error?.details?.retryAfter) response.setHeader("Retry-After", String(error.details.retryAfter));
      sendJson(response, status, {
        error: {
          code: error instanceof HttpError || inventoryError || zohoError || staffError ? error.code : "internal_error",
          message: error instanceof HttpError || inventoryError || zohoError || staffError ? error.message : "The server could not complete this request.",
          ...((error instanceof HttpError || inventoryError || staffError) && error.details ? { details: error.details } : {}),
          ...(error instanceof ZohoConfigurationError && error.missing.length ? { details: { missingSettings: error.missing } } : {}),
          requestId
        }
      });
    }
  });

  return { server, store, payments, zoho, processZohoOutbox };
}
