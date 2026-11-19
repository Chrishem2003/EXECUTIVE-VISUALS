import test from "node:test";
import assert from "node:assert/strict";
import { createNeonStagingRuntime } from "../neon-staging-runtime.mjs";

const env = {
  NEON_STAGING_RUNTIME_ENABLED: "true",
  NEON_STAGING_BRANCH_NAME: "executive-visuals-staging",
  NEON_DATABASE_URL: "postgresql://ev:secret@ep-staging-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require"
};

test("Neon runtime is opt-in and refuses an unapproved branch name", async () => {
  await assert.rejects(() => createNeonStagingRuntime({ env: { ...env, NEON_STAGING_RUNTIME_ENABLED: "false" }, pool: { query() {} } }), /disabled/);
  await assert.rejects(() => createNeonStagingRuntime({ env: { ...env, NEON_STAGING_BRANCH_NAME: "production" }, pool: { query() {} } }), /explicitly named/);
});

test("composes Neon queue, submission and financial adapters without network activity", async () => {
  const calls = [];
  let ended = 0;
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("to_regclass")) return { rows: [{ database_name: "neondb", jobs_ready: true, events_ready: true }] };
      if (sql.includes("get_video_financial_readiness_v1")) return { rows: [{ schema_ready: true, credit_ledger_ready: true, budget_ready: true, cost_ledger_ready: true, customer_credit_settlement_ready: true }] };
      if (sql.includes("to_regprocedure")) return { rows: [{ atomic_video_enqueue_ready: true }] };
      throw new Error("Unexpected query");
    },
    async end() { ended++; }
  };
  const runtime = await createNeonStagingRuntime({ env, pool });
  assert.equal(runtime.backend, "neon-postgres");
  assert.equal(runtime.branch, "executive-visuals-staging");
  assert.equal(typeof runtime.queue.claim, "function");
  assert.equal(typeof runtime.submissions.prepare, "function");
  assert.equal(typeof runtime.financials.reserve, "function");
  assert.equal(typeof runtime.customerCredits.settleJob, "function");
  assert.equal(typeof runtime.videoEnqueue.enqueueVideoGenerationJob, "function");
  assert.equal(calls.length, 0, "composition must not perform I/O");

  const status = await runtime.checkReadiness();
  assert.equal(status.ready, true);
  assert.equal(status.queue.ready, true);
  assert.equal(status.financials.ready, true);
  assert.equal(status.videoEnqueue.ready, true);
  assert.equal(calls.length, 3);

  await runtime.close();
  await runtime.close();
  assert.equal(ended, 1);
  await assert.rejects(() => runtime.checkReadiness(), /closed/);
});

test("readiness includes private storage when an adapter is explicitly supplied", async () => {
  const pool = {
    async query(sql) {
      if (sql.includes("to_regclass")) return { rows: [{ database_name: "neondb", jobs_ready: true, events_ready: true }] };
      if (sql.includes("get_video_financial_readiness_v1")) return { rows: [{ schema_ready: true, credit_ledger_ready: true, budget_ready: true, cost_ledger_ready: true, customer_credit_settlement_ready: true }] };
      if (sql.includes("to_regprocedure")) return { rows: [{ atomic_video_enqueue_ready: true }] };
      throw new Error("Unexpected query");
    },
    async end() {}
  };
  const storage = { async checkReadiness() { return { ready: false, storage: "private", provider: "neon-object-storage" }; } };
  const runtime = await createNeonStagingRuntime({ env, pool, storage });
  const status = await runtime.checkReadiness();
  assert.equal(status.ready, false);
  assert.equal(status.storage.ready, false);
  await runtime.close();
});


test("Neon runtime exposes the multi-shot approval bridge only with an explicit server credit quote policy", async () => {
  const pool = {
    async query(sql) {
      if (sql.includes("video_generation_approvals")) return { rows: [{ approvals_ready: true, shots_ready: true }] };
      if (sql.includes("to_regclass")) return { rows: [{ database_name: "neondb", jobs_ready: true, events_ready: true }] };
      if (sql.includes("get_video_financial_readiness_v1")) return { rows: [{ schema_ready: true, credit_ledger_ready: true, budget_ready: true, cost_ledger_ready: true, customer_credit_settlement_ready: true }] };
      if (sql.includes("to_regprocedure")) return { rows: [{ atomic_video_enqueue_ready: true }] };
      throw new Error("Unexpected query");
    },
    async connect() { throw new Error("No transaction should be opened during composition or readiness."); },
    async end() {}
  };
  const runtime = await createNeonStagingRuntime({ env, pool, quoteCustomerCredits: ({ amountMicros }) => Math.ceil(amountMicros / 10000) });
  assert.equal(typeof runtime.videoApprovals.approvals.register, "function");
  assert.equal(typeof runtime.videoApprovals.approvals.enqueue, "function");
  const status = await runtime.checkReadiness();
  assert.equal(status.videoApprovals.ready, true);
  assert.equal(status.applicationDispatchReady, false, "approval dispatch must remain blocked until a worker and private storage are configured");
  assert.equal(status.videoWorker.configured, false);
  assert.equal(status.storage, null);
  await runtime.close();
});

