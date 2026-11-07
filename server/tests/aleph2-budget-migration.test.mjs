import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../../supabase/migrations/20261108120000_aleph2_transformation_budget_approval.sql", import.meta.url), "utf8");
const postgresIntegration = await readFile(new URL("../../scripts/cloud-video-postgres-integration.sql", import.meta.url), "utf8");

test("Aleph 2 approval RPC is service-role-only and requires an existing scoped budget policy", () => {
  for (const contract of [
    "create or replace function executive_visuals.create_video_generation_budget_approval",
    "as $approval_trigger$",
    "security invoker",
    "current_user <> 'service_role' and new.owner_id is distinct from auth.uid()",
    "grant execute on function executive_visuals.create_video_generation_budget_approval",
    "b.owner_id = p_owner_id and b.project_id = p_project_id",
    "b.provider = p_provider and b.model = p_model",
    "p_approved_max_amount > policy.max_per_job_amount",
    "policy.reserved_amount + policy.spent_amount + p_approved_max_amount > policy.spend_limit_amount",
    "interval '15 minutes'"
  ]) assert.ok(migration.includes(contract), "Missing SQL approval contract: " + contract);
  assert.ok(!migration.includes("as $\\nbegin"), "Trigger function must use a complete dollar-quote delimiter");
  assert.ok(!migration.includes("auth.role()"), "Do not use deprecated auth.role() authorization checks");
  assert.ok(!migration.includes("security definer"), "The service-only RPC must not bypass RLS");
});

test("Aleph 2 SQL enqueue is restricted to MP4 video-to-video with the published minimum price floor", () => {
  for (const contract of [
    "p_model in ('gen4.5','aleph2')",
    "p_provider = 'runway' and p_model = 'aleph2'",
    "coalesce(p_input ->> 'operation','') <> 'video-to-video'",
    "length(coalesce(p_input ->> 'durationSeconds','')) > 2",
    "(p_input ->> 'durationSeconds')::numeric > 30",
    "greatest(0.56, (p_input ->> 'durationSeconds')::numeric * 0.28)",
    "coalesce(p_input ->> 'outputFormat','mp4') <> 'mp4'"
  ]) assert.ok(migration.includes(contract), "Missing SQL enqueue contract: " + contract);
});


test("disposable PostgreSQL harness covers Aleph 2 approval ACL, exact hash, price floor and operation gate", () => {
  for (const contract of [
    "create_video_generation_budget_approval",
    "has_function_privilege('authenticated'",
    "has_function_privilege('service_role'",
    "Aleph 2 approval was not consumed against its exact request hash",
    "VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE",
    "VIDEO_PRICE_DURATION_OR_OPERATION_INVALID"
  ]) assert.ok(postgresIntegration.includes(contract), "Missing PostgreSQL integration assertion: " + contract);
});
