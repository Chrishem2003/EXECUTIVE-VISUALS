import test from "node:test";
import assert from "node:assert/strict";
import { createProviderAwareCloudVideoWorkerComposition } from "../cloud-video-provider-worker-composition.mjs";

const env = {
  CLOUD_VIDEO_WORKER_ENABLED: "true",
  VIDEO_GATEWAY_ENABLED: "true",
  VIDEO_GATEWAY_ALLOW_REMOTE: "true",
  FAL_VIDEO_MODEL: "fal-ai/wan/v2.7/text-to-video",
  FAL_KEY: "queue-test-key",
  FAL_BILLING_KEY: "billing-test-key"
};
const base = {
  workerId: "provider-worker-test",
  url: "https://example.supabase.co",
  serviceRoleKey: "test-service-role-key",
  env,
  fetchImpl: async () => { throw new Error("network must not run during composition"); },
  allowedOutputHosts: ["fal.media", "*.fal.media"],
  validateMedia: async () => ({ valid: true, mediaType: "video/mp4" }),
  createAdapters: ({ ingestOutputs }) => [{
    provider: "fal",
    model: "fal-ai/wan/v2.7/text-to-video",
    async submit() { throw new Error("not called during composition"); },
    async getStatus() { throw new Error("not called during composition"); },
    async ingestOutputs(args) { return ingestOutputs(args); },
    async resolveActualCost() { return { amount: 0.1, currency: "USD", evidenceReference: "test:billing-event" }; }
  }]
};

test("provider-aware worker composition is disabled without explicit cloud-worker opt-in", () => {
  assert.throws(
    () => createProviderAwareCloudVideoWorkerComposition({ ...base, env: { ...env, CLOUD_VIDEO_WORKER_ENABLED: "false" } }),
    /explicit CLOUD_VIDEO_WORKER_ENABLED=true/
  );
});

test("provider-aware worker composition requires both remote execution gates", () => {
  assert.throws(
    () => createProviderAwareCloudVideoWorkerComposition({ ...base, env: { ...env, VIDEO_GATEWAY_ALLOW_REMOTE: "false" } }),
    /VIDEO_GATEWAY_ENABLED=true and VIDEO_GATEWAY_ALLOW_REMOTE=true/
  );
});

test("provider-aware worker composition requires explicit output hostname allowlisting", () => {
  assert.throws(
    () => createProviderAwareCloudVideoWorkerComposition({ ...base, allowedOutputHosts: [] }),
    /explicit bounded hostname allowlist/
  );
});

test("composes provider adapters with Supabase queue, ledger and private asset services without network I/O", () => {
  let adapterFactoryCalls = 0;
  const worker = createProviderAwareCloudVideoWorkerComposition({
    ...base,
    createAdapters: ({ ingestOutputs, assets, fetchImpl }) => {
      adapterFactoryCalls += 1;
      assert.equal(typeof ingestOutputs, "function");
      assert.ok(assets);
      assert.equal(typeof fetchImpl, "function");
      return base.createAdapters({ ingestOutputs });
    }
  });
  assert.equal(adapterFactoryCalls, 1);
  assert.deepEqual(worker.listSupported(), ["fal:fal-ai/wan/v2.7/text-to-video"]);
  assert.equal(typeof worker.runCycle, "function");
  assert.equal(typeof worker.recoverExpired, "function");
});

test("rejects providers without provider-owned ingestion and actual billing evidence", () => {
  assert.throws(
    () => createProviderAwareCloudVideoWorkerComposition({
      ...base,
      createAdapters: () => [{
        provider: "fal", model: "fal-ai/wan/v2.7/text-to-video",
        async submit() {}, async getStatus() {}
      }]
    }),
    /private output ingestion and authoritative cost reconciliation/
  );
});


test("defaults to the exact FAL provider registration when no custom adapter factory is supplied", () => {
  let networkCalls = 0;
  const worker = createProviderAwareCloudVideoWorkerComposition({
    ...base,
    createAdapters: undefined,
    env: {
      ...env,
      FAL_VIDEO_MODEL: "fal-ai/wan/v2.7/text-to-video",
      FAL_KEY: "queue-test-key",
      FAL_BILLING_KEY: "billing-test-key"
    },
    fetchImpl: async () => { networkCalls += 1; throw new Error("network must not run during construction"); },
    createAdapters: undefined
  });
  assert.deepEqual(worker.listSupported(), ["fal:fal-ai/wan/v2.7/text-to-video"]);
  assert.equal(networkCalls, 0);
});


