import test from "node:test";
import assert from "node:assert/strict";
import { evaluateReadiness } from "../readiness.mjs";

test("development liveness can be ready without hosted-only services", () => {
  assert.deepEqual(evaluateReadiness({ nodeEnv: "development", authMode: "local" }), {
    ready: true, status: "ready", checks: []
  });
});

test("production readiness fails closed while hosted session and private media gates are incomplete", () => {
  const result = evaluateReadiness({
    nodeEnv: "production", authMode: "supabase",
    requirePersistentDataDir: true, dataDirExists: true,
    databaseWithinDataDir: true, mediaWithinDataDir: true
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.checks.map(check => check.id), [
    "external-auth-mode", "server-managed-session", "private-media-lifecycle", "persistent-volume"
  ]);
  assert.equal(result.checks.every(check => check.status === "passed" || check.status === "blocked"), true);
  assert.equal(JSON.stringify(result).includes("/mnt/"), false);
});

test("production readiness rejects local auth and missing persistent storage", () => {
  const result = evaluateReadiness({
    nodeEnv: "production", authMode: "local",
    requirePersistentDataDir: false, dataDirExists: false,
    databaseWithinDataDir: false, mediaWithinDataDir: false
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.find(check => check.id === "external-auth-mode").status, "blocked");
  assert.equal(result.checks.find(check => check.id === "persistent-volume").status, "blocked");
});

test("cloud timeline readiness validates auth mode and server-side credentials without exposing them", () => {
  const result = evaluateReadiness({
    nodeEnv: "development", authMode: "local", cloudTimelineApiEnabled: true,
    supabaseUrl: "http://example.test", supabasePublishableKey: "", supabaseServiceRoleKey: "secret"
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.find(check => check.id === "cloud-timeline-auth").status, "blocked");
  assert.equal(result.checks.find(check => check.id === "cloud-timeline-credentials").status, "blocked");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("enabled gateways must be configured before readiness passes", () => {
  const result = evaluateReadiness({
    nodeEnv: "development", imageGatewayEnabled: true, imageGatewayConfigured: false,
    textGatewayEnabled: true, textGatewayConfigured: true
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.find(check => check.id === "image-gateway").status, "blocked");
  assert.equal(result.checks.find(check => check.id === "text-gateway").status, "passed");
});

test("a fully configured cloud timeline can pass its configuration checks in development", () => {
  const result = evaluateReadiness({
    nodeEnv: "development", authMode: "supabase", cloudTimelineApiEnabled: true,
    supabaseUrl: "https://project.example.test", supabasePublishableKey: "public-key",
    supabaseServiceRoleKey: "server-only-key"
  });
  assert.equal(result.ready, true);
  assert.equal(result.checks.every(check => check.status === "passed"), true);
});
