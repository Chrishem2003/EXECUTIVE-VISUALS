import test from "node:test";
import assert from "node:assert/strict";
import { buildCloudMediaHealth } from "../cloud-media-health.mjs";

test("cloud media remains disabled until its API is enabled", () => {
  assert.deepEqual(buildCloudMediaHealth({
    enabled: false,
    readiness: { ready: true, storage: "private" },
    storageProvider: "b2",
    uploadLimitBytes: 600 * 1024 * 1024
  }), {
    enabled: false,
    ready: false,
    storage: "disabled",
    provider: "b2",
    uploadLimitBytes: 600 * 1024 * 1024
  });
});

test("API construction without a successful private-storage check is not ready", () => {
  for (const readiness of [
    null,
    { ready: false, storage: "private" },
    { ready: true, storage: "local" },
    { ready: true, storage: "unverified" }
  ]) {
    const health = buildCloudMediaHealth({ enabled: true, readiness, storageProvider: "supabase", uploadLimitBytes: 50 * 1024 * 1024 });
    assert.equal(health.enabled, true);
    assert.equal(health.ready, false);
    assert.equal(health.storage, "unverified");
  }
});

test("cloud media is ready only after private storage verification succeeds", () => {
  assert.deepEqual(buildCloudMediaHealth({
    enabled: true,
    readiness: { ready: true, storage: "private", schema: "executive_visuals" },
    storageProvider: "b2",
    uploadLimitBytes: 600 * 1024 * 1024
  }), {
    enabled: true,
    ready: true,
    storage: "private",
    provider: "b2",
    uploadLimitBytes: 600 * 1024 * 1024
  });
});

test("Neon is a recognized private storage provider in safe health output", () => {
  assert.deepEqual(buildCloudMediaHealth({
    enabled: true,
    readiness: { ready: true, storage: "private" },
    storageProvider: "neon",
    uploadLimitBytes: 250 * 1024 * 1024
  }), {
    enabled: true, ready: true, storage: "private", provider: "neon",
    uploadLimitBytes: 250 * 1024 * 1024
  });
});

test("health output never exposes credentials or accepts invalid provider and upload-limit values", () => {
  const health = buildCloudMediaHealth({
    enabled: true,
    readiness: { ready: true, storage: "private", serviceRoleKey: "must-not-leak" },
    storageProvider: "https://user:secret@example.test",
    uploadLimitBytes: Number.POSITIVE_INFINITY
  });
  assert.equal(health.ready, true);
  assert.equal(health.provider, "unknown");
  assert.equal(health.uploadLimitBytes, null);
  assert.equal(JSON.stringify(health).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(health).includes("secret"), false);
});
