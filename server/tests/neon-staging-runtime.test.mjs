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
