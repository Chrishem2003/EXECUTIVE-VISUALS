import test from "node:test";
import assert from "node:assert/strict";
import { createNeonPostgresPool } from "../neon-postgres-pool.mjs";

test("loads the installed pg driver and constructs a real pool without opening a connection", async () => {
  const pool = await createNeonPostgresPool({
    connectionString: "postgresql://ev:secret@ep-staging-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
    max: 1,
    applicationName: "executive-visuals-pg-smoke"
  });
  try {
    assert.equal(typeof pool.query, "function");
    assert.equal(typeof pool.connect, "function");
    assert.equal(pool.options.max, 1);
    assert.equal(pool.options.ssl.rejectUnauthorized, true);
    assert.equal(pool.options.application_name, "executive-visuals-pg-smoke");
  } finally {
    await pool.end();
  }
});
