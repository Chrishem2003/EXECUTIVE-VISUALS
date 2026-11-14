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
function harness({ attempts = [baseAttempt], pages = [{ files: [file], nextPageToken: null }], getFile, getFileError, failRecord = false, failUpdate = false, maxPages = 10 } = {}) {
  const calls = [];
  const records = [];
  const updates = [];
  const leaseToken = "55555555-5555-4555-8555-555555555555";
  let claimed = false;
  const repository = {
    async listRecoveryAttempts(args) { calls.push(["attempts", args]); return attempts; },
    async claimRecoveryAttempt(args) {
      calls.push(["claim", args]);
      if (claimed) return null;
      claimed = true;
      return leaseToken;
    },
    async releaseRecoveryAttempt(args) {
      calls.push(["release", args]);
      if (args.leaseToken !== leaseToken || !claimed) return false;
      claimed = false;
      return true;
    },
    async recordProviderFile(value) { records.push(value); if (failRecord) throw new Error("db failure"); },
    async updateUploadAttempt(value) {
      updates.push(value);
      if (failUpdate) throw new Error("db failure");
      if (value.leaseToken === leaseToken) claimed = false;
    }
  };
  const gateway = {
    async listProviderFiles(args) {
      calls.push(["list", args]);
      return pages.shift() || { files: [], nextPageToken: null };
    },
    async getProviderFile(name) { calls.push(["get", name]); if (getFileError) throw getFileError; return getFile || file; }
  };
  const worker = createGoogleGeminiFilesRecoveryWorker({
    repository, gateway, now: () => Date.parse("2026-11-05T00:00:00.000Z"), maxPages
  });
  return { worker, calls, records, updates, leaseToken };
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
    attemptId, expectedState: "OUTCOME_UNKNOWN", leaseToken: h.leaseToken, state: "COMPLETED",
    providerFileName: file.name, providerFileUri: file.uri,
    providerExpiresAt: file.expirationTime,
    reconciledAt: "2026-11-05T00:00:00.000Z"
  });
});

test("leaves no-match outcomes quarantined instead of assuming upload did not happen", async () => {
  const h = harness({ pages: [{ files: [], nextPageToken: null }] });
  const result = await h.worker.run();
  assert.equal(result.reconciled, 0);
  assert.equal(result.quarantined, 1);
  assert.equal(result.retryPending, 0);
  assert.equal(result.results[0].status, "no_provider_evidence_quarantined");
  assert.equal(h.records.length, 0);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].state, "QUARANTINED");
  assert.equal(h.updates[0].errorCode, "GEMINI_FILE_RECOVERY_NO_PROVIDER_EVIDENCE");
  assert.equal(h.updates[0].leaseToken, h.leaseToken);
});

test("quarantines multiple matching display names and never chooses one arbitrarily", async () => {
  const h = harness({ pages: [{ files: [file, { ...file, name: "files/gemini-456" }], nextPageToken: null }] });
  const result = await h.worker.run();
  assert.equal(result.results[0].status, "ambiguous_multiple_matches");
  assert.equal(h.records.length, 0);
  assert.equal(h.updates[0].state, "QUARANTINED");
  assert.equal(h.updates[0].errorCode, "GEMINI_FILE_RECOVERY_MULTIPLE_MATCHES");
});

test("does not contact Google when another recovery worker owns the lease", async () => {
  const h = harness();
  const results = await Promise.all([h.worker.run(), h.worker.run()]);
  const skipped = results.find(result => result.results[0]?.status === "already_claimed");
  assert.ok(skipped);
  assert.equal(results.filter(result => result.reconciled === 1).length, 1);
  assert.equal(h.calls.filter(call => call[0] === "list").length, 1);
  assert.equal(h.calls.filter(call => call[0] === "claim").length, 2);
});

test("releases a recovery lease after transient provider or persistence errors", async () => {
  const h = harness({ failRecord: true });
  const result = await h.worker.run();
  assert.equal(result.retryPending, 1);
  assert.ok(h.calls.some(call => call[0] === "release" && call[1].leaseToken === h.leaseToken));
});

test("does not accept metadata mismatches as proof of the uploaded private asset", async () => {
  const h = harness({ pages: [{ files: [{ ...file, sizeBytes: file.sizeBytes + 1 }], nextPageToken: null }] });
  const result = await h.worker.run();
  assert.equal(result.results[0].status, "metadata_mismatch_quarantined");
  assert.equal(h.records.length, 0);
  assert.equal(h.updates[0].state, "QUARANTINED");
});


test("quarantines a partial provider listing even when the first page has one match", async () => {
  const h = harness({ pages: [{ files: [file], nextPageToken: "next-page" }], maxPages: 1 });
  const result = await h.worker.run();
  assert.equal(result.results[0].status, "pagination_incomplete_quarantined");
  assert.equal(h.records.length, 0);
  assert.equal(h.updates[0].state, "QUARANTINED");
  assert.equal(h.updates[0].errorCode, "GEMINI_FILE_RECOVERY_PAGINATION_INCOMPLETE");
});

test("does not claim quarantine succeeded when its durable state update fails", async () => {
  const h = harness({ pages: [{ files: [], nextPageToken: null }], failUpdate: true });
  const result = await h.worker.run();
  assert.equal(result.results[0].status, "retry_pending");
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


test("quarantines a known provider resource after Google confirms it no longer exists", async () => {
  const attempt = { ...baseAttempt, state: "PROVIDER_CREATED", providerFileName: file.name };
  const missing = Object.assign(new Error("not found"), { status: 404 });
  const h = harness({ attempts: [attempt], getFileError: missing });
  const result = await h.worker.run();
  assert.equal(result.results[0].status, "provider_file_not_found_quarantined");
  assert.equal(result.quarantined, 1);
  assert.equal(h.records.length, 0);
  assert.equal(h.updates[0].state, "QUARANTINED");
  assert.equal(h.updates[0].errorCode, "GEMINI_FILE_RECOVERY_PROVIDER_FILE_NOT_FOUND");
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
  assert.equal(h.updates[0].state, "QUARANTINED");
});
