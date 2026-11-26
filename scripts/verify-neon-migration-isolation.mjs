import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migrations = [
  "0001_worker_queue.sql",
  "0002_video_submission_ledger.sql",
  "0003_video_financial_controls.sql",
  "0004_queue_admission_and_recovery.sql",
  "0005_pre_ingestion_credit_settlement.sql",
  "0006_atomic_video_enqueue.sql",
  "0007_video_approval_bridge.sql",
  "0008_retryable_submission_recovery.sql",
  "0009_safe_queued_video_cancellation.sql",
];

let tableCount = 0;
let functionCount = 0;
let securityDefinerCount = 0;

for (const name of migrations) {
  const path = `database/neon/migrations/${name}`;
  const sql = readFileSync(path, "utf8");
  const normalized = sql.trim().toLowerCase();

  assert.match(normalized, /^begin;/, `${name} must start a transaction`);
  assert.match(normalized, /commit;$/, `${name} must commit its transaction`);
  assert.doesNotMatch(sql, /\b(?:auth|public|storage)\s*\./i, `${name} must not depend on shared Supabase schemas`);

  const tables = [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_.]+)/gi)];
  const functions = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_.]+)/gi)];
  for (const [, relation] of tables) assert.ok(relation.startsWith("executive_visuals."), `${name} creates a table outside executive_visuals: ${relation}`);
  for (const [, fn] of functions) assert.ok(fn.startsWith("executive_visuals."), `${name} creates a function outside executive_visuals: ${fn}`);

  tableCount += tables.length;
  functionCount += functions.length;
  securityDefinerCount += [...sql.matchAll(/security\s+definer/gi)].length;
  assert.ok((sql.match(/set\s+search_path\s*=\s*pg_catalog\s*,\s*executive_visuals/gi) || []).length >= [...sql.matchAll(/security\s+definer/gi)].length,
    `${name} has a SECURITY DEFINER function without the pinned safe search_path`);
}

assert.equal(migrations.length, 9);
assert.ok(tableCount >= 10, "Expected the worker, submission, financial and approval tables.");
assert.ok(functionCount >= 20, "Expected the queue, submission, financial and cancellation RPCs.");
console.log(JSON.stringify({
  result: "NEON_MIGRATION_ISOLATION_STATIC_OK",
  migrations: migrations.length,
  executiveVisualsTables: tableCount,
  executiveVisualsFunctions: functionCount,
  securityDefinerFunctionsWithPinnedSearchPath: securityDefinerCount,
  sharedSchemasReferenced: false,
}));
