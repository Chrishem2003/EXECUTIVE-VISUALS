import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoWorkerComposition } from "../cloud-video-worker-composition.mjs";

const env = {
  CLOUD_VIDEO_WORKER_ENABLED: "true",
  RUNWAY_API_KEY: "test-key-not-used"
};
const base = {
  workerId: "video-worker-test",
  url: "https://example.supabase.co",
  serviceRoleKey: "test-service-role-key",
  env,
  fetchImpl: async () => {
    throw new Error("Network must not be called during composition.");
  },
  loadPrivateAsset: async () => null,
  ingestOutputs: async () => ({ assetIds: [] }),
  resolveActualCost: async () => null
};

test("cloud video composition is disabled unless explicitly opted in", () => {
  assert.throws(
    () => createCloudVideoWorkerComposition({ ...base, env: { ...env, CLOUD_VIDEO_WORKER_ENABLED: "false" } }),
    /explicit CLOUD_VIDEO_WORKER_ENABLED=true/
  );
});

test("cloud video composition requires private storage, output ingestion and cost evidence dependencies", () => {
  assert.throws(() => createCloudVideoWorkerComposition({ ...base, loadPrivateAsset: undefined }), /private asset reader/);
  assert.throws(() => createCloudVideoWorkerComposition({ ...base, ingestOutputs: undefined }), /private output ingestion/);
  assert.throws(() => createCloudVideoWorkerComposition({ ...base, resolveActualCost: undefined }), /task-level cost evidence/);
});

test("cloud video composition wires queue, Postgres ledger, Runway and injected private services without network I/O", () => {
  const worker = createCloudVideoWorkerComposition(base);
  assert.equal(typeof worker.runCycle, "function");
  assert.equal(typeof worker.recoverExpired, "function");
});
