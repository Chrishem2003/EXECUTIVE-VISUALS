import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../../supabase/migrations/20261117090000_fix_executive_visuals_project_rls_scope.sql", import.meta.url), "utf8");
const recursionMigration = readFileSync(new URL("../../supabase/migrations/20261117093000_remove_executive_visuals_rls_policy_recursion.sql", import.meta.url), "utf8");

test("tenant write policies correlate membership to the target row project", () => {
  const expected = [
    ["ev_workflows_insert", "workflows.project_id"],
    ["ev_workflows_update", "workflows.project_id"],
    ["ev_workflow_runs_insert", "workflow_runs.project_id"],
    ["ev_timelines_insert", "timelines.project_id"],
    ["ev_timelines_update", "timelines.project_id"],
    ["ev_assets_insert", "assets.project_id"],
    ["ev_assets_update", "assets.project_id"],
    ["ev_jobs_insert", "jobs.project_id"],
    ["ev_jobs_update", "jobs.project_id"],
    ["ev_reviews_insert", "reviews.project_id"],
    ["ev_reviews_update", "reviews.project_id"]
  ];
  for (const [policy, outerProject] of expected) {
    assert.match(migration, new RegExp("alter policy " + policy + "\\b", "i"), policy + " must be altered");
    assert.match(migration, new RegExp("m\\.project_id = " + outerProject.replace(".", "\\.") , "i"), policy + " must scope membership to " + outerProject);
  }
  assert.doesNotMatch(migration, /m\.project_id\s*=\s*m\.project_id/i);
});

test("private storage policies correlate project ownership to the stored object path", () => {
  assert.match(migration, /alter policy ev_storage_read on storage\.objects/i);
  assert.match(migration, /alter policy ev_storage_insert on storage\.objects/i);
  assert.match(migration, /alter policy ev_storage_update on storage\.objects/i);
  assert.match(migration, /alter policy ev_storage_delete on storage\.objects/i);
  assert.match(migration, /storage\.foldername\(objects\.name\)/i);
  assert.doesNotMatch(migration, /storage\.foldername\(p\.name\)/i);
});

test("project and membership policies use non-recursive security-definer helpers", () => {
  assert.match(recursionMigration, /create or replace function executive_visuals\.is_project_owner/i);
  assert.match(recursionMigration, /create or replace function executive_visuals\.has_project_role/i);
  assert.match(recursionMigration, /security definer/i);
  assert.match(recursionMigration, /set row_security = off/i);
  const policyChanges = recursionMigration.slice(recursionMigration.toLowerCase().indexOf("alter policy"));
  assert.doesNotMatch(policyChanges, /from executive_visuals\.projects/i);
  assert.doesNotMatch(policyChanges, /from executive_visuals\.project_members/i);
  for (const policy of [
    "ev_projects_read", "ev_members_read", "ev_members_insert", "ev_members_update",
    "ev_project_workspace_read", "ev_workflows_read", "ev_workflow_runs_read",
    "ev_assets_insert", "ev_jobs_insert", "ev_timelines_insert",
    "ev_reviews_insert", "ev_storage_read", "ev_storage_insert"
  ]) {
    assert.match(policyChanges, new RegExp("alter policy " + policy + "\\b", "i"));
  }
});
