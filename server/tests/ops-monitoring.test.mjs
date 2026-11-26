import test from "node:test";
import assert from "node:assert/strict";
import { runExecutiveVisualsMonitoring } from "../ops-monitoring.mjs";

const webhook = "https://hooks.example.test/services/opaque";
const health = "https://executive-visuals-staging.onrender.com/api/health";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("synthetic alert uses HTTPS, refuses redirects and confirms only a successful HTTP response", async () => {
  let request;
  const result = await runExecutiveVisualsMonitoring({
    webhookUrl: webhook,
    testAlert: true,
    now: () => new Date("2026-11-26T10:00:00.000Z"),
    fetchImpl: async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return new Response(null, { status: 202 }); }
  });
  assert.equal(result.result, "alert_delivery_confirmed");
  assert.equal(result.httpStatus, 202);
  assert.equal(request.url, webhook);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.body.event, "monitoring.test");
  assert.equal(request.body.severity, "info");
});

test("health probe sends one bounded critical alert for unhealthy checks", async () => {
  const calls = [];
  const result = await runExecutiveVisualsMonitoring({
    healthUrl: health,
    webhookUrl: webhook,
    now: () => new Date("2026-11-26T10:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      if (url === health) return json({ status: "unhealthy", checks: [{ name: "database", status: "failed" }] }, 503);
      return new Response("ok", { status: 200 });
    }
  });
  assert.equal(result.result, "health_failure_alerted");
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.event, "health.check.failed");
  assert.equal(calls[1].body.severity, "critical");
  assert.deepEqual(calls[1].body.details.failedChecks, ["database"]);
  assert.equal(calls[1].options.redirect, "error");
});

test("healthy probe never sends a notification", async () => {
  const calls = [];
  const result = await runExecutiveVisualsMonitoring({
    healthUrl: health,
    webhookUrl: webhook,
    fetchImpl: async url => { calls.push(url); return json({ ok: true, status: "healthy", checks: [] }); }
  });
  assert.equal(result.result, "healthy");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [health]);
});

test("invalid JSON and oversized health responses are converted into safe alert details", async () => {
  for (const response of [
    new Response("not-json", { status: 200 }),
    new Response("x".repeat(64 * 1024 + 1), { status: 200 })
  ]) {
    const calls = [];
    const result = await runExecutiveVisualsMonitoring({
      healthUrl: health,
      webhookUrl: webhook,
      fetchImpl: async url => { calls.push(url); return url === health ? response : new Response(null, { status: 200 }); }
    });
    assert.equal(result.result, "health_failure_alerted");
    assert.equal(calls.length, 2);
    assert.ok(["invalid_json", "probe_failed"].includes(result.reportedStatus));
    assert.equal(JSON.stringify(result).includes("not-json"), false);
  }
});

test("rejects insecure or credential-bearing endpoints before making network calls", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return new Response(null, { status: 200 }); };
  await assert.rejects(() => runExecutiveVisualsMonitoring({ webhookUrl: "http://hooks.example.test", testAlert: true, fetchImpl }), { code: "MONITORING_ENDPOINT_INVALID" });
  await assert.rejects(() => runExecutiveVisualsMonitoring({ webhookUrl: "https://user:secret@hooks.example.test/x", testAlert: true, fetchImpl }), { code: "MONITORING_ENDPOINT_INVALID" });
  await assert.rejects(() => runExecutiveVisualsMonitoring({ healthUrl: "http://localhost/health", webhookUrl: webhook, fetchImpl }), { code: "MONITORING_ENDPOINT_INVALID" });
  assert.equal(called, false);
});

test("webhook delivery failure is explicit and response bodies are never included in errors", async () => {
  await assert.rejects(() => runExecutiveVisualsMonitoring({
    webhookUrl: webhook,
    testAlert: true,
    fetchImpl: async () => new Response("private-response-detail", { status: 500 })
  }), error => error.code === "MONITORING_ALERT_DELIVERY_FAILED" && !error.message.includes("private-response-detail"));
});
