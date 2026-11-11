import test from "node:test";
import assert from "node:assert/strict";
import {createCloudVideoGenerationRepositories} from "../cloud-video-generation-repositories.mjs";

const approvalRow={id:"approval-1",owner_id:"owner-1",project_id:"project-1",request_hash:"a".repeat(64),snapshot_json:{shots:[{model:"seedance2_5",estimatedCostMicros:1250000}]},currency:"USD",quoted_amount_micros:1250000,budget_ceiling_micros:2000000,status:"approved_pending_submission"};
const lease={jobId:"job-1",workerId:"worker-1",leaseToken:"923e4567-e89b-42d3-a456-426614174000"};
const taskRow={id:"task-1",state:"reserved",provider_task_id:null,provider:"runway",model:"seedance2_5",estimated_cost_credits:null,output_asset_id:null,shot_index:0,estimated_cost_micros:1250000,currency:"USD"};
function harness(){
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  calls.push({url:String(url),method:options.method||"GET",headers:options.headers||{},body:options.body?JSON.parse(options.body):null});
  if(String(url).includes("video_generation_approvals?"))return new Response(JSON.stringify([approvalRow]),{status:200});
  if(String(url).includes("register_video_generation_approval"))return new Response(JSON.stringify([approvalRow]),{status:200});
  if(String(url).includes("reserve_video_generation_task"))return new Response(JSON.stringify([taskRow]),{status:200});
  if(String(url).includes("transition_video_generation_task")){const payload=typeof options.body==="string"?JSON.parse(options.body):options.body;return new Response(JSON.stringify([{...taskRow,state:payload?.p_to_state||"submitted",provider:payload?.p_provider||"runway",provider_status:payload?.p_provider_status||null,provider_task_id:"123e4567-e89b-42d3-a456-426614174000"}]),{status:200});}
  if(String(url).includes("enqueue_approved_video_generation"))return new Response(JSON.stringify([{job_id:"job-1",shot_index:0,job_status:"queued"}]),{status:200});
  return new Response("[]",{status:200});
 };
 const repositories=createCloudVideoGenerationRepositories({url:"https://example.supabase.co",serviceRoleKey:"server-secret",fetchImpl});
 return{...repositories,calls};
}
test("approval lookup is constrained by approval, owner and project",async()=>{
 const h=harness();const row=await h.approvals.get("approval-1",{ownerId:"owner-1",projectId:"project-1"});
 assert.equal(row.ownerId,"owner-1");assert.equal(row.shots.length,1);
 const call=h.calls[0];assert.ok(call.url.includes("id=eq.approval-1"));assert.ok(call.url.includes("owner_id=eq.owner-1"));assert.ok(call.url.includes("project_id=eq.project-1"));
 assert.equal(call.headers["accept-profile"],"executive_visuals");
});
test("approval registration uses the atomic idempotency RPC",async()=>{
 const h=harness();const row=await h.approvals.register({id:"approval-1",ownerId:"owner-1",projectId:"project-1",idempotencyKey:"approval-key-1",requestHash:"a".repeat(64),snapshotJson:approvalRow.snapshot_json,currency:"USD",quotedAmountMicros:1250000,budgetCeilingMicros:2000000});
 assert.equal(row.id,"approval-1");assert.ok(h.calls[0].url.endsWith("/rpc/register_video_generation_approval"));
 assert.equal(h.calls[0].body.p_owner_id,"owner-1");assert.equal(h.calls[0].body.p_budget_ceiling_micros,2000000);
});
test("task reservation and state changes use atomic server RPCs",async()=>{
 const h=harness();const task=await h.tasks.reserveSubmission({...lease,approvalId:"approval-1",shotIndex:0,ownerId:"owner-1",projectId:"project-1",requestHash:"a".repeat(64),currency:"USD",estimatedCostMicros:1250000});
 assert.equal(task.id,"task-1");assert.equal(task.estimatedCostMicros,1250000);
 const changed=await h.tasks.markSubmitted("task-1",{providerTaskId:"123e4567-e89b-42d3-a456-426614174000",model:"seedance2_5",estimatedCostCredits:20},lease);
 assert.equal(changed.state,"submitted");assert.equal(changed.provider,"runway");
 assert.ok(h.calls[0].url.endsWith("/rpc/reserve_video_generation_task_v2"));
 assert.ok(h.calls[1].url.endsWith("/rpc/transition_video_generation_task_v2"));
 assert.deepEqual(h.calls[1].body.p_from_states,["submitting"]);assert.equal(h.calls[1].body.p_to_state,"submitted");
});
test("enqueue returns the shot jobs from the approval-scoped enqueue RPC",async()=>{
 const h=harness();const jobs=await h.approvals.enqueue("approval-1","owner-1");
 assert.deepEqual(jobs,[{jobId:"job-1",shotIndex:0,status:"queued"}]);
 assert.ok(h.calls[0].url.endsWith("/rpc/enqueue_approved_video_generation"));
});
test("repository refuses missing service credentials and invalid project-scoped lookups",async()=>{
 assert.throws(()=>createCloudVideoGenerationRepositories({url:"https://example.supabase.co",serviceRoleKey:""}),/server-side Supabase credentials/);
 const h=harness();await assert.rejects(()=>h.approvals.get("approval-1",{ownerId:"owner-1"}),e=>e.code==="VIDEO_APPROVAL_SCOPE_INVALID");
});

