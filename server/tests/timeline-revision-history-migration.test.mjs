import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const migration=await readFile(fileURLToPath(new URL("../../supabase/migrations/20261106170000_timeline_revision_history.sql",import.meta.url)),"utf8");
test("timeline revision snapshots are immutable and unique per timeline revision",()=>{
 assert.match(migration,/create table if not exists executive_visuals\.timeline_versions/);
 assert.match(migration,/unique\(timeline_id,revision\)/);
 assert.match(migration,/timeline jsonb not null/);
 assert.match(migration,/on conflict\(timeline_id,revision\) do nothing/);
});
test("existing timelines are backfilled and future revisions are captured by trigger",()=>{
 assert.match(migration,/insert into executive_visuals\.timeline_versions/);
 assert.match(migration,/from executive_visuals\.timelines/);
 assert.match(migration,/create trigger ev_timelines_capture_version/);
 assert.match(migration,/new\.revision is distinct from old\.revision/);
});
test("timeline version records are private to the server-side service role",()=>{
 assert.match(migration,/enable row level security/);
 assert.match(migration,/revoke all on executive_visuals\.timeline_versions from public,anon,authenticated/);
 assert.match(migration,/grant select on executive_visuals\.timeline_versions to service_role/);
 assert.match(migration,/revoke insert,update,delete on executive_visuals\.timeline_versions from service_role/);
});
