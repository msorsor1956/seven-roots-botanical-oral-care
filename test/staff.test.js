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

const unavailableEmail = () => ({
  configured: false,
  status: () => ({
    provider: "resend",
    configured: false,
    from: null,
    replyTo: null,
    missingSettings: ["RESEND_API_KEY", "EMAIL_FROM"]
  }),
  async sendStaffInvitation() {
    const error = new Error("Employee invitation email is not configured.");
    error.code = "email_not_configured";
    throw error;
  },
  async sendStaffTemporaryPassword() {
    const error = new Error("Employee password email is not configured.");
    error.code = "email_not_configured";
    throw error;
  }
});

async function withServer(run, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "seven-roots-staff-test-"));
  const { server } = await createApplication({
    rootDir: projectRoot,
    dataDir,
    adminApiKey: "test-admin-key",
    email: unavailableEmail(),
    ...options
  });
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

const inviteEmployee = async (baseUrl, employee, expectedDelivery = "not_configured") => {
  const response = await fetch(`${baseUrl}/api/v1/admin/staff`, json("POST", employee, adminHeaders));
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(Object.hasOwn(payload.data.user, "passwordHash"), false);
  assert.equal(payload.data.delivery.status, expectedDelivery);
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
  assert.match(response.headers.get("set-cookie"), /SameSite=Strict/u);
  assert.match(response.headers.get("set-cookie"), /Priority=High/u);
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

const staffUpload = (baseUrl, pathname, session, { name, type, kind, phase, contents }) => fetch(`${baseUrl}${pathname}`, {
  method: "POST",
  headers: {
    cookie: session.cookie,
    "x-csrf-token": session.csrfToken,
    "x-file-name": name,
    "x-file-kind": kind,
    "x-file-phase": phase,
    "content-type": type
  },
  body: contents
});

const onboardingAnswers = Object.freeze({
  personal_hygiene: "twenty_seconds",
  workplace_hygiene: "clean_as_you_go",
  ppe: "inspect_before_use",
  customer_service: "listen_confirm_resolve"
});

const completeAndApproveOnboarding = async (baseUrl, employee, reviewer, { uploadReviewerIdentity = true } = {}) => {
  const locked = await staffFetch(baseUrl, "/api/v1/staff/workspace", employee);
  assert.equal(locked.status, 403);
  assert.equal((await locked.json()).error.code, "onboarding_required");

  const employeePhoto = await staffUpload(baseUrl, "/api/v1/staff/profile/files/profile_photo", employee, {
    name: "employee.png", type: "image/png", contents: Buffer.from("employee-photo")
  });
  assert.equal(employeePhoto.status, 201, await employeePhoto.text());
  const employeeSignature = await staffUpload(baseUrl, "/api/v1/staff/profile/files/signature", employee, {
    name: "employee-signature.png", type: "image/png", contents: Buffer.from("employee-signature")
  });
  assert.equal(employeeSignature.status, 201, await employeeSignature.text());

  for (const [moduleId, answer] of Object.entries(onboardingAnswers)) {
    const completed = await staffFetch(baseUrl, `/api/v1/staff/onboarding/modules/${moduleId}/complete`, employee, {
      method: "POST", body: { answer }
    });
    assert.equal(completed.status, 200, await completed.text());
  }

  const submitted = await staffFetch(baseUrl, "/api/v1/staff/onboarding/submit", employee, {
    method: "POST",
    body: {
      signedName: employee.user.name,
      signedDate: new Date().toISOString().slice(0, 10),
      acknowledgments: ["truthful", "safety", "policy"]
    }
  });
  const submittedPayload = await submitted.json();
  assert.equal(submitted.status, 200, JSON.stringify(submittedPayload));
  assert.equal(submittedPayload.data.status, "pending_review");

  if (uploadReviewerIdentity) {
    const reviewerPhoto = await staffUpload(baseUrl, "/api/v1/staff/profile/files/profile_photo", reviewer, {
      name: "reviewer.png", type: "image/png", contents: Buffer.from("reviewer-photo")
    });
    assert.equal(reviewerPhoto.status, 201, await reviewerPhoto.text());
    const reviewerSignature = await staffUpload(baseUrl, "/api/v1/staff/profile/files/signature", reviewer, {
      name: "reviewer-signature.png", type: "image/png", contents: Buffer.from("reviewer-signature")
    });
    assert.equal(reviewerSignature.status, 201, await reviewerSignature.text());
  }

  const reviewQueue = await staffFetch(baseUrl, "/api/v1/staff/workspace", reviewer);
  const reviewQueuePayload = await reviewQueue.json();
  assert.equal(reviewQueue.status, 200, JSON.stringify(reviewQueuePayload));
  assert.equal(reviewQueuePayload.data.onboardingReviews.some((record) => record.user.id === employee.user.id && record.status === "pending_review"), true);

  const approved = await staffFetch(baseUrl, `/api/v1/staff/onboarding/reviews/${employee.user.id}`, reviewer, {
    method: "POST", body: { decision: "approve", reviewNote: "Training and signed identity record verified." }
  });
  const approvedPayload = await approved.json();
  assert.equal(approved.status, 200, JSON.stringify(approvedPayload));
  assert.equal(approvedPayload.data.status, "approved");
  assert.equal(approvedPayload.data.dashboardAccess, true);
  assert.equal(approvedPayload.data.review.reviewedByName, reviewer.user.name);
  assert.match(approvedPayload.data.review.managerPhotoUrl, /\/api\/v1\/staff\/files\//u);
  assert.match(approvedPayload.data.review.managerSignatureUrl, /\/api\/v1\/staff\/files\//u);
  const opened = await staffFetch(baseUrl, "/api/v1/staff/workspace", employee);
  const openedPayload = await opened.json();
  assert.equal(opened.status, 200, JSON.stringify(openedPayload));
  assert.equal(openedPayload.data.onboarding.status, "approved");
  assert.equal(openedPayload.data.onboarding.review.reviewedByName, reviewer.user.name);
  const managerPhoto = await staffFetch(baseUrl, approvedPayload.data.review.managerPhotoUrl, employee);
  assert.equal(managerPhoto.status, 200);
  const managerSignature = await staffFetch(baseUrl, approvedPayload.data.review.managerSignatureUrl, employee);
  assert.equal(managerSignature.status, 200);
  return approvedPayload.data;
};

test("admin employee invitations are emailed and delivery records remain visible", async () => {
  const deliveries = [];
  const email = {
    configured: true,
    status: () => ({
      provider: "resend",
      configured: true,
      from: "SEVEN ROOTS <staff@updates.sevenroots.example>",
      replyTo: null,
      missingSettings: []
    }),
    async sendStaffInvitation(input) {
      deliveries.push(input);
      return {
        provider: "resend",
        messageId: `email_${deliveries.length}`,
        sentAt: "2026-08-20T18:00:00.000Z"
      };
    }
  };

  await withServer(async (baseUrl) => {
    const emailStatus = await fetch(`${baseUrl}/api/v1/admin/email/status`, { headers: adminHeaders });
    assert.equal(emailStatus.status, 200);
    assert.equal((await emailStatus.json()).data.configured, true);

    const created = await fetch(`${baseUrl}/api/v1/admin/staff`, json("POST", {
      name: "Martha Kromah",
      email: "martha@example.com",
      role: "liberia_staff",
      country: "Liberia",
      locations: ["liberia"]
    }, adminHeaders));
    const createdPayload = await created.json();
    assert.equal(created.status, 201, JSON.stringify(createdPayload));
    assert.equal(createdPayload.data.delivery.status, "sent");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].user.email, "martha@example.com");
    assert.match(deliveries[0].invitationUrl, /^http:\/\/127\.0\.0\.1:/u);

    const directory = await fetch(`${baseUrl}/api/v1/admin/staff`, { headers: adminHeaders });
    const [employee] = (await directory.json()).data;
    assert.equal(employee.invitationDelivery.status, "sent");
    assert.equal(employee.invitationDelivery.provider, "resend");

    const replacement = await fetch(`${baseUrl}/api/v1/admin/staff/${employee.id}/invitations`, {
      method: "POST",
      headers: adminHeaders
    });
    const replacementPayload = await replacement.json();
    assert.equal(replacement.status, 201, JSON.stringify(replacementPayload));
    assert.equal(replacementPayload.data.delivery.status, "sent");
    assert.equal(deliveries.length, 2);

    const audit = await fetch(`${baseUrl}/api/v1/admin/audit`, { headers: adminHeaders });
    const auditPayload = await audit.json();
    assert.equal(auditPayload.data.filter((event) => event.action === "staff.invitation_sent").length, 2);
  }, { email });
});

test("staff password recovery emails a one-time temporary password and blocks all data until it is changed", async () => {
  const temporaryPasswordDeliveries = [];
  const email = {
    configured: true,
    status: () => ({
      provider: "resend",
      configured: true,
      from: "SEVEN ROOTS <staff@updates.sevenroots.example>",
      replyTo: null,
      missingSettings: []
    }),
    async sendStaffInvitation() {
      return { provider: "resend", messageId: "email_invitation", sentAt: new Date().toISOString() };
    },
    async sendStaffTemporaryPassword(input) {
      temporaryPasswordDeliveries.push(input);
      return { provider: "resend", messageId: "email_temporary_password", sentAt: new Date().toISOString() };
    }
  };

  await withServer(async (baseUrl) => {
    const invited = await inviteEmployee(baseUrl, {
      name: "Martha Kromah",
      email: "martha.recovery@example.com",
      role: "liberia_staff",
      country: "Liberia",
      locations: ["liberia"]
    }, "sent");
    const original = await acceptInvitation(baseUrl, invited.token, "original-private-password");

    const requested = await fetch(`${baseUrl}/api/v1/staff/auth/temporary-password/request`, json("POST", {
      email: "MARTHA.RECOVERY@example.com"
    }));
    const requestedPayload = await requested.json();
    assert.equal(requested.status, 202, JSON.stringify(requestedPayload));
    assert.deepEqual(requestedPayload.data, { accepted: true });
    assert.equal(temporaryPasswordDeliveries.length, 1);
    const temporaryPassword = temporaryPasswordDeliveries[0].temporaryPassword;
    assert.match(temporaryPassword, /^SR-[A-Za-z0-9_-]{24}$/u);
    assert.equal(JSON.stringify(requestedPayload).includes(temporaryPassword), false);
    assert.match(temporaryPasswordDeliveries[0].staffUrl, /\/staff$/u);

    const unknown = await fetch(`${baseUrl}/api/v1/staff/auth/temporary-password/request`, json("POST", {
      email: "not-a-staff-member@example.com"
    }));
    const unknownPayload = await unknown.json();
    assert.equal(unknown.status, 202);
    assert.equal(unknownPayload.message, requestedPayload.message);
    assert.equal(temporaryPasswordDeliveries.length, 1);

    const temporaryLogin = await fetch(`${baseUrl}/api/v1/staff/auth/login`, json("POST", {
      email: "martha.recovery@example.com",
      password: temporaryPassword
    }));
    const temporaryLoginPayload = await temporaryLogin.json();
    assert.equal(temporaryLogin.status, 200, JSON.stringify(temporaryLoginPayload));
    assert.equal(temporaryLoginPayload.data.user.passwordChangeRequired, true);
    const temporarySession = {
      cookie: String(temporaryLogin.headers.get("set-cookie") || "").split(";")[0],
      csrfToken: temporaryLoginPayload.data.csrfToken,
      user: temporaryLoginPayload.data.user
    };

    const originalRevoked = await staffFetch(baseUrl, "/api/v1/staff/auth/session", original);
    assert.equal(originalRevoked.status, 401);
    const protectedData = await staffFetch(baseUrl, "/api/v1/staff/onboarding", temporarySession);
    assert.equal(protectedData.status, 403);
    assert.equal((await protectedData.json()).error.code, "password_change_required");

    const reusedTemporary = await fetch(`${baseUrl}/api/v1/staff/auth/login`, json("POST", {
      email: "martha.recovery@example.com",
      password: temporaryPassword
    }));
    assert.equal(reusedTemporary.status, 401);

    const missingCsrf = await fetch(`${baseUrl}/api/v1/staff/auth/change-password`, json("POST", {
      password: "new-private-password-for-martha"
    }, { cookie: temporarySession.cookie }));
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).error.code, "csrf_failed");

    const reusedAsPrivate = await staffFetch(baseUrl, "/api/v1/staff/auth/change-password", temporarySession, {
      method: "POST",
      body: { password: temporaryPassword }
    });
    assert.equal(reusedAsPrivate.status, 422);
    assert.equal((await reusedAsPrivate.json()).error.code, "password_reused");

    const changed = await staffFetch(baseUrl, "/api/v1/staff/auth/change-password", temporarySession, {
      method: "POST",
      body: { password: "new-private-password-for-martha" }
    });
    const changedPayload = await changed.json();
    assert.equal(changed.status, 200, JSON.stringify(changedPayload));
    assert.equal(changedPayload.data.user.passwordChangeRequired, false);
    const changedSession = {
      cookie: String(changed.headers.get("set-cookie") || "").split(";")[0],
      csrfToken: changedPayload.data.csrfToken,
      user: changedPayload.data.user
    };

    const temporarySessionRevoked = await staffFetch(baseUrl, "/api/v1/staff/auth/session", temporarySession);
    assert.equal(temporarySessionRevoked.status, 401);
    const onboardingAvailable = await staffFetch(baseUrl, "/api/v1/staff/onboarding", changedSession);
    assert.equal(onboardingAvailable.status, 200);

    const oldPassword = await fetch(`${baseUrl}/api/v1/staff/auth/login`, json("POST", {
      email: "martha.recovery@example.com",
      password: "original-private-password"
    }));
    assert.equal(oldPassword.status, 401);
    const newPassword = await fetch(`${baseUrl}/api/v1/staff/auth/login`, json("POST", {
      email: "martha.recovery@example.com",
      password: "new-private-password-for-martha"
    }));
    assert.equal(newPassword.status, 200);

    const audit = await fetch(`${baseUrl}/api/v1/admin/audit`, { headers: adminHeaders });
    const actions = (await audit.json()).data.map((entry) => entry.action);
    for (const action of [
      "staff.temporary_password_requested",
      "staff.temporary_password_sent",
      "staff.temporary_password_used",
      "staff.password_changed"
    ]) assert.equal(actions.includes(action), true, action);
  }, { email });
});

