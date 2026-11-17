import test from "node:test";
import assert from "node:assert/strict";
import { resolveCloudMediaMaxUploadBytes, SUPABASE_FREE_MAX_FILE_BYTES } from "../cloud-upload-limits.mjs";

test("Supabase Free defaults to its documented 50 MiB individual-object ceiling", () => {
  assert.equal(resolveCloudMediaMaxUploadBytes(), SUPABASE_FREE_MAX_FILE_BYTES);
});

test("Supabase Free cannot be raised above 50 MiB by environment configuration", () => {
  assert.equal(resolveCloudMediaMaxUploadBytes({ configuredMaxBytes: 250 * 1024 * 1024 }), SUPABASE_FREE_MAX_FILE_BYTES);
  assert.equal(resolveCloudMediaMaxUploadBytes({ configuredMaxBytes: 20 * 1024 * 1024 }), 20 * 1024 * 1024);
});

test("other storage providers retain their configured upload ceiling", () => {
  assert.equal(resolveCloudMediaMaxUploadBytes({ storageProvider: "r2", configuredMaxBytes: 250 * 1024 * 1024 }), 250 * 1024 * 1024);
  assert.equal(resolveCloudMediaMaxUploadBytes({ storageProvider: "b2", configuredMaxBytes: 600 * 1024 * 1024 }), 600 * 1024 * 1024);
});

test("invalid configured upload ceilings fail closed", () => {
  for (const value of [0, -1, 1.5, Number.NaN, 2 * 1024 * 1024 * 1024]) {
    assert.throws(() => resolveCloudMediaMaxUploadBytes({ configuredMaxBytes: value }), /upload limit/);
  }
});
