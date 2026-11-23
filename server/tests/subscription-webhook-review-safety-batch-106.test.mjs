import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";

const secret = "webhook-review-test-secret";
const owner = "11111111-1111-4111-8111-111111111111";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function service(fetchImpl) {
  return createFinancialIntelligenceApi({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-role-test",
    flutterwaveClientId: "client-test",
    flutterwaveClientSecret: "client-secret-test",
    webhookSecretHash: secret,
    billingEnabled: true,
    fetchImpl
  });
}

test("verified subscription cancellation is quarantined for exact admin reconciliation and never auto-revokes access", async () => {
  const rawBody = Buffer.from(JSON.stringify({
    event: "subscription.cancelled",
    data: {
      id: "provider-subscription-event-1",
      status: "deactivated",
      plan: { id: "provider-plan-1" },
      customer: { email: "creator@example.test" }
    }
  }));
  const signatureV4 = createHmac("sha256", secret).update(rawBody).digest("base64");
  const calls = [];
  let eventRecorded = false;

  const api = service(async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, method: options.method || "GET", body: options.body || null });

    if (target.includes("/payment_webhook_events?select=id,processing_status")) {
      return json(eventRecorded
        ? [{ id: "event-local-1", processing_status: "needs_review" }]
        : []);
    }
    if (target.endsWith("/payment_webhook_events") && options.method === "POST") {
      eventRecorded = true;
      return new Response(null, { status: 201 });
    }
    if (target.includes("/payment_webhook_events?provider=eq.flutterwave") && options.method === "PATCH") {
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected request: " + target);
  });

  const first = await api.handleWebhook({ rawBody, signatureV4 });
  assert.equal(first.status, 200);
  assert.equal(first.body.needsReview, true);
  assert.equal(first.body.message.includes("administrator reconciliation"), true);

  const inserted = calls.find(call => call.method === "POST" && call.target.endsWith("/payment_webhook_events"));
  assert.ok(inserted, "verified callback must be durably recorded");
  const stored = JSON.parse(inserted.body);
  assert.equal(stored.signature_verified, true);
  assert.equal(stored.processing_status, "received");
  assert.equal(stored.event_type, "subscription.cancelled");

  assert.equal(calls.some(call => call.target.includes("/rpc/")), false,
    "ambiguous provider cancellation must not invoke entitlement or subscription mutation RPCs");
  assert.equal(calls.some(call => call.target.includes("/customer_subscriptions") && call.method === "PATCH"), false,
    "webhook ingestion must not directly change a customer subscription");

  const beforeReplayCalls = calls.length;
  const replay = await api.handleWebhook({ rawBody, signatureV4 });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(calls.length, beforeReplayCalls + 1,
    "a previously quarantined event must be acknowledged without repeating reconciliation work");
});
