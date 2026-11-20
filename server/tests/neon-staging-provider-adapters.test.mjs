import test from "node:test";
import assert from "node:assert/strict";
import { createNeonStagingProviderAdapters } from "../neon-staging-provider-adapters.mjs";
import { createNeonObjectStorage } from "../neon-object-storage.mjs";

const env = {
  NEON_STAGING_RUNTIME_ENABLED: "true",
  NEON_STAGING_BRANCH_NAME: "executive-visuals-staging",
  CLOUD_VIDEO_WORKER_ENABLED: "true",
  VIDEO_GATEWAY_ENABLED: "true",
  VIDEO_GATEWAY_ALLOW_REMOTE: "true",
  CLOUD_MEDIA_STORAGE_PROVIDER: "neon",
  SUPABASE_URL: "https://metadata.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "test-server-secret",
  NEON_STORAGE_ENDPOINT: "https://br-staging.storage.c-9.us-east-2.aws.neon.tech",
  NEON_STORAGE_REGION: "us-east-2",
  NEON_STORAGE_ACCESS_KEY_ID: "neon_test_key",
  NEON_STORAGE_SECRET_ACCESS_KEY: "s".repeat(40),
  NEON_STORAGE_BUCKET: "executive-visuals-media",
  FAL_VIDEO_MODEL: "fal-ai/wan/v2.7/text-to-video",
  FAL_KEY: "fal-test-key",
  FAL_BILLING_KEY: "fal-billing-test-key"
};

test("composes an exact FAL model, private Neon storage and Supabase authorization without network calls", async () => {
  let networkCalls = 0;
  const fetchImpl = async () => {
    networkCalls += 1;
    throw new Error("network must not run during provider composition");
  };
  const storage = createNeonObjectStorage({
    endpoint: env.NEON_STORAGE_ENDPOINT, region: env.NEON_STORAGE_REGION,
    accessKeyId: env.NEON_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.NEON_STORAGE_SECRET_ACCESS_KEY,
    bucket: env.NEON_STORAGE_BUCKET, fetchImpl
  });
  const result = createNeonStagingProviderAdapters({ env, fetchImpl, storage });
  assert.deepEqual(result.adapters.map(adapter => adapter.provider + ":" + adapter.model), [
    "fal:fal-ai/wan/v2.7/text-to-video"
  ]);
  assert.equal(result.storage, storage);
  assert.equal(result.readiness.storage, "neon-private");
  assert.equal(result.readiness.metadata, "supabase");
  assert.equal(result.readiness.billing, "fal-task-usage");
  assert.equal(await result.authorizeJob({ ownerId: "123e4567-e89b-42d3-a456-426614174000", projectId: null }), false);
  assert.equal(networkCalls, 0);
});

test("Neon provider registry refuses incomplete remote execution and storage gates", () => {
  assert.throws(() => createNeonStagingProviderAdapters({
    env: { ...env, VIDEO_GATEWAY_ALLOW_REMOTE: "false" },
    storage: createNeonObjectStorage({
      endpoint: env.NEON_STORAGE_ENDPOINT, region: env.NEON_STORAGE_REGION,
      accessKeyId: env.NEON_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.NEON_STORAGE_SECRET_ACCESS_KEY,
      bucket: env.NEON_STORAGE_BUCKET,
      fetchImpl: async () => { throw new Error("not called"); }
    })
  }), /explicit worker, gateway and remote-execution gates/);
  assert.throws(() => createNeonStagingProviderAdapters({
    env: { ...env, CLOUD_MEDIA_STORAGE_PROVIDER: "supabase" },
    storage: {}
  }), /CLOUD_MEDIA_STORAGE_PROVIDER=neon/);
});

test("Neon provider registry requires a server-side FAL model and billing configuration", () => {
  const storage = createNeonObjectStorage({
    endpoint: env.NEON_STORAGE_ENDPOINT, region: env.NEON_STORAGE_REGION,
    accessKeyId: env.NEON_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.NEON_STORAGE_SECRET_ACCESS_KEY,
    bucket: env.NEON_STORAGE_BUCKET,
    fetchImpl: async () => { throw new Error("not called"); }
  });
  assert.throws(() => createNeonStagingProviderAdapters({
    env: { ...env, FAL_VIDEO_MODEL: "" }, storage
  }), /FAL_VIDEO_MODEL/);
});


test("Neon worker registry refuses a noncanonical bucket even when storage is injected", () => {
  const storage = createNeonObjectStorage({
    endpoint: env.NEON_STORAGE_ENDPOINT, region: env.NEON_STORAGE_REGION,
    accessKeyId: env.NEON_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.NEON_STORAGE_SECRET_ACCESS_KEY,
    bucket: env.NEON_STORAGE_BUCKET,
    fetchImpl: async () => { throw new Error("not called"); }
  });
  assert.throws(() => createNeonStagingProviderAdapters({
    env: { ...env, NEON_STORAGE_BUCKET: "custom-media" }, storage
  }), /canonical executive-visuals-media bucket/);
});