test("Fal provider identity is persisted through the atomic submitted transition",async()=>{
 const h=harness();
 const changed=await h.tasks.markSubmitted("task-1",{providerTaskId:"123e4567-e89b-42d3-a456-426614174000",provider:"fal",model:"fal-ai/example-video",estimatedCostCredits:20},lease);
 assert.equal(changed.provider,"fal");
 const call=h.calls.find(item=>item.url.endsWith("/rpc/transition_video_generation_task_v2"));
 assert.equal(call.body.p_provider,"fal");
 assert.equal(call.body.p_model,"fal-ai/example-video");
});

test("durable task repository records cancellation intent and confirmed cancellation",async()=>{
 const h=harness();
 const requested=await h.tasks.markCancellationRequested("task-1",{providerStatus:"CANCEL_REQUESTED"},lease);
 assert.equal(requested.state,"cancel_requested");
 const cancelled=await h.tasks.markCancelled("task-1",{providerStatus:"OK"},lease);
 assert.equal(cancelled.state,"cancelled");
 const transitions=h.calls.filter(item=>item.url.endsWith("/rpc/transition_video_generation_task"));
 assert.deepEqual(transitions.map(item=>item.body.p_to_state),["cancel_requested","cancelled"]);
 assert.equal(transitions[0].body.p_provider_status,"CANCEL_REQUESTED");
 assert.equal(transitions[1].body.p_provider_status,"OK");
});

test("cancellation reconciliation claims are worker-scoped RPC leases",async()=>{
 const h=harness();
 const rows=await h.tasks.claimCancellationPending("worker-7",15);
 assert.deepEqual(rows,[]);
 const call=h.calls.find(item=>item.url.includes("claim_video_generation_cancellations"));
 assert.ok(call);
 assert.deepEqual(call.body,{p_worker_id:"worker-7",p_limit:15,p_lease_seconds:60});
 await assert.rejects(()=>h.tasks.claimCancellationPending("",15),e=>e.code==="VIDEO_TASK_QUERY_INVALID");
});

test("cancellation reconciliation transitions use their independent task-row lease",async()=>{
 const h=harness();
 const changed=await h.tasks.markCancelledByReconciler("task-1",{providerStatus:"CANCELLED"},"cancel-worker-1");
 assert.equal(changed.state,"cancelled");
 const call=h.calls.find(item=>item.url.endsWith("/rpc/transition_video_generation_task_reconciliation_v1"));
 assert.ok(call);
 assert.equal(call.body.p_worker_id,"cancel-worker-1");
 assert.equal(call.body.p_to_state,"cancelled");
 assert.equal(call.body.p_provider_status,"CANCELLED");
});
