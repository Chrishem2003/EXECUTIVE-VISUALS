import test from "node:test";
import assert from "node:assert/strict";
import { createAssetProvenanceRecord, verifyAssetProvenanceRecord } from "../provenance.mjs";

const asset = {
  id: "asset-123",
  sha256: "a".repeat(64),
  mediaType: "video/mp4",
  size: 4096
};

test("creates a deterministic content-bound ingest record", () => {
  const input = { asset, createdAt: "2026-11-08T07:00:00.000Z" };
  const first = createAssetProvenanceRecord(input);
  const second = createAssetProvenanceRecord(input);
  assert.deepEqual(first, second);
  assert.equal(first.schema, "executive-visuals.provenance.v1");
  assert.equal(first.recordType, "asset_ingest");
  assert.equal(first.asset.sha256, asset.sha256);
  assert.equal(first.recordHash.length, 64);
  assert.equal(verifyAssetProvenanceRecord(first, asset).status, "integrity_verified");
});

test("detects changes to the provenance record", () => {
  const record = createAssetProvenanceRecord({ asset, createdAt: "2026-11-08T07:00:00.000Z" });
  const changed = { ...record, source: { kind: "imported_asset", parentAssetId: null } };
  const result = verifyAssetProvenanceRecord(changed, asset);
  assert.equal(result.status, "invalid");
  assert.ok(result.findings.includes("PROVENANCE_HASH_MISMATCH"));
});

test("detects when the stored media no longer matches the manifest", () => {
  const record = createAssetProvenanceRecord({ asset, createdAt: "2026-11-08T07:00:00.000Z" });
  const result = verifyAssetProvenanceRecord(record, { ...asset, sha256: "b".repeat(64) });
  assert.equal(result.status, "invalid");
  assert.ok(result.findings.includes("PROVENANCE_CONTENT_HASH_MISMATCH"));
});

test("does not imply C2PA verification or trust", () => {
  const record = createAssetProvenanceRecord({ asset, createdAt: "2026-11-08T07:00:00.000Z" });
  const result = verifyAssetProvenanceRecord(record, asset);
  assert.equal(result.c2pa, "not_checked");
});

test("requires a parent for derived assets and validates source kinds", () => {
  assert.throws(() => createAssetProvenanceRecord({
    asset, createdAt: "2026-11-08T07:00:00.000Z", source: { kind: "derived_asset" }
  }), /parent asset id/);
  assert.throws(() => createAssetProvenanceRecord({
    asset, createdAt: "2026-11-08T07:00:00.000Z", source: { kind: "unknown" }
  }), /Unsupported provenance source kind/);
});

test("rejects malformed asset descriptors and timestamps", () => {
  assert.throws(() => createAssetProvenanceRecord({
    asset: { ...asset, sha256: "bad" }, createdAt: "2026-11-08T07:00:00.000Z"
  }), /SHA-256/);
  assert.throws(() => createAssetProvenanceRecord({ asset, createdAt: "not-a-date" }), /canonical UTC ISO timestamp/);
});

test("reports missing records without treating them as valid", () => {
  const result = verifyAssetProvenanceRecord(null, asset);
  assert.equal(result.status, "not_available");
  assert.equal(result.integrity, false);
});
