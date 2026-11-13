import test from "node:test";
import assert from "node:assert/strict";
import { D1_WORKSPACE_DOCUMENT_MAX_BYTES, parseD1WorkspaceDocument } from "../../src/platform/d1-staging-contract.ts";

test("D1 workspace JSON accepts object documents", () => {
  assert.deepEqual(parseD1WorkspaceDocument('{"schemaVersion":1,"clips":[]}'), { schemaVersion: 1, clips: [] });
});

test("D1 workspace JSON rejects arrays, null and primitive roots", () => {
  for (const raw of ["[]", "null", "true", '"text"', "42"]) {
    assert.throws(() => parseD1WorkspaceDocument(raw), /JSON object/);
  }
});

test("D1 workspace JSON reports malformed input clearly", () => {
  assert.throws(() => parseD1WorkspaceDocument('{"unfinished":'), /invalid JSON/);
});

test("D1 workspace JSON enforces the API byte limit using UTF-8 bytes", () => {
  const accepted = JSON.stringify({ value: "a".repeat(D1_WORKSPACE_DOCUMENT_MAX_BYTES - 20) });
  assert.ok(new TextEncoder().encode(accepted).byteLength <= D1_WORKSPACE_DOCUMENT_MAX_BYTES);
  assert.doesNotThrow(() => parseD1WorkspaceDocument(accepted));
  const rejected = JSON.stringify({ value: "🙂".repeat(D1_WORKSPACE_DOCUMENT_MAX_BYTES / 2) });
  assert.ok(new TextEncoder().encode(rejected).byteLength > D1_WORKSPACE_DOCUMENT_MAX_BYTES);
  assert.throws(() => parseD1WorkspaceDocument(rejected), /256 KB/);
});
