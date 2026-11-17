import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../../supabase/migrations/20261117120801_enforce_supabase_free_media_limit.sql", import.meta.url), "utf8");

test("private media bucket cannot advertise a per-object limit above Supabase Free's 50 MiB cap", () => {
  assert.match(migration, /update storage\.buckets/i);
  assert.match(migration, /file_size_limit\s*=\s*52428800/i);
  assert.match(migration, /executive-visuals-media/);
  assert.match(migration, /raise exception .*bucket .*missing/i);
});
