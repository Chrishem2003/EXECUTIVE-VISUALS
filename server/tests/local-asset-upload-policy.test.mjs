import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLocalAssetUploadPolicy } from "../local-asset-upload-policy.mjs";

test("local development keeps local uploads available on disposable storage", () => {
  assert.equal(evaluateLocalAssetUploadPolicy({
    nodeEnv: "development",
    dataDirPersistence: "ephemeral",
    requirePersistentDataDir: false
  }).allowed, true);
});

test("production rejects local uploads on ephemeral storage", () => {
  const result = evaluateLocalAssetUploadPolicy({
    nodeEnv: "production",
    dataDirPersistence: "ephemeral",
    requirePersistentDataDir: false
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "PERSISTENT_STORAGE_REQUIRED");
  assert.match(result.message, /operator-confirmed persistent data volume/i);
});

test("production rejects storage that is merely unverified", () => {
  const result = evaluateLocalAssetUploadPolicy({
    nodeEnv: "production",
    dataDirPersistence: "unverified",
    requirePersistentDataDir: true
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "PERSISTENT_STORAGE_REQUIRED");
});

test("production requires both the persistent-volume assertion and startup enforcement", () => {
  const result = evaluateLocalAssetUploadPolicy({
    nodeEnv: "production",
    dataDirPersistence: "operator-confirmed-volume",
    requirePersistentDataDir: false
  });
  assert.equal(result.allowed, false);
});

test("production allows local uploads only after persistent storage is explicitly confirmed and required", () => {
  assert.deepEqual(evaluateLocalAssetUploadPolicy({
    nodeEnv: "production",
    dataDirPersistence: "operator-confirmed-volume",
    requirePersistentDataDir: true
  }), { allowed: true, code: null, message: null });
});