test("Neon worker is composed but cannot start before approval, financial and private-storage readiness", async () => {
  let ended = 0;
  let storageReady = false;
  const pool = {
    async query(sql) {
      if (sql.includes("to_regclass")) return { rows: [{ database_name: "neondb", jobs_ready: true, events_ready: true }] };
      if (sql.includes("get_video_financial_readiness_v1")) return { rows: [{ schema_ready: true, credit_ledger_ready: true, budget_ready: true, cost_ledger_ready: true, customer_credit_settlement_ready: true }] };
      if (sql.includes("to_regprocedure")) return { rows: [{ atomic_video_enqueue_ready: true }] };
      if (sql.includes("video_generation_approvals")) return { rows: [{ approvals_ready: true, shots_ready: true }] };
      throw new Error("Unexpected query");
    },
    async connect() { return { async query() { return { rows: [] }; }, release() {} }; },
    async end() { ended++; }
  };
  const storage = { async checkReadiness() { return { ready: storageReady, provider: "private-test-storage" }; } };
  const workerEnv = { ...env, NEON_STAGING_APPLICATION_DISPATCH_ENABLED: "true",
    CLOUD_VIDEO_WORKER_ENABLED: "true", VIDEO_GATEWAY_ENABLED: "true", VIDEO_GATEWAY_ALLOW_REMOTE: "true" };
  const adapter = { provider: "runway", model: "gen4.5",
    async submit() {}, async getStatus() {}, async ingestOutputs() { return { assetIds: [] }; },
    async resolveActualCost() { return { amount: 1, actualCredits: 1, currency: "USD", evidenceReference: "receipt" }; } };
  const runtime = await createNeonStagingRuntime({
    env: workerEnv, pool, storage, includeStorage: true,
    quoteCustomerCredits: () => 100,
    workerAdapters: [adapter], workerAuthorizeJob: async () => true, workerId: "neon-staging-worker"
  });
  assert.deepEqual(runtime.videoWorker.listSupported(), ["runway:gen4.5"]);
  const blocked = await runtime.checkReadiness();
  assert.equal(blocked.videoWorker.configured, true);
  assert.equal(blocked.videoWorker.running, false);
  assert.equal(blocked.applicationDispatchReady, false);
  await assert.rejects(runtime.startVideoWorker(), /private-storage readiness/);
  assert.equal(runtime.videoWorker !== null, true);
  await runtime.close();
  assert.equal(ended, 1);
});

test("Neon worker composition requires private storage and a complete authorization contract", async () => {
  const pool = { async query() { return { rows: [] }; }, async end() {} };
  const adapter = { provider: "runway", model: "gen4.5",
    async submit() {}, async getStatus() {}, async ingestOutputs() {}, async resolveActualCost() {} };
  await assert.rejects(createNeonStagingRuntime({
    env: { ...env, CLOUD_VIDEO_WORKER_ENABLED: "true", VIDEO_GATEWAY_ENABLED: "true", VIDEO_GATEWAY_ALLOW_REMOTE: "true" },
    pool, workerAdapters: [adapter], workerAuthorizeJob: async () => true, workerId: "worker"
  }), /private object storage/);
});

test("Neon approval dispatch readiness fails closed when the worker or private storage is absent", async () => {
  const pool = {
    async query(sql) {
      if (sql.includes("video_generation_approvals")) return { rows: [{ approvals_ready: true, shots_ready: true }] };
      if (sql.includes("to_regclass")) return { rows: [{ database_name: "neondb", jobs_ready: true, events_ready: true }] };
      if (sql.includes("get_video_financial_readiness_v1")) return { rows: [{ schema_ready: true, credit_ledger_ready: true, budget_ready: true, cost_ledger_ready: true, customer_credit_settlement_ready: true }] };
      if (sql.includes("to_regprocedure")) return { rows: [{ atomic_video_enqueue_ready: true }] };
      throw new Error("Unexpected query");
    },
    async end() {}
  };
  const runtime = await createNeonStagingRuntime({ env, pool,
    quoteCustomerCredits: () => 100 });
  const status = await runtime.checkReadiness();
  assert.equal(status.ready, true);
  assert.equal(status.videoApprovals.ready, true);
  assert.equal(status.applicationDispatchReady, false);
  assert.equal(status.videoWorker.configured, false);
  await assert.rejects(runtime.startVideoWorker(), /not configured/);
  await runtime.close();
});