test("failed temporary-password delivery preserves the employee's existing private password", async () => {
  let undeliveredTemporaryPassword = "";
  const email = {
    configured: true,
    status: () => ({ provider: "resend", configured: true, from: "SEVEN ROOTS <staff@updates.sevenroots.example>", replyTo: null, missingSettings: [] }),
    async sendStaffInvitation() {
      return { provider: "resend", messageId: "email_invitation", sentAt: new Date().toISOString() };
    },
    async sendStaffTemporaryPassword(input) {
      undeliveredTemporaryPassword = input.temporaryPassword;
      throw new Error("Provider unavailable");
    }
  };
  await withServer(async (baseUrl) => {
    const invited = await inviteEmployee(baseUrl, {
      name: "Ava Williams",
      email: "ava.recovery@example.com",
      role: "us_fulfillment",
      country: "United States",
      locations: ["us"]
    }, "sent");
    await acceptInvitation(baseUrl, invited.token, "ava-existing-private-password");

    const requested = await fetch(`${baseUrl}/api/v1/staff/auth/temporary-password/request`, json("POST", {
      email: "ava.recovery@example.com"
    }));
    assert.equal(requested.status, 202);
    assert.match(undeliveredTemporaryPassword, /^SR-/u);

    const undelivered = await fetch(`${baseUrl}/api/v1/staff/auth/login`, json("POST", {
      email: "ava.recovery@example.com",
      password: undeliveredTemporaryPassword
    }));
    assert.equal(undelivered.status, 401);
    const existing = await fetch(`${baseUrl}/api/v1/staff/auth/login`, json("POST", {
      email: "ava.recovery@example.com",
      password: "ava-existing-private-password"
    }));
    assert.equal(existing.status, 200);
  }, { email });
});

