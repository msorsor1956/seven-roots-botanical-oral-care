import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApplication } from "../server/app.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function withServer(run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "seven-roots-test-"));
  const { server } = await createApplication({ rootDir: projectRoot, dataDir, adminApiKey: "test-admin-key" });
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
