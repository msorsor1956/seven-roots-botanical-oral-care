import assert from "node:assert/strict";
import test from "node:test";
import { WhatsAppConfigurationError, WhatsAppService } from "../server/whatsapp.js";

test("WhatsApp Cloud API adapter sends an approved task-update template", async () => {
  const calls = [];
  const service = new WhatsAppService({
    accessToken: "test-access-token",
    phoneNumberId: "123456789012345",
    graphVersion: "v23.0",
    taskTemplate: "seven_roots_task_update",
    templateLanguage: "en_US",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.test123" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const result = await service.sendTaskUpdate({
    to: "+231 77 123 4567",
    recipientName: "Martha Kromah",
    taskTitle: "Inspect export packing run",
    taskStatus: "pending approval"
  });
  assert.equal(result.messageId, "wamid.test123");
  assert.equal(calls[0].url, "https://graph.facebook.com/v23.0/123456789012345/messages");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-access-token");
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.messaging_product, "whatsapp");
  assert.equal(payload.to, "231771234567");
  assert.equal(payload.template.name, "seven_roots_task_update");
  assert.deepEqual(payload.template.components[0].parameters.map((parameter) => parameter.text), [
    "Martha Kromah",
    "Inspect export packing run",
    "pending approval"
  ]);
});

test("WhatsApp adapter reports every missing secure provider setting", async () => {
  const service = new WhatsAppService({ accessToken: "", phoneNumberId: "", graphVersion: "", taskTemplate: "" });
  await assert.rejects(() => service.sendTaskUpdate({ to: "+13175550100" }), (error) => {
    assert.equal(error instanceof WhatsAppConfigurationError, true);
    assert.deepEqual(error.missing, [
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_GRAPH_VERSION",
      "WHATSAPP_TASK_TEMPLATE"
    ]);
    return true;
  });
});
