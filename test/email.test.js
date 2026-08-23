import assert from "node:assert/strict";
import test from "node:test";
import {
  EmailConfigurationError,
  EmailDeliveryError,
  InvitationEmailService
} from "../server/email.js";

const invitation = {
  user: {
    name: "Martha Kromah",
    email: "martha@example.com",
    role: "liberia_staff",
    roleLabel: "Liberia warehouse staff",
    locations: ["liberia"]
  },
  invitationUrl: "https://sevenroots.example/staff?invite=one-time-token",
  invitationId: "invite_123",
  expiresAt: "2026-08-23T18:00:00.000Z"
};

test("Resend adapter sends branded employee invitations with an idempotency key", async () => {
  const calls = [];
  const service = new InvitationEmailService({
    apiKey: "re_test_secret",
    from: "SEVEN ROOTS <staff@updates.sevenroots.example>",
    replyTo: "owner@sevenroots.example",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ id: "email_123" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.deepEqual(service.status(), {
    provider: "resend",
    configured: true,
    from: "SEVEN ROOTS <staff@updates.sevenroots.example>",
    replyTo: "owner@sevenroots.example",
    missingSettings: []
  });
  const result = await service.sendStaffInvitation(invitation);
  assert.equal(result.provider, "resend");
  assert.equal(result.messageId, "email_123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].options.headers.authorization, "Bearer re_test_secret");
  assert.equal(calls[0].options.headers["idempotency-key"], "staff-invitation-invite_123");
  const payload = JSON.parse(calls[0].options.body);
  assert.deepEqual(payload.to, ["martha@example.com"]);
  assert.equal(payload.reply_to, "owner@sevenroots.example");
  assert.match(payload.subject, /SEVEN ROOTS/u);
  assert.match(payload.html, /Activate staff account/u);
  assert.match(payload.text, /one-time-token/u);
});

test("Resend adapter sends a branded one-time staff password without placing it in a URL", async () => {
  const calls = [];
  const service = new InvitationEmailService({
    apiKey: "re_test_secret",
    from: "SEVEN ROOTS <staff@updates.sevenroots.example>",
    replyTo: "owner@sevenroots.example",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ id: "email_temporary_123" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const temporaryPassword = "SR-one-time-password-12345";
  const result = await service.sendStaffTemporaryPassword({
    user: invitation.user,
    temporaryPassword,
    temporaryPasswordId: "temporary_123",
    expiresAt: "2026-08-23T18:30:00.000Z",
    staffUrl: "https://sevenroots.example/staff"
  });
  assert.equal(result.messageId, "email_temporary_123");
  assert.equal(calls[0].options.headers["idempotency-key"], "staff-temporary-password-temporary_123");
  const payload = JSON.parse(calls[0].options.body);
  assert.deepEqual(payload.to, ["martha@example.com"]);
  assert.match(payload.subject, /one-time/u);
  assert.match(payload.text, new RegExp(temporaryPassword, "u"));
  assert.match(payload.html, /Create your private password|create a private password/iu);
  assert.equal(payload.text.includes(`?password=${temporaryPassword}`), false);
  assert.deepEqual(payload.tags, [{ name: "category", value: "staff_password_recovery" }]);
});

test("email adapter reports missing secure settings without making a provider request", async () => {
  const service = new InvitationEmailService({ apiKey: "", from: "", fetch: async () => assert.fail("fetch must not run") });
  await assert.rejects(() => service.sendStaffInvitation(invitation), (error) => {
    assert.equal(error instanceof EmailConfigurationError, true);
    assert.deepEqual(error.missing, ["RESEND_API_KEY", "EMAIL_FROM"]);
    return true;
  });
});

test("email adapter converts provider rejections into a safe delivery error", async () => {
  const service = new InvitationEmailService({
    apiKey: "re_test_secret",
    from: "SEVEN ROOTS <staff@updates.sevenroots.example>",
    fetch: async () => new Response(JSON.stringify({ message: "Sender domain is not verified" }), {
      status: 422,
      headers: { "content-type": "application/json" }
    })
  });
  await assert.rejects(() => service.sendStaffInvitation(invitation), (error) => {
    assert.equal(error instanceof EmailDeliveryError, true);
    assert.equal(error.status, 422);
    assert.equal(error.message, "Sender domain is not verified");
    return true;
  });
});