test("registers Runway text and video-edit adapters only with explicit task-cost and source-resolution dependencies", () => {
  const worker = createProviderAwareCloudVideoWorkerComposition({
    ...base,
    createAdapters: undefined,
    env: {
      ...env,
      FAL_VIDEO_MODEL: "fal-ai/wan/v2.7/text-to-video",
      FAL_KEY: "queue-test-key",
      FAL_BILLING_KEY: "billing-test-key",
      RUNWAY_VIDEO_MODELS: "gen4.5,aleph2,magnific_video_upscaler_creative,ruby",
      RUNWAY_API_KEY: "runway-test-key",
      RUNWAY_VIDEO_ALLOW_REMOTE: "false"
    },
    resolveRunwayActualCost: async () => ({
      amount: 1, currency: "USD", evidenceReference: "test:runway-task-ledger"
    }),
    prepareRunwayInput: async () => ({}),
    resolveRunwaySourceMetadata: async () => ({})
  });
  assert.deepEqual(worker.listSupported(), [
    "fal:fal-ai/wan/v2.7/text-to-video",
    "runway:aleph2",
    "runway:gen4.5",
    "runway:magnific_video_upscaler_creative",
    "runway:ruby"
  ]);
});

test("refuses Runway worker registration without authoritative task-level cost resolution", () => {
  assert.throws(() => createProviderAwareCloudVideoWorkerComposition({
    ...base,
    createAdapters: undefined,
    env: {
      ...env,
      FAL_VIDEO_MODEL: "fal-ai/wan/v2.7/text-to-video",
      FAL_KEY: "queue-test-key",
      FAL_BILLING_KEY: "billing-test-key",
      RUNWAY_VIDEO_MODELS: "aleph2",
      RUNWAY_API_KEY: "runway-test-key"
    },
    prepareRunwayInput: async () => ({})
  }), /authoritative task-level billing resolver/);
});

test("Aleph2 worker registration composes the built-in owner-scoped private source resolver", () => {
  const worker = createProviderAwareCloudVideoWorkerComposition({
    ...base,
    createAdapters: undefined,
    env: {
      ...env,
      FAL_VIDEO_MODEL: "fal-ai/wan/v2.7/text-to-video",
      FAL_KEY: "queue-test-key",
      FAL_BILLING_KEY: "billing-test-key",
      RUNWAY_VIDEO_MODELS: "aleph2",
      RUNWAY_API_KEY: "runway-test-key"
    },
    resolveRunwayActualCost: async () => ({
      amount: 1, currency: "USD", evidenceReference: "test:runway-task-ledger"
    })
  });
  assert.ok(worker.listSupported().includes("runway:aleph2"));
});


test("rejects unknown or duplicate Runway model registrations before constructing a worker", () => {
  assert.throws(() => createProviderAwareCloudVideoWorkerComposition({
    ...base, runwayModels: ["gen4.5", "unknown-model"]
  }), /unique list of explicitly supported model profiles/);
  assert.throws(() => createProviderAwareCloudVideoWorkerComposition({
    ...base, runwayModels: ["gen4.5", "gen4.5"]
  }), /unique list of explicitly supported model profiles/);
});


test("source-edit model registration composes server-side source metadata probing by default", () => {
  const worker = createProviderAwareCloudVideoWorkerComposition({
    ...base,
    createAdapters: undefined,
    env: {
      ...env,
      FAL_VIDEO_MODEL: "fal-ai/wan/v2.7/text-to-video",
      FAL_KEY: "queue-test-key",
      FAL_BILLING_KEY: "billing-test-key",
      RUNWAY_VIDEO_MODELS: "aleph2",
      RUNWAY_API_KEY: "runway-test-key"
    },
    resolveRunwayActualCost: async () => ({
      amount: 1, currency: "USD", evidenceReference: "test:runway-task-ledger"
    })
  });
  assert.ok(worker.listSupported().includes("runway:aleph2"));
});


