import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGoogleGeminiFilesRecoveryWorker } from "../google-gemini-files-recovery-worker.mjs";

const attemptId = "44444444-4444-4444-8444-444444444444";
const bytes = Buffer.from("private-recovery-fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const displayName = "executive-visuals-" + "a".repeat(32);
const baseAttempt = {
  id: attemptId, state: "OUTCOME_UNKNOWN", attemptKey: "a".repeat(64),
  assetId: "33333333-3333-4333-8333-333333333333",
  ownerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  mimeType: "image/png", sizeBytes: bytes.length, sha256, displayName,
  providerFileName: null, providerFileUri: null, providerExpiresAt: null
};
const file = {
  name: "files/gemini-123",
  displayName, uri: "https://generativelanguage.googleapis.com/v1beta/files/gemini-123",
  mimeType: "image/png", sizeBytes: bytes.length,
  sha256Hash: Buffer.from(sha256, "hex").toString("base64"),
  state: "ACTIVE", expirationTime: "2026-11-07T00:00:00.000Z"
};
function harness({ attempts = [baseAttempt], pages = [{ files: [file], nextPageToken: null }], getFile, failRecord = false, failUpdate = false } = {}) {
  const calls = [];
  const records = [];
  const updates = [];
  const repository = {
    async listRecoveryAttempts(args) { calls.push(["attempts", args]); return attempts; },
    async recordProviderFile(value) { records.push(value); if (failRecord) throw new Error("db failure"); },
    async updateUploadAttempt(value) { updates.push(value); if (failUpdate) throw new Error("db failure"); }
  };
  const gateway = {
    async listProviderFiles(args) {
      calls.push(["list", args]);
      return pages.shift() || { files: [], nextPageToken: null };
    },
    async getProviderFile(name) { calls.push(["get", name]); return getFile || file; }
  };
  const worker = createGoogleGeminiFilesRecoveryWorker({
    repository, gateway, now: () => Date.parse("2026-11-05T00:00:00.000Z")
  });
  return { worker, calls, records, updates };
}

test("reconciles one exact provider file using display name, MIME, size and SHA-256", async () => {
  const h = harness();
  const result = await h.worker.run({ before: "2026-11-05T00:00:00.000Z", limit: 25 });
  assert.equal(result.reconciled, 1);
  assert.equal(result.unresolved, 0);
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].name, file.name);
  assert.equal(h.records[0].sha256, sha256);
  assert.deepEqual(h.updates[0], {
    attemptId, expectedState: "OUTCOME_UNKNOWN", state: "COMPLETED",
    providerFileName: file.name, providerFileUri: file.uri,
    providerExpiresAt: file.expirationTime,
    reconciledAt: "2026-11-05T00:00:00.000Z"
  });
});

test("leaves no-match outcomes quarantined instead of assuming upload did not happen", async () => {
  const h = harness({ pages: [{ files: [], nextPageToken: null }] });
  const result = await h.worker.run();
  assert.equal(result.reconciled, 0);
  assert.equal(result.results[0].status, "no_provider_evidence_quarantined");
  assert.equal(h.records.length, 0);
  assert.equal(h.updates.length, 0);
});

test("quarantines multiple matching display names and never chooses one arbitrarily", async () => {
  const h = harness({ pages: [{ files: [file, { ...file, name: "files/gemini-456" }], nextPageToken: null }] });
  const result = await h.worker.run();
  assert.equal(result.results[0].status, "ambiguous_multiple_matches");
  assert.equal(h.records.length, 0);
});

test("does not accept metadata mismatches as proof of the uploaded private asset", async () => {
  const h = harness({ pages: [{ files: [{ ...file, sizeBytes: file.sizeBytes + 1 }], nextPageToken: null }] });
  const result = await h.worker.run();
  assert.equal(result.results[0].status, "metadata_mismatch_quarantined");
  assert.equal(h.records.length, 0);
});

test("uses direct metadata lookup for attempts with a known provider file name", async () => {
  const attempt = { ...baseAttempt, state: "PROVIDER_CREATED", providerFileName: file.name };
  const h = harness({ attempts: [attempt] });
  const result = await h.worker.run();
  assert.equal(result.reconciled, 1);
  assert.ok(h.calls.some(call => call[0] === "get" && call[1] === file.name));
  assert.equal(h.records.length, 1);
});

test("retains retry-pending state when mapping persistence fails", async () => {
  const h = harness({ failRecord: true });
  const result = await h.worker.run();
  assert.equal(result.results[0].status, "retry_pending");
  assert.equal(h.updates.length, 0);
});

test("does not reconcile a file without verified expiration metadata", async () => {
  const h = harness({ pages: [{ files: [{ ...file, expirationTime: null }], nextPageToken: null }] });
  const result = await h.worker.run();
  assert.equal(result.results[0].status, "expiry_unverified_quarantined");
  assert.equal(h.records.length, 0);
});
