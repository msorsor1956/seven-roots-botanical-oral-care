import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ZohoOAuthError, ZohoOAuthManager, ZOHO_INVENTORY_SCOPES } from "../server/zoho-oauth.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

const optionsFor = (dataDir, fetch) => ({
  dataDir,
  clientId: "client_test_123",
  clientSecret: "client_secret_test_123",
  encryptionKey,
  publicBaseUrl: "https://sevenroots.info",
  accountsBaseUrl: "https://accounts.zoho.com",
  fetch
});

test("Zoho OAuth stores a reusable refresh token encrypted and restores it after restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "seven-roots-oauth-"));
  const requests = [];
  const fetchMock = async (input, options = {}) => {
    requests.push({ input, options });
    return new Response(JSON.stringify({ refresh_token: "refresh_token_private_123", access_token: "access_token_short_123" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const manager = await new ZohoOAuthManager(optionsFor(dataDir, fetchMock)).init();
    const authorization = await manager.createAuthorizationUrl();
    const url = new URL(authorization.authorizationUrl);
    const state = url.searchParams.get("state");
    assert.equal(url.origin, "https://accounts.zoho.com");
    assert.equal(url.searchParams.get("redirect_uri"), "https://sevenroots.info/api/v1/zoho/callback");
    assert.deepEqual(url.searchParams.get("scope").split(","), [...ZOHO_INVENTORY_SCOPES]);

    const completed = await manager.complete({ code: "authorization_code_valid_123456", state });
    assert.equal(completed.refreshToken, "refresh_token_private_123");
    assert.equal(requests.length, 1);
    const tokenBody = new URLSearchParams(requests[0].options.body);
    assert.equal(tokenBody.get("grant_type"), "authorization_code");
    assert.equal(tokenBody.get("redirect_uri"), "https://sevenroots.info/api/v1/zoho/callback");

    const stored = await readFile(path.join(dataDir, "zoho-oauth.json"), "utf8");
    assert.equal(stored.includes("refresh_token_private_123"), false);
    assert.equal(stored.includes("client_secret_test_123"), false);

    const restored = await new ZohoOAuthManager(optionsFor(dataDir, fetchMock)).init();
    assert.equal(restored.refreshToken, "refresh_token_private_123");
    assert.equal(restored.status().connected, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Zoho OAuth rejects an invalid state before exchanging a code", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "seven-roots-oauth-"));
  let called = false;
  try {
    const manager = await new ZohoOAuthManager(optionsFor(dataDir, async () => {
      called = true;
      return new Response("{}");
    })).init();
    await manager.createAuthorizationUrl();
    await assert.rejects(
      manager.complete({ code: "authorization_code_valid_123456", state: "invalid_state_value_123456789" }),
      ZohoOAuthError
    );
    assert.equal(called, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
