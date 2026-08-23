const clean = (value, maxLength = 240) => String(value ?? "")
  .normalize("NFKC")
  .replace(/[\u0000-\u001F\u007F]/gu, " ")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, maxLength);

const whatsappDigits = (value) => String(value || "").replace(/\D/gu, "").slice(0, 15);

export class WhatsAppConfigurationError extends Error {
  constructor(missing = []) {
    super("WhatsApp task notifications are not configured.");
    this.code = "whatsapp_not_configured";
    this.missing = missing;
  }
}

export class WhatsAppDeliveryError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.code = "whatsapp_delivery_failed";
    this.status = status;
  }
}

export class WhatsAppService {
  constructor(options = {}) {
    this.accessToken = clean(options.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN, 512);
    this.phoneNumberId = clean(options.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID, 80);
    this.graphVersion = clean(options.graphVersion ?? process.env.WHATSAPP_GRAPH_VERSION, 20);
    this.taskTemplate = clean(options.taskTemplate ?? process.env.WHATSAPP_TASK_TEMPLATE, 120);
    this.templateLanguage = clean(options.templateLanguage ?? process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "en_US", 20);
    this.fetch = options.fetch || globalThis.fetch;
  }

  get configured() {
    return this.status().configured;
  }

  status() {
    const missingSettings = [];
    if (!this.accessToken) missingSettings.push("WHATSAPP_ACCESS_TOKEN");
    if (!/^\d{5,30}$/u.test(this.phoneNumberId)) missingSettings.push("WHATSAPP_PHONE_NUMBER_ID");
    if (!/^v\d+\.\d+$/u.test(this.graphVersion)) missingSettings.push("WHATSAPP_GRAPH_VERSION");
    if (!/^[a-z0-9_]{3,120}$/u.test(this.taskTemplate)) missingSettings.push("WHATSAPP_TASK_TEMPLATE");
    return {
      provider: "meta_whatsapp_cloud_api",
      configured: missingSettings.length === 0,
      phoneNumberId: this.phoneNumberId ? `…${this.phoneNumberId.slice(-4)}` : null,
      graphVersion: this.graphVersion || null,
      taskTemplate: this.taskTemplate || null,
      templateLanguage: this.templateLanguage,
      missingSettings
    };
  }

  async sendTaskUpdate({ to, recipientName, taskTitle, taskStatus }) {
    const status = this.status();
    if (!status.configured) throw new WhatsAppConfigurationError(status.missingSettings);
    const recipient = whatsappDigits(to);
    if (recipient.length < 8) throw new WhatsAppDeliveryError("The employee does not have a valid WhatsApp number.", 422);
    const endpoint = `https://graph.facebook.com/${this.graphVersion}/${this.phoneNumberId}/messages`;
    let response;
    try {
      response = await this.fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipient,
          type: "template",
          template: {
            name: this.taskTemplate,
            language: { code: this.templateLanguage },
            components: [{
              type: "body",
              parameters: [
                { type: "text", text: clean(recipientName, 120) || "Team member" },
                { type: "text", text: clean(taskTitle, 140) || "Operations task" },
                { type: "text", text: clean(taskStatus, 80) || "updated" }
              ]
            }]
          }
        })
      });
    } catch {
      throw new WhatsAppDeliveryError("The WhatsApp provider could not be reached.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new WhatsAppDeliveryError(clean(payload.error?.message || "WhatsApp rejected the notification.", 240), response.status >= 500 ? 502 : 422);
    }
    const messageId = clean(payload.messages?.[0]?.id, 180);
    if (!messageId) throw new WhatsAppDeliveryError("WhatsApp returned no message ID.");
    return { provider: "meta_whatsapp_cloud_api", messageId, sentAt: new Date().toISOString(), recipientLast4: recipient.slice(-4) };
  }
}

export const createWhatsAppService = (options) => new WhatsAppService(options);
export const toWhatsAppDigits = whatsappDigits;