test("Google Omni worker registration requires all explicit transport gates and approved-input callbacks", () => {
  assert.throws(() => createProviderAwareCloudVideoWorkerComposition({
    ...base, createAdapters: undefined,
    env: { ...env, GOOGLE_OMNI_VIDEO_ENABLED: "true", GOOGLE_OMNI_VIDEO_ALLOW_REMOTE: "true" }
  }), /both Gemini transport gates/);
  assert.throws(() => createProviderAwareCloudVideoWorkerComposition({
    ...base, createAdapters: undefined,
    env: {
      ...env, GOOGLE_OMNI_VIDEO_ENABLED: "true", GOOGLE_OMNI_VIDEO_ALLOW_REMOTE: "true",
      GEMINI_OMNI_ENABLED: "true", GEMINI_OMNI_ALLOW_REMOTE: "true"
    }
  }), /durable approval, owner\/project authorization and private-input planning callbacks/);
});

test("Google Omni adapter can be injected only behind all explicit gates", () => {
  const googleOmniIntegration = {
    adapter: {
      provider: "google", model: "gemini-omni-1.1-flash",
      async prepareInput() { return {}; },
      async submit() { return { taskId: "v1_test123", status: "queued" }; },
      async getStatus() { return { taskId: "v1_test123", status: "succeeded" }; }
    },
    async ingestOutputs() { return { assetIds: ["asset-google"] }; },
    async resolveActualCost() { return { amount: 0.1, currency: "USD", evidenceReference: "test:google-cost" }; }
  };
  assert.throws(() => createProviderAwareCloudVideoWorkerComposition({
    ...base, createAdapters: undefined,
    providerDependencies: { googleOmniIntegration }
  }), /cannot be injected while its explicit provider gates are disabled/);
  const worker = createProviderAwareCloudVideoWorkerComposition({
    ...base, createAdapters: undefined,
    env: {
      ...env, GOOGLE_OMNI_VIDEO_ENABLED: "true", GOOGLE_OMNI_VIDEO_ALLOW_REMOTE: "true",
      GEMINI_OMNI_ENABLED: "true", GEMINI_OMNI_ALLOW_REMOTE: "true"
    },
    providerDependencies: { googleOmniIntegration }
  });
  assert.ok(worker.listSupported().includes("google:gemini-omni-1.1-flash"));
});

test("registers Runway Model Router only from an explicit saved config and remote opt-in", () => {
  const worker = createProviderAwareCloudVideoWorkerComposition({
    ...base,
    createAdapters: undefined,
    env: {
      ...env,
      RUNWAY_MODEL_ROUTER_ENABLED: "true",
      RUNWAY_VIDEO_ROUTER_CONFIG: "production-video",
      RUNWAY_API_KEY: "runway-test-key",
      RUNWAY_VIDEO_ALLOW_REMOTE: "true"
    }
  });
  assert.ok(worker.listSupported().includes("runway:model-router"));
  assert.throws(() => createProviderAwareCloudVideoWorkerComposition({
    ...base,
    createAdapters: undefined,
    env: {
      ...env, RUNWAY_MODEL_ROUTER_ENABLED: "true",
      RUNWAY_API_KEY: "runway-test-key", RUNWAY_VIDEO_ALLOW_REMOTE: "true"
    }
  }), /RUNWAY_VIDEO_ROUTER_CONFIG/);
});

test("Runway Model Router worker can be composed without FAL credentials", () => {
 const worker=createProviderAwareCloudVideoWorkerComposition({
  ...base,createAdapters:undefined,
  env:{
   CLOUD_VIDEO_WORKER_ENABLED:"true",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",
   RUNWAY_MODEL_ROUTER_ENABLED:"true",RUNWAY_VIDEO_ROUTER_CONFIG:"production-video",
   RUNWAY_API_KEY:"runway-test-key",RUNWAY_VIDEO_ALLOW_REMOTE:"true"
  }
 });
 assert.deepEqual(worker.listSupported(),["runway:model-router"]);
});