test("onboarding corrections keep operations locked until a signed management approval", async () => {
  await withServer(async (baseUrl) => {
    const managerInvite = await inviteEmployee(baseUrl, {
      name: "Samuel Cooper",
      email: "samuel.onboarding@example.com",
      role: "liberia_manager",
      country: "Liberia",
      locations: ["liberia"]
    });
    const manager = await acceptInvitation(baseUrl, managerInvite.token);
    const employeeInvite = await inviteEmployee(baseUrl, {
      name: "Martha Kromah",
      email: "martha.onboarding@example.com",
      role: "liberia_staff",
      country: "Liberia",
      locations: ["liberia"],
      managerId: manager.user.id
    });
    const employee = await acceptInvitation(baseUrl, employeeInvite.token);

    for (const [session, prefix] of [[manager, "manager"], [employee, "employee"]]) {
      const photo = await staffUpload(baseUrl, "/api/v1/staff/profile/files/profile_photo", session, {
        name: `${prefix}.png`, type: "image/png", contents: Buffer.from(`${prefix}-photo`)
      });
      assert.equal(photo.status, 201, await photo.text());
      const signature = await staffUpload(baseUrl, "/api/v1/staff/profile/files/signature", session, {
        name: `${prefix}-signature.png`, type: "image/png", contents: Buffer.from(`${prefix}-signature`)
      });
      assert.equal(signature.status, 201, await signature.text());
    }

    const incorrect = await staffFetch(baseUrl, "/api/v1/staff/onboarding/modules/ppe/complete", employee, {
      method: "POST", body: { answer: "skip_handwashing" }
    });
    assert.equal(incorrect.status, 422);
    assert.equal((await incorrect.json()).error.code, "onboarding_answer_incorrect");

    for (const [moduleId, answer] of Object.entries(onboardingAnswers)) {
      const completed = await staffFetch(baseUrl, `/api/v1/staff/onboarding/modules/${moduleId}/complete`, employee, {
        method: "POST", body: { answer }
      });
      assert.equal(completed.status, 200, await completed.text());
    }
    const signedRecord = {
      signedName: employee.user.name,
      signedDate: new Date().toISOString().slice(0, 10),
      acknowledgments: ["truthful", "safety", "policy"]
    };
    const submitted = await staffFetch(baseUrl, "/api/v1/staff/onboarding/submit", employee, {
      method: "POST", body: signedRecord
    });
    assert.equal(submitted.status, 200, await submitted.text());

    const returned = await staffFetch(baseUrl, `/api/v1/staff/onboarding/reviews/${employee.user.id}`, manager, {
      method: "POST", body: { decision: "request_changes", reviewNote: "Retake the employee photo in clear light." }
    });
    const returnedPayload = await returned.json();
    assert.equal(returned.status, 200, JSON.stringify(returnedPayload));
    assert.equal(returnedPayload.data.status, "changes_requested");
    assert.equal(returnedPayload.data.review.note, "Retake the employee photo in clear light.");

    const stillLocked = await staffFetch(baseUrl, "/api/v1/staff/workspace", employee);
    assert.equal(stillLocked.status, 403);
    const replacementPhoto = await staffUpload(baseUrl, "/api/v1/staff/profile/files/profile_photo", employee, {
      name: "employee-clear.png", type: "image/png", contents: Buffer.from("employee-clear-photo")
    });
    assert.equal(replacementPhoto.status, 201, await replacementPhoto.text());
    const resubmitted = await staffFetch(baseUrl, "/api/v1/staff/onboarding/submit", employee, {
      method: "POST", body: signedRecord
    });
    assert.equal(resubmitted.status, 200, await resubmitted.text());
    const approved = await staffFetch(baseUrl, `/api/v1/staff/onboarding/reviews/${employee.user.id}`, manager, {
      method: "POST", body: { decision: "approve", reviewNote: "Replacement photo and training record approved." }
    });
    assert.equal(approved.status, 200, await approved.text());
    const opened = await staffFetch(baseUrl, "/api/v1/staff/workspace", employee);
    assert.equal(opened.status, 200, await opened.text());

    const audit = await fetch(`${baseUrl}/api/v1/admin/audit`, { headers: adminHeaders });
    const auditPayload = await audit.json();
    assert.equal(auditPayload.data.some((event) => event.action === "onboarding.changes_requested"), true);
    assert.equal(auditPayload.data.some((event) => event.action === "onboarding.approved"), true);
  });
});

