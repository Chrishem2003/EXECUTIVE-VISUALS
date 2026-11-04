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

test("cloud video composition requires authoritative task-level cost evidence", () => {
  assert.throws(() => createCloudVideoWorkerComposition({ ...base, resolveActualCost: undefined }), /task-level cost evidence/);
});

test("built-in private output ingestion requires an explicit exact-host allowlist",()=>{
  assert.throws(()=>createCloudVideoWorkerComposition({
    ...base,loadPrivateAsset:undefined,ingestOutputs:undefined,env:{...env}
  }),/RUNWAY_VIDEO_OUTPUT_HOSTS exact-host allowlist/);
});

test("built-in cloud asset adapters compose without network I/O when explicitly configured",()=>{
  const worker=createCloudVideoWorkerComposition({
    ...base,loadPrivateAsset:undefined,ingestOutputs:undefined,
    env:{...env,RUNWAY_VIDEO_OUTPUT_HOSTS:"outputs.example.test"}
  });
  assert.equal(typeof worker.runCycle,"function");
  assert.equal(typeof worker.recoverExpired,"function");
});

test("cloud video composition wires queue, Postgres ledger, Runway and injected private services without network I/O", () => {
  const worker = createCloudVideoWorkerComposition(base);
  assert.equal(typeof worker.runCycle, "function");
  assert.equal(typeof worker.recoverExpired, "function");
});


test("composed worker claims only video jobs and does not contact Runway when the queue is empty", async () => {
  const calls = [];
  const worker = createCloudVideoWorkerComposition({
    ...base,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const result = await worker.runCycle({ leaseSeconds: 90, heartbeatIntervalMs: 15000 });
  assert.deepEqual(result, { claimed: false });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/rpc/claim_next_job"));
  assert.deepEqual(calls[0].body.p_job_types, ["video.generate"]);
});
