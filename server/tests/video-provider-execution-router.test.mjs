import test from "node:test";
import assert from "node:assert/strict";
import { createVideoProviderExecutionRouter } from "../video-provider-execution-router.mjs";
import { executeCloudVideoGenerationJob } from "../cloud-video-generation-job-executor.mjs";

const requestHash = "a".repeat(64);
const job = {
  id: "job-google-1", owner_id: "owner-1", project_id: "project-1",
  lease_owner: "shared-worker-1", lease_token: "923e4567-e89b-42d3-a456-426614174000",
  job_type: "video.generate", estimated_cost: { amount: 1, currency: "USD" },
  input: { provider: "google", model: "gemini-omni-1.1-flash", requestHash }
};
function adapter(overrides = {}) {
  return {
    provider: "google", model: "gemini-omni-1.1-flash",
    async prepareInput(input) { return { prepared: input.requestHash }; },
    async submit() { return { taskId: "v1_abcdef123456", status: "running" }; },
    async getStatus() { return { status: "succeeded", outputUrls: ["opaque-output"] }; },
    ...overrides
  };
}
function ledger() {
  return {
    async prepare() { return { state: "prepared", provider_task_id: null }; },
    async begin() { return true; },
    async record() { return true; },
    async markUnknown() { return true; }
  };
}

test("resolves exact provider/model adapter identities without fuzzy fallback", async () => {
  const google = adapter();
  const runway = adapter({ provider: "runway", model: "gen4.5" });
  const router = createVideoProviderExecutionRouter({ adapters: [google, runway] });
  assert.deepEqual(router.listSupported(), ["google:gemini-omni-1.1-flash", "runway:gen4.5"]);
  assert.equal(await router.resolveAdapter({ provider: "google", model: "gemini-omni-1.1-flash", job }), google);
  await assert.rejects(() => router.resolveAdapter({
    provider: "google", model: "gemini-omni-flash", job: {
      ...job, input: { ...job.input, model: "gemini-omni-flash" }
    }
  }), error => error.code === "VIDEO_ADAPTER_UNAVAILABLE");
});

test("rejects duplicate, malformed and job-mismatched adapter registrations", async () => {
  const google = adapter();
  assert.throws(() => createVideoProviderExecutionRouter({ adapters: [google, adapter()] }), /Duplicate/);
  assert.throws(() => createVideoProviderExecutionRouter({ adapters: [{}] }), /implement submit and getStatus/);
  assert.doesNotThrow(() => createVideoProviderExecutionRouter({ adapters: [{
    provider: "mock", model: "mock-v1", async submit() {}, async getStatus() {}
  }] }));
  const router = createVideoProviderExecutionRouter({ adapters: [google] });
  await assert.rejects(() => router.resolveAdapter({
    provider: "google", model: "gemini-omni-1.1-flash",
    job: { ...job, input: { ...job.input, provider: "runway" } }
  }), error => error.code === "VIDEO_ADAPTER_JOB_SCOPE_MISMATCH");
});

test("shared cloud executor routes a leased job to its exact adapter before submission", async () => {
  const calls = [];
  const google = adapter({
    async prepareInput(input) { calls.push("prepare"); return { prepared: input.requestHash }; },
    async submit(input) { calls.push("submit:" + input.prepared); return { taskId: "v1_abcdef123456", status: "running" }; },
    async getStatus() { calls.push("poll"); return { status: "succeeded", outputUrls: ["opaque-output"] }; }
  });
  const router = createVideoProviderExecutionRouter({ adapters: [google] });
  const result = await executeCloudVideoGenerationJob({
    job, workerId: "shared-worker-1", ledger: ledger(), resolveAdapter: router.resolveAdapter,
    ingestOutputs: async () => ({ assetIds: ["private-asset-1"] }),
    resolveActualCost: async () => ({ amount: 0.5, currency: "USD", evidenceReference: "provider-usage:1" }),
    maxPolls: 1, sleep: async () => {}
  });
  assert.equal(result.provider, "google");
  assert.equal(result.model, "gemini-omni-1.1-flash");
  assert.deepEqual(result.assetIds, ["private-asset-1"]);
  assert.deepEqual(calls, ["prepare", "submit:" + requestHash, "poll"]);
});

test("does not submit when no exact adapter is registered for the leased job", async () => {
  let submissions = 0;
  const runway = adapter({ provider: "runway", model: "gen4.5",
    async submit() { submissions++; return { taskId: "runway-task", status: "running" }; }
  });
  const router = createVideoProviderExecutionRouter({ adapters: [runway] });
  await assert.rejects(() => executeCloudVideoGenerationJob({
    job, workerId: "shared-worker-1", ledger: ledger(), resolveAdapter: router.resolveAdapter,
    ingestOutputs: async () => ({ assetIds: ["private-asset-1"] }),
    resolveActualCost: async () => ({ amount: 0.5, currency: "USD", evidenceReference: "provider-usage:1" }),
    maxPolls: 1, sleep: async () => {}
  }), error => error.code === "VIDEO_ADAPTER_UNAVAILABLE");
  assert.equal(submissions, 0);
});

test("uses provider-specific ingestion and cost resolvers from the selected adapter", async () => {
  const calls=[];
  const google=adapter({
    async submit(){return {taskId:"v1_abcdef123456",status:"running"};},
    async getStatus(){return {status:"succeeded",outputUrls:["opaque-output"]};},
    async ingestOutputs(){calls.push("ingest");return {assetIds:["private-google-asset"]};},
    async resolveActualCost(){calls.push("cost");return {amount:0.5,currency:"USD",evidenceReference:"google-usage:1"};}
  });
  const router=createVideoProviderExecutionRouter({adapters:[google]});
  const result=await executeCloudVideoGenerationJob({
    job,workerId:"shared-worker-2",ledger:ledger(),resolveAdapter:router.resolveAdapter,
    maxPolls:1,sleep:async()=>{}
  });
  assert.deepEqual(result.assetIds,["private-google-asset"]);
  assert.deepEqual(calls,["cost","ingest"]);
});
