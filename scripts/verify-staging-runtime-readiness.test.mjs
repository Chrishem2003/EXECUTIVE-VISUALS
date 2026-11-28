import test from "node:test";
import assert from "node:assert/strict";
import { verifyStagingRuntime } from "./verify-staging-runtime-readiness.mjs";

const now = Date.parse("2026-11-28T09:30:00.000Z");
const env = () => ({
  EXECUTIVE_VISUALS_HEALTH_URL: "https://executive-visuals-cloud-staging.onrender.com/api/health",
  SUPABASE_STAGING_URL: "https://bokxljngydmqrmktofwm.supabase.co",
  SUPABASE_STAGING_SECRET_KEY: "sb_secret_test_only"
});
const health = () => ({
  status: "ok",
  database: "postgresql",
  authMode: "supabase",
  authSession: { configurationReady: true },
  cloudMedia: { ready: true, storage: "private" },
  privateAssetEgress: { enabled: true, financeActorVerified: true },
  billing: { paddlePesapal: {
    ready: true,
    paddle: { environment: "sandbox" },
    pesapal: { environment: "sandbox" }
  }},
  cloudVideoWorker: { enabled: true, runtimeMode: "separate-process", inProcessSupervisorActive: false }
});
function fetchFor({ payload = health(), heartbeats = [{ status: "healthy", heartbeat_at: new Date(now - 30000).toISOString() }] } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed.toString(), headers: options.headers || {} });
    if (parsed.pathname === "/api/health") return new Response(JSON.stringify(payload), { status: 200 });
    if (parsed.pathname === "/rest/v1/cloud_worker_heartbeats") return new Response(JSON.stringify(heartbeats), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

test("staging runtime is READY only when PostgreSQL, private storage, sandbox billing and a live worker are verified", async () => {
  const mock = fetchFor();
  const result = await verifyStagingRuntime({ env: env(), fetchImpl: mock.fetchImpl, now: () => now });
  assert.equal(result.state, "READY");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.workerHeartbeatCount, 1);
  assert.equal(result.newestHeartbeatAgeSeconds, 30);
  assert.equal(result.secretValuesExposed, false);
  assert.ok(mock.calls.some(call => call.url.includes("/api/health")));
  assert.ok(mock.calls.some(call => call.url.includes("/rest/v1/cloud_worker_heartbeats")));
});

test("SQLite application persistence blocks staging readiness", async () => {
  const payload = health();
  payload.database = "sqlite";
  const mock = fetchFor({ payload });
  const result = await verifyStagingRuntime({ env: env(), fetchImpl: mock.fetchImpl, now: () => now });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.blockers.includes("APP_DATABASE_POSTGRES"));
});

test("missing worker heartbeat blocks staging readiness even when the health payload is green", async () => {
  const mock = fetchFor({ heartbeats: [] });
  const result = await verifyStagingRuntime({ env: env(), fetchImpl: mock.fetchImpl, now: () => now });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.blockers.includes("FRESH_CLOUD_WORKER_HEARTBEAT"));
});

test("unverified private storage and live provider credentials block the staging gate", async () => {
  const payload = health();
  payload.cloudMedia = { ready: false, storage: "unverified" };
  payload.billing.paddlePesapal.paddle.environment = "live";
  const mock = fetchFor({ payload });
  const result = await verifyStagingRuntime({ env: env(), fetchImpl: mock.fetchImpl, now: () => now });
  assert.ok(result.blockers.includes("PRIVATE_CLOUD_STORAGE_READY"));
  assert.ok(result.blockers.includes("PADDLE_PESAPAL_SANDBOX_READY"));
});

test("rejects unapproved Render and Supabase URLs before making a network request", async () => {
  const configuration = env();
  configuration.EXECUTIVE_VISUALS_HEALTH_URL = "https://executive-visuals.onrender.com/api/health";
  const mock = fetchFor();
  const result = await verifyStagingRuntime({ env: configuration, fetchImpl: mock.fetchImpl, now: () => now });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.blockers.includes("HEALTH_URL_NOT_APPROVED_STAGING"));
  assert.equal(mock.calls.length, 0);
});

test("missing runtime secrets are reported by name only", async () => {
  const result = await verifyStagingRuntime({ env: {}, fetchImpl: async () => { throw new Error("must not call"); } });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.missing.includes("SUPABASE_STAGING_SECRET_KEY"));
  assert.equal(result.secretValuesExposed, false);
  assert.equal(JSON.stringify(result).includes("sb_secret"), false);
});
