import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formats, formatBySlug } from "./catalog.js";
import { JsonStore } from "./store.js";
import { validateInquiry, validateWaitlist } from "./validation.js";

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
  const writeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

  const server = http.createServer(async (request, response) => {
    const requestId = request.headers["x-request-id"] || randomUUID();
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
      response.setHeader("Vary", "Origin");
    }

    try {
      const url = new URL(request.url, hostOrigin || "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (request.method === "OPTIONS" && pathname.startsWith("/api/")) {
        if (!originAllowed) throw new HttpError(403, "origin_not_allowed", "This browser origin is not allowed.");
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id",
          "Access-Control-Max-Age": "86400"
        });
        response.end();
        return;
      }

      if (pathname.startsWith("/api/") && !originAllowed) {
        throw new HttpError(403, "origin_not_allowed", "This browser origin is not allowed.");
      }

      if (request.method === "GET" && pathname === "/api/v1/health") {
        sendJson(response, 200, { status: "ok", service: "seven-roots-api", version: "1.1.0", storage: "file" });
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/formats") {
        sendJson(response, 200, { data: formats, meta: { count: formats.length, pricingStatus: "pending" } });
        return;
      }

      if (request.method === "GET" && pathname.startsWith("/api/v1/formats/")) {
        const slug = pathname.slice("/api/v1/formats/".length);
        const format = formatBySlug.get(slug);
        if (!format) throw new HttpError(404, "format_not_found", "Product format not found.");
        sendJson(response, 200, { data: format });
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

      if (pathname.startsWith("/api/v1/admin/")) {
        if (!adminApiKey) throw new HttpError(503, "admin_not_configured", "Admin access has not been configured.");
        if (!secureEqual(extractBearer(request), adminApiKey)) throw new HttpError(401, "unauthorized", "A valid admin API key is required.");
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
      }

      if (pathname.startsWith("/api/")) throw new HttpError(404, "route_not_found", "API route not found.");

      if (request.method === "GET" || request.method === "HEAD") {
        const staticPath = safeStaticPath(rootDir, pathname);
        if (staticPath && await serveFile(request, response, staticPath)) return;
        if (await serveFile(request, response, path.join(rootDir, "404.html"), 404)) return;
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(`[${requestId}]`, error);
      if (error?.details?.retryAfter) response.setHeader("Retry-After", String(error.details.retryAfter));
      sendJson(response, status, {
        error: {
          code: error instanceof HttpError ? error.code : "internal_error",
          message: error instanceof HttpError ? error.message : "The server could not complete this request.",
          ...(error instanceof HttpError && error.details ? { details: error.details } : {}),
          requestId
        }
      });
    }
  });

  return { server, store };
}
