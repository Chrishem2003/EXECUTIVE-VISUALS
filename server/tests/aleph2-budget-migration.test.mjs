import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../../supabase/migrations/20261108120000_aleph2_transformation_budget_approval.sql", import.meta.url), "utf8");

test("Aleph 2 approval RPC is service-role-only and requires an existing scoped budget policy", () => {
  assert.match(migration, /create or replace function executive_visuals\.create_video_generation_budget_approval/);
  assert.match(migration, /coalesce\(auth\.role\(\),' '\) <> 'service_role'/);
  assert.match(migration, /b\.owner_id = p_owner_id and b\.project_id = p_project_id/);
  assert.match(migration, /b\.provider = p_provider and b\.model = p_model/);
  assert.match(migration, /p_approved_max_amount > policy\.max_per_job_amount/);
  assert.match(migration, /policy\.reserved_amount \+ policy\.spent_amount \+ p_approved_max_amount > policy\.spend_limit_amount/);
  assert.match(migration, /interval '15 minutes'/);
});

test("Aleph 2 SQL enqueue is restricted to MP4 video-to-video with the published minimum price floor", () => {
  assert.match(migration, /p_model in \('gen4\.5','aleph2'\)/);
  assert.match(migration, /p_provider = 'runway' and p_model = 'aleph2'/);
  assert.match(migration, /p_input ->> 'operation',''\) <> 'video-to-video'/);
  assert.match(migration, /length\(coalesce\(p_input ->> 'durationSeconds',''\)\) > 2/);
  assert.match(migration, /durationSeconds',''\)\)::numeric > 30/);
  assert.match(migration, /greatest\(0\.56, \(p_input ->> 'durationSeconds'\)::numeric \* 0\.28\)/);
  assert.match(migration, /coalesce\(p_input ->> 'outputFormat','mp4'\) <> 'mp4'/);
});