test("admin reviews every employee training record, downloads the PDF, and approves dashboard access", async () => {
  await withServer(async (baseUrl) => {
    const invited = await inviteEmployee(baseUrl, {
      name: "Korto Dennis",
      email: "korto.training@example.com",
      role: "us_fulfillment",
      country: "United States",
      locations: ["us"]
    });
    const employee = await acceptInvitation(baseUrl, invited.token);
    for (const [kind, name, contents] of [
      ["profile_photo", "korto-photo.png", "employee-photo"],
      ["signature", "korto-signature.png", "employee-signature"]
    ]) {
      const uploaded = await staffUpload(baseUrl, `/api/v1/staff/profile/files/${kind}`, employee, {
        name, type: "image/png", contents: Buffer.from(contents)
      });
      assert.equal(uploaded.status, 201, await uploaded.text());
    }
    for (const [moduleId, answer] of Object.entries(onboardingAnswers)) {
      const completed = await staffFetch(baseUrl, `/api/v1/staff/onboarding/modules/${moduleId}/complete`, employee, {
        method: "POST", body: { answer }
      });
      assert.equal(completed.status, 200, await completed.text());
    }
    const submitted = await staffFetch(baseUrl, "/api/v1/staff/onboarding/submit", employee, {
      method: "POST",
      body: {
        signedName: employee.user.name,
        signedDate: new Date().toISOString().slice(0, 10),
        acknowledgments: ["truthful", "safety", "policy"]
      }
    });
    assert.equal(submitted.status, 200, await submitted.text());

    const queue = await fetch(`${baseUrl}/api/v1/admin/onboarding`, { headers: adminHeaders });
    const queuePayload = await queue.json();
    assert.equal(queue.status, 200, JSON.stringify(queuePayload));
    const record = queuePayload.data.find((item) => item.user.id === employee.user.id);
    assert.equal(record.status, "pending_review");
    assert.equal(record.completedModules, 4);
    assert.ok(record.employeePhotoUrl);
    assert.ok(record.employeeSignatureUrl);

    const adminPdf = await fetch(`${baseUrl}/api/v1/admin/onboarding/document`, { headers: adminHeaders });
    assert.equal(adminPdf.status, 200, await adminPdf.text());
    assert.equal(adminPdf.headers.get("content-type"), "application/pdf");
    const staffPdf = await staffFetch(baseUrl, "/api/v1/staff/onboarding/document", employee);
    assert.equal(staffPdf.status, 200, await staffPdf.text());

    const approved = await fetch(`${baseUrl}/api/v1/admin/onboarding/${employee.user.id}/review`, json("POST", {
      decision: "approve",
      reviewNote: "All four modules and the signed employee record were reviewed.",
      reviewedByName: "Massayan Sorsor"
    }, adminHeaders));
    const approvedPayload = await approved.json();
    assert.equal(approved.status, 200, JSON.stringify(approvedPayload));
    assert.equal(approvedPayload.data.status, "approved");
    assert.equal(approvedPayload.data.review.reviewedByName, "Massayan Sorsor");
    assert.equal(approvedPayload.data.review.authorizationMethod, "admin_api_key");
    const workspace = await staffFetch(baseUrl, "/api/v1/staff/workspace", employee);
    assert.equal(workspace.status, 200, await workspace.text());
  });
});

