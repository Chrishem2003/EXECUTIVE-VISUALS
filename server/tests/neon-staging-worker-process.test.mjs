import test from "node:test";
import assert from "node:assert/strict";
import { startNeonStagingWorkerProcess } from "../neon-staging-worker-process.mjs";

const baseEnv = {
  NEON_STAGING_WORKER_PROCESS_ENABLED: "true",
  NEON_STAGING_RUNTIME_ENABLED: "true",
  NEON_STAGING_BRANCH_NAME: "executive-visuals-staging",
  NEON_CUSTOMER_CREDITS_PER_USD: "100",
  NEON_CUSTOMER_TARGET_MARGIN_BPS: "3000",
  NEON_CUSTOMER_PAYMENT_FEE_BPS: "0",
  NEON_CUSTOMER_SUPPORT_RESERVE_BPS: "0"
};
const provider = {
  adapters: [{ provider: "fal", model: "fal-ai/wan/v2.7/text-to-video" }],
  storage: { async checkReadiness() { return { ready: true }; } },
  authorizeJob: async () => true
};
function processStub() {
  const handlers = new Map();
  return {
    handlers, output: "", exitCode: 0,
    once(event, handler) { handlers.set(event, handler); },
    removeListener(event, handler) { if (handlers.get(event) === handler) handlers.delete(event); },
    stdout: { write(value) { this.last = value; } },
    stderr: { write(value) { this.last = value; } }
  };
}

test("dedicated Neon worker remains inert until its explicit process gate is enabled", async () => {
  let providerCalls = 0;
  await assert.rejects(startNeonStagingWorkerProcess({
    env: { ...baseEnv, NEON_STAGING_WORKER_PROCESS_ENABLED: "false" },
    processRef: null,
    createProviderAdapters() { providerCalls++; return provider; }
  }), /NEON_STAGING_WORKER_PROCESS_ENABLED=true/);
  assert.equal(providerCalls, 0);
});

test("starts only after durable Neon worker and private-storage readiness pass", async () => {
  const proc = processStub();
  let received, started = 0, closed = 0;
  const runtime = {
    async checkReadiness() { return { workerReady: true, storage: { ready: true }, branch: "executive-visuals-staging" }; },
    async startVideoWorker() { started++; return { started: true }; },
    async close() { closed++; }
  };
  const worker = await startNeonStagingWorkerProcess({
    env: baseEnv, processRef: proc, workerId: "worker-test",
    createProviderAdapters() { return provider; },
    async createRuntime(args) { received = args; return runtime; }
  });
  assert.equal(started, 1);
  assert.equal(received.includeStorage, true);
  assert.equal(received.quoteCustomerCredits({ currency: "USD", amountMicros: 1250000 }), 179);
  assert.deepEqual(received.workerAdapters, provider.adapters);
  assert.equal(received.workerAuthorizeJob, provider.authorizeJob);
  assert.equal(received.workerId, "worker-test");
  assert.equal(proc.handlers.has("SIGTERM"), true);
  assert.match(proc.stdout.last, /worker-test/);
  await worker.close();
  assert.equal(closed, 1);
  assert.equal(proc.handlers.size, 0);
});

test("fails closed and closes the runtime when staging readiness is incomplete", async () => {
  let closed = 0;
  await assert.rejects(startNeonStagingWorkerProcess({
    env: baseEnv, processRef: null,
    createProviderAdapters() { return provider; },
    async createRuntime() {
      return {
        async checkReadiness() { return { workerReady: false, storage: { ready: false } }; },
        async close() { closed++; }
      };
    }
  }), /PostgreSQL, financial ledger, queue and private storage/);
  assert.equal(closed, 1);
});

test("validates worker polling and recovery limits before starting", async () => {
  let runtimeCreated = false;
  await assert.rejects(startNeonStagingWorkerProcess({
    env: { ...baseEnv, NEON_WORKER_IDLE_POLL_MS: "1" },
    processRef: null,
    createProviderAdapters() { return provider; },
    async createRuntime() { runtimeCreated = true; return {}; }
  }), /NEON_WORKER_IDLE_POLL_MS/);
  assert.equal(runtimeCreated, false);
});
