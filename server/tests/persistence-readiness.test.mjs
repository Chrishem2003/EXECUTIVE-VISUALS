import test from "node:test";
import assert from "node:assert/strict";
import { describePersistenceReadiness } from "../../src/platform/persistence-readiness.ts";

test("ephemeral app storage is an explicit critical blocker", () => {
  const result = describePersistenceReadiness({ dataDirectory: "ephemeral", database: "sqlite", storage: "local-disk" });
  assert.equal(result.level, "critical");
  assert.match(result.title, /temporary storage/i);
  assert.match(result.message, /restart or redeploy may remove/i);
  assert.equal(result.details.length, 2);
});

test("unverified persistence remains a warning even with cloud database hints", () => {
  const result = describePersistenceReadiness({ dataDirectory: "unverified", database: "postgres", storage: "object-storage" });
  assert.equal(result.level, "warning");
  assert.match(result.message, /independent backups/i);
});

test("operator-confirmed volume with local backends requires backup and restore evidence", () => {
  const result = describePersistenceReadiness({ dataDirectory: "operator-confirmed-volume", database: "sqlite", storage: "local-disk" });
  assert.equal(result.level, "caution");
  assert.match(result.message, /backup.*restore/i);
  assert.equal(result.details.length, 2);
});

test("only verified cloud database and object storage reach ready", () => {
  const result = describePersistenceReadiness({ dataDirectory: "operator-confirmed-volume", database: "postgres", storage: "object-storage" });
  assert.equal(result.level, "ready");
  assert.deepEqual(result.details, []);
});
