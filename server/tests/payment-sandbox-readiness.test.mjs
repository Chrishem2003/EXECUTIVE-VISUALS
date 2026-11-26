import test from "node:test";
import assert from "node:assert/strict";
import { verifyPaymentSandboxCredentials } from "../payment-sandbox-readiness.mjs";

const credentials = {
  paddleApiKey: "pdl_sdbx_sandbox_test_key_123456",
  pesapalConsumerKey: "pesapal-sandbox-consumer-key",
  pesapalConsumerSecret: "pesapal-sandbox-consumer-secret"
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("verifies Paddle and Pesapal credentials only through their fixed sandbox endpoints", async () => {
  const calls = [];
  const result = await verifyPaymentSandboxCredentials({
    ...credentials,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      if (url === "https://sandbox-api.paddle.com/event-types") return json({ data: [{ name: "transaction.completed" }, { name: "subscription.activated" }] });
      if (url === "https://cybqa.pesapal.com/pesapalv3/api/Auth/RequestToken") return json({ token: "sandbox-token-that-is-long-enough" });
      throw new Error("unexpected endpoint");
    }
  });
  assert.equal(result.result, "sandbox_credentials_verified");
  assert.deepEqual(result.paddle, { environment: "sandbox", eventTypes: 2, authenticated: true });
  assert.deepEqual(result.pesapal, { environment: "sandbox", tokenIssued: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, "Bearer " + credentials.paddleApiKey);
  assert.equal(calls[1].options.redirect, "error");
  assert.deepEqual(calls[1].body, { consumer_key: credentials.pesapalConsumerKey, consumer_secret: credentials.pesapalConsumerSecret });
});

test("rejects live or unrecognized Paddle keys before any provider request", async () => {
  let called = false;
  await assert.rejects(() => verifyPaymentSandboxCredentials({
    ...credentials,
    paddleApiKey: "pdl_live_test_key_123456",
    fetchImpl: async () => { called = true; return json({}); }
  }), { code: "PADDLE_SANDBOX_KEY_REQUIRED" });
  assert.equal(called, false);
});

test("rejects missing or malformed credentials without network access", async () => {
  let called = false;
  await assert.rejects(() => verifyPaymentSandboxCredentials({
    ...credentials,
    pesapalConsumerSecret: "",
    fetchImpl: async () => { called = true; return json({}); }
  }), { code: "PAYMENT_SANDBOX_CREDENTIAL_INVALID" });
  assert.equal(called, false);
});

test("rejects non-success provider responses without including response bodies", async () => {
  await assert.rejects(() => verifyPaymentSandboxCredentials({
    ...credentials,
    fetchImpl: async () => new Response("private-provider-error-detail", { status: 401 })
  }), error => error.code === "PAYMENT_SANDBOX_REQUEST_FAILED" && !error.message.includes("private-provider-error-detail"));
});

test("bounds provider response bodies and rejects malformed provider payloads", async () => {
  await assert.rejects(() => verifyPaymentSandboxCredentials({
    ...credentials,
    fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 })
  }), { code: "PAYMENT_SANDBOX_RESPONSE_TOO_LARGE" });
  await assert.rejects(() => verifyPaymentSandboxCredentials({
    ...credentials,
    fetchImpl: async () => new Response("not-json", { status: 200 })
  }), { code: "PAYMENT_SANDBOX_INVALID_JSON" });
});
