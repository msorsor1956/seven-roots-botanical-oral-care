const RESEND_EMAIL_URL = "https://api.resend.com/emails";

const cleanText = (value, maxLength = 240) => String(value ?? "")
  .normalize("NFKC")
  .replace(/[\u0000-\u001F\u007F]/gu, " ")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, maxLength);

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const formatExpiry = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "within 72 hours";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(date) + " UTC";
};

const senderAddress = (value) => {
  const match = String(value || "").match(/<([^<>]+)>\s*$/u);
  return cleanText(match?.[1] || value, 254).toLowerCase();
};

const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(senderAddress(value));

export class EmailConfigurationError extends Error {
  constructor(message, missing = []) {
    super(message);
    this.code = "email_not_configured";
    this.missing = missing;
  }
}

export class EmailDeliveryError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.code = "email_delivery_failed";
    this.status = status;
  }
}

export class InvitationEmailService {
  constructor(options = {}) {
    this.apiKey = cleanText(options.apiKey ?? process.env.RESEND_API_KEY, 512);
    this.from = cleanText(options.from ?? process.env.EMAIL_FROM, 320);
    this.replyTo = cleanText(options.replyTo ?? process.env.EMAIL_REPLY_TO, 254);
    this.fetch = options.fetch || globalThis.fetch;
  }

  get configured() {
    return this.status().configured;
  }

  status() {
    const missingSettings = [];
    if (!this.apiKey) missingSettings.push("RESEND_API_KEY");
    if (!this.from || !validEmail(this.from)) missingSettings.push("EMAIL_FROM");
    if (this.replyTo && !validEmail(this.replyTo)) missingSettings.push("EMAIL_REPLY_TO");
    return {
      provider: "resend",
      configured: missingSettings.length === 0,
      from: this.from || null,
      replyTo: this.replyTo || null,
      missingSettings
    };
  }

  #assertConfigured() {
    const status = this.status();
    if (!status.configured) {
      throw new EmailConfigurationError("Employee invitation email is not configured.", status.missingSettings);
    }
  }

  async sendStaffInvitation({ user, invitationUrl, expiresAt, invitationId }) {
    this.#assertConfigured();
    const url = new URL(invitationUrl);
    if (!["https:", "http:"].includes(url.protocol)) throw new EmailDeliveryError("The invitation URL is not valid.", 422);
    const safeName = cleanText(user?.name, 120) || "Team member";
    const recipient = cleanText(user?.email, 254).toLowerCase();
    if (!validEmail(recipient)) throw new EmailDeliveryError("The employee email address is not valid.", 422);
    const expiry = formatExpiry(expiresAt);
    const role = cleanText(user?.roleLabel || user?.role, 100);
    const locations = Array.isArray(user?.locations)
      ? user.locations.map((location) => location === "us" ? "U.S. fulfillment" : "Liberia warehouse").join(", ")
      : "SEVEN ROOTS operations";
    const subject = "Your SEVEN ROOTS staff invitation";
    const text = [
      `Hello ${safeName},`,
      "",
      "You have been invited to the SEVEN ROOTS staff operations portal.",
      role ? `Role: ${role}` : "",
      locations ? `Location access: ${locations}` : "",
      "",
      `Activate your account: ${url.toString()}`,
      `This one-time link expires ${expiry}.`,
      "",
      "If you were not expecting this invitation, do not open the link and contact the SEVEN ROOTS owner."
    ].join("\n");
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f8f4ec;color:#24251f;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8f4ec;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;border:1px solid #d9d4c9;background:#ffffff">
        <tr><td style="padding:22px 28px;background:#173d32;color:#f2e8d8">
          <strong style="font-size:16px;letter-spacing:.12em">SEVEN ROOTS</strong><br>
          <span style="font-size:10px;letter-spacing:.15em">STAFF OPERATIONS</span>
        </td></tr>
        <tr><td style="padding:38px 28px">
          <p style="margin:0 0 10px;color:#c86c3a;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">Private employee access</p>
          <h1 style="margin:0 0 22px;font-family:Georgia,'Times New Roman',serif;font-size:38px;font-weight:500;line-height:1.08">Welcome to the team, ${escapeHtml(safeName)}.</h1>
          <p style="margin:0 0 24px;color:#5f655f;font-size:15px;line-height:1.65">You have been invited to the SEVEN ROOTS staff operations portal.</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 26px;border-collapse:collapse">
            <tr><td style="padding:10px 0;border-bottom:1px solid #e7e2d9;color:#6c716b;font-size:12px">Role</td><td align="right" style="padding:10px 0;border-bottom:1px solid #e7e2d9;font-size:12px;font-weight:700">${escapeHtml(role || "Staff member")}</td></tr>
            <tr><td style="padding:10px 0;border-bottom:1px solid #e7e2d9;color:#6c716b;font-size:12px">Location</td><td align="right" style="padding:10px 0;border-bottom:1px solid #e7e2d9;font-size:12px;font-weight:700">${escapeHtml(locations)}</td></tr>
          </table>
          <a href="${escapeHtml(url.toString())}" style="display:inline-block;padding:15px 22px;border-radius:8px;background:#173d32;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:.06em;text-decoration:none">Activate staff account</a>
          <p style="margin:22px 0 0;color:#6c716b;font-size:12px;line-height:1.6">This one-time link expires ${escapeHtml(expiry)}. If the button does not work, copy this address into your browser:</p>
          <p style="margin:8px 0 0;overflow-wrap:anywhere;color:#173d32;font-size:11px;line-height:1.55">${escapeHtml(url.toString())}</p>
        </td></tr>
        <tr><td style="padding:20px 28px;background:#f2e8d8;color:#6c716b;font-size:11px;line-height:1.55">If you were not expecting this invitation, do not open the link. Contact the SEVEN ROOTS owner.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

    let response;
    try {
      response = await this.fetch(RESEND_EMAIL_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": `staff-invitation-${cleanText(invitationId, 80)}`
        },
        body: JSON.stringify({
          from: this.from,
          to: [recipient],
          subject,
          html,
          text,
          ...(this.replyTo ? { reply_to: this.replyTo } : {}),
          tags: [{ name: "category", value: "staff_invitation" }]
        })
      });
    } catch {
      throw new EmailDeliveryError("The invitation email provider could not be reached.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new EmailDeliveryError(cleanText(payload.message || "The invitation email provider rejected the request.", 240), response.status >= 500 ? 502 : 422);
    }
    const messageId = cleanText(payload.id, 120);
    if (!messageId) throw new EmailDeliveryError("The invitation email provider returned no delivery ID.");
    return { provider: "resend", messageId, sentAt: new Date().toISOString() };
  }
}

export const createInvitationEmailService = (options) => new InvitationEmailService(options);
