import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApplication } from "../server/app.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const adminHeaders = {
  authorization: "Bearer test-admin-key",
  "content-type": "application/json"
};

async function withServer(run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "seven-roots-staff-test-"));
  const { server } = await createApplication({ rootDir: projectRoot, dataDir, adminApiKey: "test-admin-key" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

const json = (method, body, headers = {}) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body)
});

const inviteEmployee = async (baseUrl, employee) => {
  const response = await fetch(`${baseUrl}/api/v1/admin/staff`, json("POST", employee, adminHeaders));
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(Object.hasOwn(payload.data.user, "passwordHash"), false);
  return {
    user: payload.data.user,
    token: new URL(payload.data.invitationUrl).searchParams.get("invite")
  };
};

const acceptInvitation = async (baseUrl, token, password = "correct-horse-battery-staple") => {
  const response = await fetch(`${baseUrl}/api/v1/staff/auth/accept-invite`, json("POST", { token, password }));
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^sr_staff_session=/u);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/u);
  assert.match(response.headers.get("set-cookie"), /SameSite=Lax/u);
  return { cookie, csrfToken: payload.data.csrfToken, user: payload.data.user };
};

const staffFetch = (baseUrl, pathname, session, options = {}) => {
  const headers = { cookie: session.cookie, ...(options.headers || {}) };
  if (options.method && options.method !== "GET") headers["x-csrf-token"] = session.csrfToken;
  if (Object.hasOwn(options, "body")) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    ...(Object.hasOwn(options, "body") ? { body: JSON.stringify(options.body) } : {})
  });
};

test("staff invitations create secure individual sessions and enforce Liberia role boundaries", async () => {
  await withServer(async (baseUrl) => {
    const staffPage = await fetch(`${baseUrl}/staff`);
    assert.equal(staffPage.status, 200);
    assert.match(await staffPage.text(), /STAFF OPERATIONS/u);

    const roles = await fetch(`${baseUrl}/api/v1/admin/staff/roles`, { headers: adminHeaders });
    const rolesPayload = await roles.json();
    assert.equal(roles.status, 200);
    assert.equal(rolesPayload.data.some((role) => role.id === "liberia_staff"), true);
    assert.equal(rolesPayload.data.some((role) => role.id === "finance"), true);

    const invited = await inviteEmployee(baseUrl, {
      name: "Martha Kromah",
      email: "martha@example.com",
      role: "liberia_staff",
      country: "Liberia",
      locations: ["liberia"]
    });

    const weak = await fetch(`${baseUrl}/api/v1/staff/auth/accept-invite`, json("POST", {
      token: invited.token,
      password: "too-short"
    }));
    assert.equal(weak.status, 422);
    assert.equal((await weak.json()).error.code, "weak_password");

    const session = await acceptInvitation(baseUrl, invited.token);
    assert.equal(session.user.role, "liberia_staff");

    const workspace = await staffFetch(baseUrl, "/api/v1/staff/workspace", session);
    const workspacePayload = await workspace.json();
    assert.equal(workspace.status, 200);
    assert.equal(workspacePayload.data.inventory.length, 3);
    assert.equal(workspacePayload.data.inventory.every((item) => item.location === "liberia"), true);
    assert.deepEqual(workspacePayload.data.orders, []);
    assert.equal(workspacePayload.data.finance, null);

    const missingCsrf = await fetch(`${baseUrl}/api/v1/staff/inventory/counts`, json("POST", {
      location: "liberia",
      formatSlug: "daily-ritual",
      countedStock: 18
    }, { cookie: session.cookie }));
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).error.code, "csrf_failed");

    const count = await staffFetch(baseUrl, "/api/v1/staff/inventory/counts", session, {
      method: "POST",
      body: { location: "liberia", formatSlug: "daily-ritual", countedStock: 18, reason: "Opening shelf count" }
    });
    assert.equal(count.status, 201);

    const forbiddenTask = await staffFetch(baseUrl, "/api/v1/staff/tasks", session, {
      method: "POST",
      body: { title: "Manager-only assignment", location: "liberia", type: "general" }
    });
    assert.equal(forbiddenTask.status, 403);

    const logout = await staffFetch(baseUrl, "/api/v1/staff/auth/logout", session, { method: "POST" });
    assert.equal(logout.status, 200);
    const expired = await staffFetch(baseUrl, "/api/v1/staff/auth/session", session);
    assert.equal(expired.status, 401);

    const login = await fetch(`${baseUrl}/api/v1/staff/auth/login`, json("POST", {
      email: "MARTHA@example.com",
      password: "correct-horse-battery-staple"
    }));
    assert.equal(login.status, 200);
  });
});

