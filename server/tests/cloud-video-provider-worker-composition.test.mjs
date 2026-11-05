import test from "node:test";
import assert from "node:assert/strict";
import { createProviderAwareCloudVideoWorkerComposition } from "../cloud-video-provider-worker-composition.mjs";

const env = {
  CLOUD_VIDEO_WORKER_ENABLED: "true",
  VIDEO_GATEWAY_ENABLED: "true",
  VIDEO_GATEWAY_ALLOW_REMOTE: "true"
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

test("rejects malformed DNS labels in the output hostname allowlist", () => {
  for (const host of ["cdn..fal.media", "-bad.fal.media", "bad-.fal.media", "bad host.fal.media"]) {
    assert.throws(
      () => createProviderAwareCloudVideoWorkerComposition({ ...base, allowedOutputHosts: [host] }),
      /explicit bounded hostname allowlist/
    );
  }
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


test("builds the Google Omni integration inside the real worker composition from explicit governance dependencies", () => {
  const envWithGoogle = {
    ...env,
    GOOGLE_OMNI_VIDEO_ENABLED: "true",
    GOOGLE_OMNI_VIDEO_ALLOW_REMOTE: "true",
    GEMINI_OMNI_ENABLED: "true",
    GEMINI_OMNI_ALLOW_REMOTE: "true",
    GEMINI_OMNI_PAID_TIER_CONFIRMED: "true",
    GEMINI_OMNI_RETENTION_DAYS: "28",
    GEMINI_API_KEY: "server-test-key"
  };
  const interactions = {
    async findInteraction() { return null; },
    async recordInteraction() {},
    async updateInteraction() {}
  };
  const client = {
    async createInteraction() { throw new Error("provider calls must not happen during composition"); },
    async getInteractionForIngestion() { throw new Error("provider calls must not happen during composition"); }
  };
  let captured;
  const worker = createProviderAwareCloudVideoWorkerComposition({
    ...base,
    env: envWithGoogle,
    providerDependencies: {
      googleOmniClient: client,
      googleOmniInteractions: interactions,
      googleOmniAssertApprovedSubmission: async () => true,
      googleOmniAuthorizeInteraction: async () => true,
      googleOmniPreparePlan: async () => ({
        policy: { provider: "google", model: "gemini-omni-1.1-flash", requiresApproval: true },
        payload: {}
      })
    },
    createAdapters: dependencies => {
      captured = dependencies.googleOmniIntegration;
      return [{
        provider: "google",
        model: "gemini-omni-1.1-flash",
        async submit() {},
        async getStatus() {},
        async ingestOutputs() {},
        async resolveActualCost() { return { amount: 0, currency: "USD", evidenceReference: "test" }; }
      }];
    }
  });
  assert.ok(captured);
  assert.equal(typeof captured.adapter.prepareInput, "function");
  assert.equal(typeof captured.adapter.submit, "function");
  assert.equal(typeof captured.ingestOutputs, "function");
  assert.equal(typeof captured.resolveActualCost, "function");
  assert.deepEqual(worker.listSupported(), ["google:gemini-omni-1.1-flash"]);
});

test("Google worker bootstrap fails closed without durable governance callbacks", () => {
  assert.throws(() => createProviderAwareCloudVideoWorkerComposition({
    ...base,
    env: {
      ...env,
      GOOGLE_OMNI_VIDEO_ENABLED: "true",
      GOOGLE_OMNI_VIDEO_ALLOW_REMOTE: "true",
      GEMINI_OMNI_ENABLED: "true",
      GEMINI_OMNI_ALLOW_REMOTE: "true"
    }
  }), /durable approval, owner\/project authorization and private-input planning callbacks/);
});

test("Google worker bootstrap requires both registry and transport opt-in pairs", () => {
  assert.throws(() => createProviderAwareCloudVideoWorkerComposition({
    ...base,
    env: {
      ...env,
      GOOGLE_OMNI_VIDEO_ENABLED: "true",
      GOOGLE_OMNI_VIDEO_ALLOW_REMOTE: "true"
    },
    providerDependencies: {}
  }), /both provider registration gates and both Gemini transport gates/);
});
