import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const ACCOUNTS_HOSTS = new Set([
  "accounts.zoho.com",
  "accounts.zoho.eu",
  "accounts.zoho.in",
  "accounts.zoho.com.au",
  "accounts.zoho.jp",
  "accounts.zohocloud.ca",
  "accounts.zoho.sa"
]);

export const ZOHO_INVENTORY_SCOPES = Object.freeze([
  "ZohoInventory.items.READ",
  "ZohoInventory.items.CREATE",
  "ZohoInventory.settings.READ",
  "ZohoInventory.contacts.READ",
  "ZohoInventory.contacts.CREATE",
  "ZohoInventory.salesorders.CREATE",
  "ZohoInventory.salesorders.READ",
  "ZohoInventory.salesorders.UPDATE",
  "ZohoInventory.transferorders.CREATE",
  "ZohoInventory.transferorders.READ",
  "ZohoInventory.transferorders.UPDATE"
]);

const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

const safeAccountsUrl = (value) => {
  let url;
  try {
    url = new URL(String(value || "https://accounts.zoho.com"));
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || !ACCOUNTS_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash) return "";
  return url.origin;
};

const safePublicOrigin = (value) => {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "";
    return url.origin;
  } catch {
    return "";
  }
};

const parseEncryptionKey = (value) => {
  const text = String(value || "").trim();
  if (!text) return null;
  const candidates = [];
  try { candidates.push(Buffer.from(text, "base64")); } catch {}
  if (/^[a-f0-9]{64}$/iu.test(text)) candidates.push(Buffer.from(text, "hex"));
  return candidates.find((candidate) => candidate.length === 32) || null;
};

const hash = (value) => createHash("sha256").update(String(value || "")).digest();
const secureEqual = (left, right) => {
  const leftHash = hash(left);
  const rightHash = hash(right);
  return timingSafeEqual(leftHash, rightHash);
};

const encrypt = (value, key) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
};

const decrypt = (record, key) => {
  if (!record || record.algorithm !== "aes-256-gcm") return "";
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
};

export class ZohoOAuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.code = "zoho_oauth_error";
    this.status = status;
  }
}

export class ZohoOAuthManager {
  constructor(options = {}) {
    const environment = options.environment || process.env;
    this.dataDir = path.resolve(options.dataDir || ".data");
    this.filePath = path.join(this.dataDir, "zoho-oauth.json");
    this.clientId = String(options.clientId ?? environment.ZOHO_CLIENT_ID ?? "").trim();
    this.clientSecret = String(options.clientSecret ?? environment.ZOHO_CLIENT_SECRET ?? "").trim();
    this.encryptionKey = parseEncryptionKey(options.encryptionKey ?? environment.ZOHO_TOKEN_ENCRYPTION_KEY);
    this.accountsBaseUrl = safeAccountsUrl(options.accountsBaseUrl ?? environment.ZOHO_ACCOUNTS_URL);
    this.publicOrigin = safePublicOrigin(options.publicBaseUrl ?? environment.PUBLIC_BASE_URL);
    this.fetch = options.fetch || globalThis.fetch;
    this.data = {
      version: 1,
      encryptedRefreshToken: null,
      pendingState: null,
      onlineCustomerId: "",
      connectedAt: null,
      provisionedAt: null
    };
    this.refreshToken = "";
  }

  get configurationReady() {
    return Boolean(this.clientId && this.clientSecret && this.encryptionKey && this.accountsBaseUrl && this.publicOrigin);
  }

  get redirectUri() {
    return this.publicOrigin ? `${this.publicOrigin}/api/v1/zoho/callback` : "";
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.filePath, "utf8"));
      this.data = { ...this.data, ...saved };
      if (this.data.encryptedRefreshToken && this.encryptionKey) {
        this.refreshToken = decrypt(this.data.encryptedRefreshToken, this.encryptionKey);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.refreshToken = "";
        this.data.encryptedRefreshToken = null;
      }
    }
    return this;
  }

  status() {
    const missingSettings = [];
    if (!this.clientId) missingSettings.push("ZOHO_CLIENT_ID");
    if (!this.clientSecret) missingSettings.push("ZOHO_CLIENT_SECRET");
    if (!this.encryptionKey) missingSettings.push("ZOHO_TOKEN_ENCRYPTION_KEY");
    if (!this.publicOrigin) missingSettings.push("PUBLIC_BASE_URL");
    if (!this.accountsBaseUrl) missingSettings.push("ZOHO_ACCOUNTS_URL");
    return {
      configurationReady: this.configurationReady,
      connected: Boolean(this.refreshToken),
      connectedAt: this.data.connectedAt,
      provisionedAt: this.data.provisionedAt,
      missingSettings,
      redirectUri: this.redirectUri
    };
  }

  async #persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  async createAuthorizationUrl() {
    if (!this.configurationReady) {
      throw new ZohoOAuthError("Zoho OAuth is waiting for its secure Railway settings.", 503);
    }
    const state = randomBytes(32).toString("base64url");
    this.data.pendingState = {
      hash: hash(state).toString("hex"),
      expiresAt: new Date(Date.now() + OAUTH_STATE_MAX_AGE_MS).toISOString()
    };
    await this.#persist();
    const url = new URL(`${this.accountsBaseUrl}/oauth/v2/auth`);
    url.searchParams.set("scope", ZOHO_INVENTORY_SCOPES.join(","));
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString(), expiresAt: this.data.pendingState.expiresAt };
  }

  async complete({ code, state }) {
    if (!this.configurationReady) throw new ZohoOAuthError("Zoho OAuth is not configured.", 503);
    const pending = this.data.pendingState;
    const stateText = String(state || "");
    const codeText = String(code || "");
    if (!pending?.hash || !pending.expiresAt || new Date(pending.expiresAt).valueOf() <= Date.now()) {
      throw new ZohoOAuthError("This Zoho authorization request expired. Start the connection again.");
    }
    if (!/^[A-Za-z0-9_-]{20,200}$/u.test(stateText) || !secureEqual(pending.hash, hash(stateText).toString("hex"))) {
      throw new ZohoOAuthError("The Zoho authorization state could not be verified.");
    }
    if (!/^[A-Za-z0-9._-]{20,2048}$/u.test(codeText)) throw new ZohoOAuthError("Zoho returned an invalid authorization code.");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      code: codeText
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
      throw new ZohoOAuthError("Zoho authorization could not be reached. Try again.", 502);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.refresh_token) {
      throw new ZohoOAuthError("Zoho did not return a reusable inventory authorization. Start the connection again.", 502);
    }

    this.refreshToken = String(payload.refresh_token);
    this.data.encryptedRefreshToken = encrypt(this.refreshToken, this.encryptionKey);
    this.data.pendingState = null;
    this.data.connectedAt = new Date().toISOString();
    await this.#persist();
    return { refreshToken: this.refreshToken, connectedAt: this.data.connectedAt };
  }

  async recordProvisioning(onlineCustomerId) {
    const customerId = String(onlineCustomerId || "").trim();
    if (customerId) this.data.onlineCustomerId = customerId;
    this.data.provisionedAt = new Date().toISOString();
    await this.#persist();
    return { onlineCustomerId: this.data.onlineCustomerId, provisionedAt: this.data.provisionedAt };
  }
}

export const createZohoOAuthManager = (options) => new ZohoOAuthManager(options);