test("stock counts require a second approver and stay scoped to the employee location", async () => {
  await withServer(async (baseUrl) => {
    const counterInvite = await inviteEmployee(baseUrl, {
      name: "Josephine Doe",
      email: "josephine@example.com",
      role: "liberia_staff",
      country: "Liberia",
      locations: ["liberia"]
    });
    const managerInvite = await inviteEmployee(baseUrl, {
      name: "Samuel Cooper",
      email: "samuel@example.com",
      role: "liberia_manager",
      country: "Liberia",
      locations: ["liberia"]
    });
    const usInvite = await inviteEmployee(baseUrl, {
      name: "Ava Williams",
      email: "ava@example.com",
      role: "us_manager",
      country: "United States",
      locations: ["us"]
    });
    const counter = await acceptInvitation(baseUrl, counterInvite.token);
    const manager = await acceptInvitation(baseUrl, managerInvite.token);
    const usManager = await acceptInvitation(baseUrl, usInvite.token);

    const submitted = await staffFetch(baseUrl, "/api/v1/staff/inventory/counts", counter, {
      method: "POST",
      body: { location: "liberia", formatSlug: "family-reserve", countedStock: 26, reason: "End-of-day count" }
    });
    const count = (await submitted.json()).data;
    assert.equal(submitted.status, 201);

    const selfReview = await staffFetch(baseUrl, `/api/v1/staff/inventory/counts/${count.id}/review`, counter, {
      method: "POST",
      body: { decision: "approve" }
    });
    assert.equal(selfReview.status, 403);

    const approved = await staffFetch(baseUrl, `/api/v1/staff/inventory/counts/${count.id}/review`, manager, {
      method: "POST",
      body: { decision: "approve" }
    });
    const approvedPayload = await approved.json();
    assert.equal(approved.status, 200, JSON.stringify(approvedPayload));
    assert.equal(approvedPayload.data.status, "approved");

    const usWorkspace = await staffFetch(baseUrl, "/api/v1/staff/workspace", usManager);
    const usPayload = await usWorkspace.json();
    assert.equal(usPayload.data.inventory.every((item) => item.location === "us"), true);
    assert.equal(usPayload.data.stockCounts.some((item) => item.id === count.id), false);

    const audit = await fetch(`${baseUrl}/api/v1/admin/audit`, { headers: adminHeaders });
    const auditPayload = await audit.json();
    assert.equal(audit.status, 200);
    assert.equal(auditPayload.data.some((event) => event.action === "inventory.count_approved"), true);
  });
});

test("owner-controlled Liberia to U.S. transfers follow the full custody workflow", async () => {
  await withServer(async (baseUrl) => {
    const ownerInvite = await inviteEmployee(baseUrl, {
      name: "Operations Owner",
      email: "owner@example.com",
      role: "owner",
      country: "Liberia / United States",
      locations: ["liberia", "us"]
    });
    const owner = await acceptInvitation(baseUrl, ownerInvite.token);

    const created = await staffFetch(baseUrl, "/api/v1/staff/transfers", owner, {
      method: "POST",
      body: {
        fromLocation: "liberia",
        toLocation: "us",
        items: [{ formatSlug: "daily-ritual", quantity: 10 }],
        notes: "Replenishment shipment"
      }
    });
    const transfer = (await created.json()).data;
    assert.equal(created.status, 201);
    assert.equal(transfer.status, "draft");

    const approved = await staffFetch(baseUrl, `/api/v1/staff/transfers/${transfer.id}/approve`, owner, { method: "POST" });
    assert.equal(approved.status, 200);

    const missingReference = await staffFetch(baseUrl, `/api/v1/staff/transfers/${transfer.id}/dispatch`, owner, {
      method: "POST",
      body: {}
    });
    assert.equal(missingReference.status, 422);
    assert.equal((await missingReference.json()).error.code, "missing_shipment_reference");

    const dispatched = await staffFetch(baseUrl, `/api/v1/staff/transfers/${transfer.id}/dispatch`, owner, {
      method: "POST",
      body: { carrier: "Atlantic Freight", trackingNumber: "AF-77822" }
    });
    assert.equal(dispatched.status, 200);
    assert.equal((await dispatched.json()).data.status, "in_transit");

    const received = await staffFetch(baseUrl, `/api/v1/staff/transfers/${transfer.id}/receive`, owner, { method: "POST" });
    const receivedPayload = await received.json();
    assert.equal(received.status, 200, JSON.stringify(receivedPayload));
    assert.equal(receivedPayload.data.status, "received");

    const workspace = await staffFetch(baseUrl, "/api/v1/staff/workspace", owner);
    const workspacePayload = await workspace.json();
    const usDaily = workspacePayload.data.inventory.find((item) => item.location === "us" && item.formatSlug === "daily-ritual");
    assert.equal(usDaily.stockOnHand, 10);
  });
});
