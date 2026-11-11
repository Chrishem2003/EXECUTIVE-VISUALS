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

test("cancellation migration uses valid dollar-quoted PL/pgSQL function bodies",()=>{
 assert.equal((cancellationSql.match(/as \$\$/g)||[]).length,3);
 assert.equal((cancellationSql.match(/^\$\$;$/gm)||[]).length,3);
 assert.doesNotMatch(cancellationSql,/^as \$
/m);
});

test("cancellation migration keeps intent separate from terminal provider cancellation",()=>{
 assert.match(cancellationSql,/state in \('reserved','submitting','submission_unknown','submitted','processing','cancel_requested','succeeded','failed','cancelled'\)/i);
 assert.match(cancellationSql,/p_to_state='cancel_requested' and p_provider_status is null/i);
 assert.match(cancellationSql,/p_to_state in \('succeeded','failed','cancelled'\).*clock_timestamp\(\)/is);
 assert.match(cancellationSql,/state not in \('succeeded','failed','cancelled'\)/i);
 assert.match(cancellationSql,/set status='withdrawn'/i);
 assert.match(cancellationSql,/j\.input->>'approvalId'=changed\.approval_id::text[\s\S]*?j\.status not in \('succeeded','partial','failed','cancelled','blocked','expired'\)/i);
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

test("cloud job cancellation marks its durable provider tasks for reconciliation without assuming submission success",()=>{
 assert.match(cancellationSql,/update executive_visuals\.video_generation_tasks t[\s\S]*?set state='cancel_requested'[\s\S]*?provider_status='CANCEL_REQUESTED'/i);
 assert.match(cancellationSql,/t\.approval_id=approval_key and t\.owner_id=p_owner_id/i);
 assert.match(cancellationSql,/t\.shot_index=shot_key/i);
 assert.match(cancellationSql,/shot_key:=nullif\(existing\.input->>'shotIndex'/i);
 assert.match(cancellationSql,/t\.state in \('reserved','submitting','submission_unknown','submitted','processing'\)/i);
});

test("pending cancellation reconciliation uses a bounded cross-worker lease claim",()=>{
 assert.match(cancellationSql,/cancellation_lease_owner text/i);
 assert.match(cancellationSql,/cancellation_lease_expires_at timestamptz/i);
 assert.match(cancellationSql,/create index if not exists ev_video_task_cancellation_claim[\s\S]*?where state='cancel_requested'/i);
 assert.match(cancellationSql,/for update skip locked/i);
 assert.match(cancellationSql,/state='cancel_requested'[\s\S]*?cancellation_lease_expires_at<=clock_timestamp\(\)/i);
 assert.match(cancellationSql,/grant execute on function executive_visuals\.claim_video_generation_cancellations\(text,integer,integer\) to service_role/i);
 assert.doesNotMatch(cancellationSql,/grant execute on function executive_visuals\.claim_video_generation_cancellations\([^;]+ to (public|anon|authenticated)/i);
});

const entitlementSql=await readFile(resolve(root,"supabase/migrations/20261111230000_video_generation_entitlement_gate.sql"),"utf8");
const entitlementIntegration=await readFile(resolve(root,"scripts/asset-publication-postgres-integration.sql"),"utf8");

test("cloud video credit reservation is gated by a current subscription AI-generation entitlement",()=>{
 assert.match(entitlementSql,/status in \('active','trialing'\)/i);
 assert.match(entitlementSql,/current_period_start <= clock_timestamp\(\)/i);
 assert.match(entitlementSql,/current_period_end > clock_timestamp\(\)/i);
 assert.match(entitlementSql,/entitlements_snapshot @> '\{"ai_generation":true\}'::jsonb/i);
 assert.match(entitlementSql,/for share/i);
 assert.match(entitlementSql,/VIDEO_GENERATION_ENTITLEMENT_REQUIRED/);
 assert.match(entitlementSql,/alter function executive_visuals\.reserve_generation_credits\(uuid,uuid,bigint,text\)\s+rename to reserve_generation_credits_without_entitlement/i);
 assert.match(entitlementSql,/grant execute on function executive_visuals\.reserve_generation_credits\(uuid,uuid,bigint,text\)\s+to service_role/i);
 assert.doesNotMatch(entitlementSql,/grant execute on function executive_visuals\.reserve_generation_credits_without_entitlement/i);
 assert.doesNotMatch(entitlementSql,/\b(drop\s+table|truncate\s+table|delete\s+from)\b/i);
});

test("disposable cloud video integration rejects credit reservation without AI entitlement and accepts an active entitled subscription",()=>{
 assert.match(entitlementIntegration,/generation reservation unexpectedly succeeded without AI entitlement/i);
 assert.match(entitlementIntegration,/VIDEO_GENERATION_ENTITLEMENT_REQUIRED/);
 assert.match(entitlementIntegration,/entitlements_snapshot[\s\S]*?ai_generation/i);
 assert.doesNotMatch(entitlementIntegration,/activate_generation_subscription/);
});


const leaseSql=await readFile(resolve(root,"supabase/migrations/20261108000000_job_lease_fencing_tokens.sql"),"utf8");
const publicationSql=await readFile(resolve(root,"supabase/migrations/20261108020000_asset_publication_cleanup_claims.sql"),"utf8");
const videoFenceSql=await readFile(resolve(root,"supabase/migrations/20261111250000_cloud_video_worker_lease_fencing.sql"),"utf8");
const queueClient=await readFile(resolve(root,"server/cloud-queue.mjs"),"utf8");
const videoWorker=await readFile(resolve(root,"server/cloud-video-worker.mjs"),"utf8");
const videoSubmissionClient=await readFile(resolve(root,"server/cloud-video-submissions.mjs"),"utf8");
const videoEnqueueClient=await readFile(resolve(root,"server/cloud-video-enqueue.mjs"),"utf8");

test("cloud queue claims issue unique per-attempt tokens and fence renew, assert and finish RPCs",()=>{
 assert.match(leaseSql,/lease_token uuid/i);
 assert.match(leaseSql,/lease_token=gen_random_uuid\(\)/i);
 assert.match(leaseSql,/claim_next_job_v2/i);
 assert.match(leaseSql,/renew_job_lease_v2[\s\S]*?p_lease_token uuid/i);
 assert.match(leaseSql,/finish_job_v2[\s\S]*?p_lease_token uuid/i);
 assert.match(leaseSql,/lease_token=null/i);
 assert.match(queueClient,/claim_next_job_v2/);
 assert.match(queueClient,/renew_job_lease_v2/);
 assert.match(queueClient,/assert_job_lease_v2/);
 assert.match(queueClient,/finish_job_v2/);
 assert.match(queueClient,/LEASE_TOKEN\.test\(row\.lease_token/);
});

test("asset publication reservation and finalization lock the exact job attempt and immutable ledger identity",()=>{
 assert.match(publicationSql,/reserve_asset_publication_v2[\s\S]*?p_lease_token uuid/i);
 assert.match(publicationSql,/job_row\.lease_token is distinct from p_lease_token/i);
 assert.match(publicationSql,/finalize_asset_publication_v1[\s\S]*?p_lease_token uuid/i);
 assert.match(publicationSql,/set status = 'published'/i);
 assert.match(publicationSql,/claim_asset_publication_cleanup_v1/);
 assert.match(publicationSql,/complete_asset_publication_cleanup_v1/);
});

test("video submission, output settlement, deferral and quarantine require the current worker fencing token",()=>{
 for(const fn of [
  "prepare_video_generation_submission_v2","begin_video_generation_submission_v2","record_video_generation_submission_v2",
  "mark_video_generation_submission_unknown_v2","finish_video_generation_submission_v2",
  "finish_video_generation_job_v2","defer_video_generation_job_v2","quarantine_video_generation_job_v2"
 ]){
  assert.match(videoFenceSql,new RegExp("create or replace function executive_visuals\\."+fn+"\\([\\s\\S]*?p_lease_token uuid","i"));
  assert.match(videoFenceSql,new RegExp("grant execute on function executive_visuals\\."+fn+"\\(","i"));
 }
 assert.match(videoFenceSql,/assert_current_video_worker_lease_v1[\s\S]*?for update/i);
 assert.match(videoFenceSql,/revoke all on function executive_visuals\.finish_video_generation_job\(uuid,text,text,jsonb,jsonb,numeric\) from service_role/i);
 assert.match(videoFenceSql,/clear_job_lease_token_on_transition_v1/);
 assert.match(videoWorker,/queue\.renew\(job\.id, workerId, leaseSeconds, job\.lease_token\)/);
 assert.match(videoWorker,/enqueue\.finish\([\s\S]*?leaseToken: job\.lease_token/);
 assert.match(videoSubmissionClient,/prepare_video_generation_submission_v2/);
 assert.match(videoSubmissionClient,/begin_video_generation_submission_v2/);
 assert.match(videoSubmissionClient,/p_lease_token: leaseToken\(token\)/);
 assert.match(videoEnqueueClient,/finish_video_generation_job_v2/);
 assert.match(videoEnqueueClient,/p_lease_token: leaseToken/);
});
