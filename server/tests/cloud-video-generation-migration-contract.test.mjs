import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname,resolve} from "node:path";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const sql=await readFile(resolve(root,"supabase/migrations/20261111230000_durable_video_generation_tasks_batch_71.sql"),"utf8");
const cancellationSql=await readFile(resolve(root,"supabase/migrations/20261112000000_video_generation_task_cancellation_batch_105.sql"),"utf8");
test("cloud video ledger migration keeps both tables server-only",()=>{
 for(const table of ["video_generation_approvals","video_generation_tasks"]){
  assert.match(sql,new RegExp("alter table executive_visuals\\."+table+" enable row level security","i"));
  assert.match(sql,new RegExp("revoke all on executive_visuals\\."+table+" from public,anon,authenticated","i"));
 }
});
test("cloud video RPCs are revoked from client roles and granted only to service role",()=>{
 for(const fn of ["register_video_generation_approval","enqueue_approved_video_generation","reserve_video_generation_task","transition_video_generation_task"]){
  assert.match(sql,new RegExp("revoke all on function executive_visuals\\."+fn+"\\(","i"));
  assert.match(sql,new RegExp("grant execute on function executive_visuals\\."+fn+"\\([^;]+ to service_role","i"));
 }
});
test("cloud approval registration, enqueue and task reservation all revalidate active owner/editor membership",()=>{
 assert.equal(sql.split("pm.member_id=p_owner_id").length-1,3);
 assert.equal(sql.split("pm.role in ('editor')").length-1,3);
 assert.equal(sql.split("p.archived_at is null").length-1>=3,true);
});
test("task reservation serializes on approval and enforces the approved shot quote and budget ceiling",()=>{
 assert.match(sql,/where id=p_approval_id and owner_id=p_owner_id and project_id=p_project_id\s+for update/i);
 assert.match(sql,/VIDEO_APPROVAL_SHOT_PRICE_MISMATCH/);
 assert.match(sql,/reserved_total\+p_estimated_cost_micros>approval\.budget_ceiling_micros/);
 assert.match(sql,/unique\(approval_id,shot_index\)/i);
});
test("approval completion waits until every approved shot has succeeded",()=>{
 assert.match(sql,/count\(t\.id\)=jsonb_array_length\(a\.snapshot_json->'shots'\)/i);
 assert.match(sql,/bool_and\(t\.state='succeeded'\)/i);
});
test("migration is additive and does not drop or truncate existing production data",()=>{
 assert.doesNotMatch(sql,/\b(drop\s+table|truncate\s+table|delete\s+from)\b/i);
});


test("Fal is accepted by the approval snapshot and persisted in the durable task ledger",()=>{
 assert.match(sql,/provider text not null default 'runway' check \(provider in \('runway','fal'\)\)/i);
 assert.match(sql,/coalesce\(shot->>'provider',''\) not in \('runway','fal'\)/i);
 assert.match(sql,/estimated_cost_micros,provider,model\)[\s\S]*?shot->>'provider',shot->>'model'/i);
});

test("cancellation migration keeps intent separate from terminal provider cancellation",()=>{
 assert.match(cancellationSql,/state in \('reserved','submitting','submission_unknown','submitted','processing','cancel_requested','succeeded','failed','cancelled'\)/i);
 assert.match(cancellationSql,/p_to_state='cancel_requested' and p_provider_status is null/i);
 assert.match(cancellationSql,/p_to_state in \('succeeded','failed','cancelled'\).*clock_timestamp\(\)/is);
 assert.match(cancellationSql,/state not in \('succeeded','failed','cancelled'\)/i);
 assert.match(cancellationSql,/set status='withdrawn'/i);
});
test("cancellation transition RPC remains service-role-only and preserves additive migration safety",()=>{
 assert.match(cancellationSql,/revoke all on function executive_visuals\.transition_video_generation_task\(/i);
 assert.match(cancellationSql,/grant execute on function executive_visuals\.transition_video_generation_task\([^;]+ to service_role/i);
 assert.doesNotMatch(cancellationSql,/\b(drop\s+table|truncate\s+table|delete\s+from)\b/i);
});

test("cloud video job cancellation is restricted to the authenticated owner and the video job type",()=>{
 assert.match(cancellationSql,/where id=p_job_id and owner_id=p_owner_id and job_type='video\.generate\.shot'/i);
 assert.match(cancellationSql,/status in \('queued','processing'\)/i);
 assert.match(cancellationSql,/set status='cancelled'/i);
 assert.match(cancellationSql,/lease_owner=null/i);
 assert.match(cancellationSql,/insert into executive_visuals\.job_events/i);
 assert.match(cancellationSql,/grant execute on function executive_visuals\.cancel_video_generation_job\(uuid,uuid\) to service_role/i);
 assert.doesNotMatch(cancellationSql,/grant execute on function executive_visuals\.cancel_video_generation_job\([^;]+ to (public|anon|authenticated)/i);
});