test("task evidence requires manager approval with protected files, photo, signature, contacts, and WhatsApp updates", async () => {
  const whatsappCalls = [];
  const whatsapp = {
    configured: true,
    status: () => ({ provider: "meta_whatsapp_cloud_api", configured: true, missingSettings: [] }),
    async sendTaskUpdate(input) {
      whatsappCalls.push(input);
      return {
        provider: "meta_whatsapp_cloud_api",
        messageId: `wamid_${whatsappCalls.length}`,
        recipientLast4: String(input.to).replace(/\D/gu, "").slice(-4),
        sentAt: "2026-08-23T18:00:00.000Z"
      };
    }
  };

  await withServer(async (baseUrl) => {
    const ownerInvite = await inviteEmployee(baseUrl, {
      name: "Operations Owner",
      email: "owner@example.com",
      phone: "+1 317 555 0100",
      whatsappNumber: "+13175550100",
      jobTitle: "Owner Administrator",
      role: "owner",
      country: "Liberia / United States",
      locations: ["liberia", "us"]
    });
    const owner = await acceptInvitation(baseUrl, ownerInvite.token);
    const workerInvite = await inviteEmployee(baseUrl, {
      name: "Martha Kromah",
      email: "martha@example.com",
      phone: "+231 77 123 4567",
      whatsappNumber: "+231771234567",
      jobTitle: "Quality Associate",
      role: "liberia_staff",
      country: "Liberia",
      locations: ["liberia"],
      managerId: owner.user.id
    });
    const worker = await acceptInvitation(baseUrl, workerInvite.token);

    const ownerPhoto = await staffUpload(baseUrl, "/api/v1/staff/profile/files/profile_photo", owner, {
      name: "owner.png", type: "image/png", contents: Buffer.from("owner-photo")
    });
    assert.equal(ownerPhoto.status, 201, await ownerPhoto.text());
    const ownerSignature = await staffUpload(baseUrl, "/api/v1/staff/profile/files/signature", owner, {
      name: "signature.png", type: "image/png", contents: Buffer.from("signed-by-owner")
    });
    assert.equal(ownerSignature.status, 201, await ownerSignature.text());
    await completeAndApproveOnboarding(baseUrl, worker, owner, { uploadReviewerIdentity: false });

    const created = await staffFetch(baseUrl, "/api/v1/staff/tasks", owner, {
      method: "POST",
      body: {
        title: "Inspect export packing run",
        type: "quality",
        location: "liberia",
        priority: "urgent",
        assignedTo: worker.user.id,
        scopeOfWork: "Inspect the packed chewing sticks, record defects, and document the sealed export cartons.",
        evidenceRequirements: ["document", "photo", "video"]
      }
    });
    const createdPayload = await created.json();
    assert.equal(created.status, 201, JSON.stringify(createdPayload));
    const task = createdPayload.data.task;
    assert.equal(task.assignedTo, worker.user.id);
    assert.equal(whatsappCalls.at(-1).to, "+231771234567");

    const sow = await staffUpload(baseUrl, `/api/v1/staff/tasks/${task.id}/files`, owner, {
      name: "packing-sow.pdf", type: "application/pdf", kind: "sow", phase: "scope", contents: Buffer.from("test-sow")
    });
    const sowPayload = await sow.json();
    assert.equal(sow.status, 201, JSON.stringify(sowPayload));
    const sowTask = sowPayload.data;
    assert.equal(sowTask.attachments[0].phase, "scope");
    assert.equal(Object.hasOwn(sowTask.attachments[0], "storedPath"), false);

    const started = await staffFetch(baseUrl, `/api/v1/staff/tasks/${task.id}`, worker, {
      method: "PATCH", body: { status: "in_progress" }
    });
    assert.equal(started.status, 200);
    const earlySubmit = await staffFetch(baseUrl, `/api/v1/staff/tasks/${task.id}/submit`, worker, {
      method: "POST", body: { submissionNote: "Inspection complete." }
    });
    assert.equal(earlySubmit.status, 409);
    assert.equal((await earlySubmit.json()).error.code, "task_evidence_required");

    const evidence = [
      { name: "inspection.pdf", type: "application/pdf", kind: "document", contents: Buffer.from("inspection-report") },
      { name: "cartons.jpg", type: "image/jpeg", kind: "photo", contents: Buffer.from("photo-proof") },
      { name: "packing.mp4", type: "video/mp4", kind: "video", contents: Buffer.from("video-proof") }
    ];
    for (const file of evidence) {
      const uploaded = await staffUpload(baseUrl, `/api/v1/staff/tasks/${task.id}/files`, worker, { ...file, phase: "completion" });
      assert.equal(uploaded.status, 201, await uploaded.text());
    }

    const submitted = await staffFetch(baseUrl, `/api/v1/staff/tasks/${task.id}/submit`, worker, {
      method: "POST", body: { submissionNote: "All cartons passed inspection. Report, photos, and video are attached." }
    });
    const submittedPayload = await submitted.json();
    assert.equal(submitted.status, 200, JSON.stringify(submittedPayload));
    assert.equal(submittedPayload.data.task.status, "pending_approval");
    assert.equal(whatsappCalls.at(-1).to, "+13175550100");

    const approved = await staffFetch(baseUrl, `/api/v1/staff/tasks/${task.id}/review`, owner, {
      method: "POST", body: { decision: "approve", reviewNote: "Evidence reviewed and accepted." }
    });
    const approvedPayload = await approved.json();
    assert.equal(approved.status, 200, JSON.stringify(approvedPayload));
    assert.equal(approvedPayload.data.task.status, "completed");
    assert.equal(approvedPayload.data.task.approval.approvedByName, "Operations Owner");
    assert.match(approvedPayload.data.task.approval.approverPhotoUrl, /\/api\/v1\/staff\/files\//u);
    assert.match(approvedPayload.data.task.approval.approverSignatureUrl, /\/api\/v1\/staff\/files\//u);

    const workerWorkspace = await staffFetch(baseUrl, "/api/v1/staff/workspace", worker);
    const workspacePayload = await workerWorkspace.json();
    const completed = workspacePayload.data.tasks.find((item) => item.id === task.id);
    assert.equal(completed.status, "completed");
    assert.equal(workspacePayload.data.directory.some((person) => person.email === "owner@example.com"), true);
    assert.equal(workspacePayload.data.directory.some((person) => person.whatsappNumber === "+231771234567"), true);

    const signatureFile = await staffFetch(baseUrl, completed.approval.approverSignatureUrl, worker);
    assert.equal(signatureFile.status, 200);
    assert.equal(await signatureFile.text(), "signed-by-owner");
    const publicFileAttempt = await fetch(`${baseUrl}${completed.approval.approverSignatureUrl}`);
    assert.equal(publicFileAttempt.status, 401);
    assert.equal(whatsappCalls.at(-1).to, "+231771234567");
  }, { whatsapp });
});

test("admin allocates tasks while location managers create and approve employee work", async () => {
  await withServer(async (baseUrl) => {
    const managerInvite = await inviteEmployee(baseUrl, {
      name: "Samuel Cooper",
      email: "samuel.manager@example.com",
      role: "liberia_manager",
      country: "Liberia",
      locations: ["liberia"]
    });
    const manager = await acceptInvitation(baseUrl, managerInvite.token);
    const workerInvite = await inviteEmployee(baseUrl, {
      name: "Martha Kromah",
      email: "martha.operations@example.com",
      role: "liberia_staff",
      country: "Liberia",
      locations: ["liberia"],
      managerId: manager.user.id
    });
    const worker = await acceptInvitation(baseUrl, workerInvite.token);

    const managerPhoto = await staffUpload(baseUrl, "/api/v1/staff/profile/files/profile_photo", manager, {
      name: "manager.png", type: "image/png", contents: Buffer.from("manager-photo")
    });
    assert.equal(managerPhoto.status, 201, await managerPhoto.text());
    const managerSignature = await staffUpload(baseUrl, "/api/v1/staff/profile/files/signature", manager, {
      name: "manager-signature.png", type: "image/png", contents: Buffer.from("manager-signature")
    });
    assert.equal(managerSignature.status, 201, await managerSignature.text());
    await completeAndApproveOnboarding(baseUrl, worker, manager, { uploadReviewerIdentity: false });

    const created = await fetch(`${baseUrl}/api/v1/admin/tasks`, json("POST", {
      title: "Prepare export batch records",
      location: "liberia",
      type: "quality",
      priority: "urgent",
      scopeOfWork: "Prepare the export batch record and attach a signed inspection document.",
      evidenceRequirements: ["document"]
    }, adminHeaders));
    const createdPayload = await created.json();
    assert.equal(created.status, 201, JSON.stringify(createdPayload));
    const task = createdPayload.data.task;
    assert.equal(task.createdByName, "Owner admin");
    assert.equal(task.assignedTo, "");

    const allocated = await fetch(`${baseUrl}/api/v1/admin/tasks/${task.id}`, json("PATCH", {
      assignedTo: worker.user.id,
      priority: "urgent"
    }, adminHeaders));
    const allocatedPayload = await allocated.json();
    assert.equal(allocated.status, 200, JSON.stringify(allocatedPayload));
    assert.equal(allocatedPayload.data.task.assignedTo, worker.user.id);

    const scopeFile = await fetch(`${baseUrl}/api/v1/admin/tasks/${task.id}/files`, {
      method: "POST",
      headers: {
        authorization: adminHeaders.authorization,
        "content-type": "application/pdf",
        "x-file-name": "export-batch-sow.pdf",
        "x-file-kind": "sow",
        "x-file-phase": "scope"
      },
      body: Buffer.from("admin-sow")
    });
    assert.equal(scopeFile.status, 201, await scopeFile.text());

    const adminQueue = await fetch(`${baseUrl}/api/v1/admin/tasks`, { headers: adminHeaders });
    const adminQueuePayload = await adminQueue.json();
    assert.equal(adminQueue.status, 200);
    assert.equal(adminQueuePayload.data.find((item) => item.id === task.id).attachments.length, 1);

    const managerCreated = await staffFetch(baseUrl, "/api/v1/staff/tasks", manager, {
      method: "POST",
      body: {
        title: "Confirm drying room records",
        location: "liberia",
        type: "quality",
        priority: "normal",
        assignedTo: worker.user.id,
        scopeOfWork: "Review the drying room log and report any missing temperature entries.",
        evidenceRequirements: ["photo"]
      }
    });
    const managerCreatedPayload = await managerCreated.json();
    assert.equal(managerCreated.status, 201, JSON.stringify(managerCreatedPayload));
    assert.equal(managerCreatedPayload.data.task.createdBy, manager.user.id);
    assert.equal(managerCreatedPayload.data.task.assignedTo, worker.user.id);

    const started = await staffFetch(baseUrl, `/api/v1/staff/tasks/${task.id}`, worker, {
      method: "PATCH", body: { status: "in_progress" }
    });
    assert.equal(started.status, 200, await started.text());
    const evidence = await staffUpload(baseUrl, `/api/v1/staff/tasks/${task.id}/files`, worker, {
      name: "signed-inspection.pdf",
      type: "application/pdf",
      kind: "document",
      phase: "completion",
      contents: Buffer.from("signed-inspection")
    });
    assert.equal(evidence.status, 201, await evidence.text());
    const submitted = await staffFetch(baseUrl, `/api/v1/staff/tasks/${task.id}/submit`, worker, {
      method: "POST", body: { submissionNote: "The signed export record is attached." }
    });
    assert.equal(submitted.status, 200, await submitted.text());

    const approved = await staffFetch(baseUrl, `/api/v1/staff/tasks/${task.id}/review`, manager, {
      method: "POST", body: { decision: "approve", reviewNote: "Export record verified." }
    });
    const approvedPayload = await approved.json();
    assert.equal(approved.status, 200, JSON.stringify(approvedPayload));
    assert.equal(approvedPayload.data.task.status, "completed");
    assert.equal(approvedPayload.data.task.approval.approvedBy, manager.user.id);
    assert.equal(approvedPayload.data.task.approval.approvedByName, "Samuel Cooper");
  });
});

test("staff invitations create secure individual sessions and enforce Liberia role boundaries", async () => {
  await withServer(async (baseUrl) => {
    const staffPage = await fetch(`${baseUrl}/staff`);
    assert.equal(staffPage.status, 200);
    assert.equal(staffPage.headers.get("referrer-policy"), "no-referrer");
    assert.equal(staffPage.headers.get("cache-control"), "no-store");
    assert.match(staffPage.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
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

    const reviewerInvite = await inviteEmployee(baseUrl, {
      name: "Samuel Cooper",
      email: "samuel.boundary@example.com",
      role: "liberia_manager",
      country: "Liberia",
      locations: ["liberia"]
    });
    const reviewer = await acceptInvitation(baseUrl, reviewerInvite.token);
    await completeAndApproveOnboarding(baseUrl, session, reviewer);

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
    await completeAndApproveOnboarding(baseUrl, counter, manager);

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
