import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleOmniWorkerDependencies } from "../google-omni-worker-dependencies.mjs";

const ownerId="323e4567-e89b-42d3-a456-426614174000";
const projectId="423e4567-e89b-42d3-a456-426614174000";
const jobId="523e4567-e89b-42d3-a456-426614174000";
const approvalId="623e4567-e89b-42d3-a456-426614174000";
const assetId="723e4567-e89b-42d3-a456-426614174000";
const leaseToken="823e4567-e89b-42d3-a456-426614174000";
const requestHash="a".repeat(64);
const key="server-only-test-key";
const baseContext={
 jobId,ownerId,projectId,requestHash,workerId:"video-worker-1",leaseToken,
 approvedBy:ownerId,approvedAt:"2026-11-15T00:00:00.000Z",
 budgetApprovalId:approvalId,estimatedCost:{amount:2.586464,currency:"USD"}
};
const reservation={
 id:"923e4567-e89b-42d3-a456-426614174000",job_id:jobId,approval_id:approvalId,
 owner_id:ownerId,project_id:projectId,provider:"google",model:"gemini-omni-1.1-flash",
 currency:"USD",reserved_amount:"2.586464",state:"reserved"
};
const approval={
 id:approvalId,owner_id:ownerId,project_id:projectId,provider:"google",model:"gemini-omni-1.1-flash",
 request_hash:requestHash,currency:"USD",approved_max_amount:"3.000000",consumed_at:"2026-11-15T00:00:00.000Z"
};
function setup({lease=true,reservationRow=reservation,approvalRow=approval,ledgerState="submitting"}={}){
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  const parsed=new URL(url);calls.push({url:parsed.toString(),method:options.method||"GET",headers:options.headers||{}});
  let body=[];
  if(parsed.pathname.endsWith("/video_generation_budget_reservations"))body=reservationRow?[reservationRow]:[];
  else if(parsed.pathname.endsWith("/video_generation_budget_approvals"))body=approvalRow?[approvalRow]:[];
  else if(parsed.pathname.endsWith("/models/gemini-omni-1.1-flash"))body={name:"models/gemini-omni-1.1-flash"};
  else throw new Error("Unexpected fetch: "+parsed.pathname);
  return new Response(JSON.stringify(body),{status:200,headers:{"content-type":"application/json"}});
 };
 const queue={async assertLease(){return lease;}};
 const ledger={async get(){return{job_id:jobId,owner_id:ownerId,provider:"google",model:"gemini-omni-1.1-flash",request_hash:requestHash,state:ledgerState};}};
 const interactions={async findInteraction(scope){return{
  provider:"google",model:"gemini-omni-1.1-flash",interactionId:scope.interactionId,
  jobId:scope.jobId,ownerId:scope.ownerId,projectId:scope.projectId,state:"succeeded",requestHash
 };}};
 const assets={async get({ownerId:requestedOwner,assetId:requestedAsset}){assert.equal(requestedOwner,ownerId);assert.equal(requestedAsset,assetId);return{id:assetId,ownerId,projectId,mediaType:"image/png",size:100,sha256:"b".repeat(64)};}};
 const filesGateway={async resolveAsset(args){assert.deepEqual(args,{assetId,ownerId,projectId,mediaType:"image/png"});return{uri:"https://generativelanguage.googleapis.com/v1beta/files/Abc123",mediaType:"image/png",expiresAt:"2026-11-16T00:00:00.000Z"};}};
 const env={GOOGLE_OMNI_CONNECTION_STATUS:"connected",GEMINI_API_KEY:key};
 const deps=createGoogleOmniWorkerDependencies({
  url:"https://example.supabase.co",serviceRoleKey:"service-role-secret",env,fetchImpl,
  queue,ledger,interactions,assets,filesGateway,now:()=>Date.parse("2026-11-15T00:00:00.000Z")
 });
 return{deps,calls,fetchImpl};
}
test("Gemini Omni approval requires a current lease, submitting ledger and consumed matching budget reservation",async()=>{
 const {deps,calls}=setup();
 assert.equal(await deps.assertApprovedSubmission({
  plan:{policy:{provider:"google",model:"gemini-omni-1.1-flash",requiresApproval:true}},context:baseContext
 }),true);
 assert.equal(calls.length,2);
 assert.ok(calls.every(call=>call.method==="GET"));
 assert.ok(calls.every(call=>call.headers.authorization==="Bearer service-role-secret"));
});
test("Gemini Omni approval fails closed when the worker lease is lost",async()=>{
 const {deps}=setup({lease:false});
 assert.equal(await deps.assertApprovedSubmission({plan:{policy:{provider:"google",model:"gemini-omni-1.1-flash",requiresApproval:true}},context:baseContext}),false);
});
test("Gemini Omni approval fails closed when reservation or approval evidence is missing",async()=>{
 const missingReservation=setup({reservationRow:null});
 assert.equal(await missingReservation.deps.assertApprovedSubmission({plan:{policy:{provider:"google",model:"gemini-omni-1.1-flash",requiresApproval:true}},context:baseContext}),false);
 const unconsumed=setup({approvalRow:{...approval,consumed_at:null}});
 assert.equal(await unconsumed.deps.assertApprovedSubmission({plan:{policy:{provider:"google",model:"gemini-omni-1.1-flash",requiresApproval:true}},context:baseContext}),false);
});
test("Gemini Omni interaction authorization is owner, project and job scoped",async()=>{
 const {deps}=setup();
 assert.equal(await deps.authorizeInteraction({interactionId:"v1_abcdef123456",context:baseContext}),true);
 assert.equal(await deps.authorizeInteraction({interactionId:"invalid",context:baseContext}),false);
});
test("Gemini Omni text-to-video plan is approval gated and uses URI delivery",async()=>{
 const {deps}=setup({ledgerState:"prepared"});
 const plan=await deps.preparePlan({provider:"google",model:"gemini-omni-1.1-flash",requestHash,prompt:"A cinematic sunrise over Kampala.",operation:"generate",durationSeconds:5,aspectRatio:"16:9"},{job:{id:jobId,owner_id:ownerId,project_id:projectId,job_type:"video.generate",lease_owner:"video-worker-1",lease_token:leaseToken,approved_by:ownerId,approved_at:"2026-11-15T00:00:00.000Z",estimated_cost:{amount:2.586464,currency:"USD"}}});
 assert.equal(plan.policy.requiresApproval,true);
 assert.equal(plan.payload.model,"gemini-omni-1.1-flash");
 assert.deepEqual(plan.payload.response_format,{type:"video",aspect_ratio:"16:9",resolution:"720p",delivery:"uri"});
 assert.deepEqual(plan.payload.input,[{type:"text",text:"A cinematic sunrise over Kampala."}]);
 assert.equal(plan.payload.generation_config,undefined);
});
test("Gemini Omni private image references are resolved through the owner-scoped Files gateway",async()=>{
 const {deps}=setup({ledgerState:"prepared"});
 const plan=await deps.preparePlan({provider:"google",model:"gemini-omni-1.1-flash",requestHash,prompt:"Animate the reference image.",operation:"generate",durationSeconds:5,firstFrameAssetId:assetId},{job:{id:jobId,owner_id:ownerId,project_id:projectId,job_type:"video.generate",lease_owner:"video-worker-1",lease_token:leaseToken,approved_by:ownerId,approved_at:"2026-11-15T00:00:00.000Z",estimated_cost:{amount:2.586464,currency:"USD"}}});
 assert.equal(plan.payload.input[0].type,"image");
 assert.equal(plan.payload.input[0].uri,"https://generativelanguage.googleapis.com/v1beta/files/Abc123");
 assert.equal(plan.payload.generation_config.video_config.task,"image_to_video");
});
test("Gemini Omni connection verification performs a metadata GET, never a generation POST",async()=>{
 const {deps,calls}=setup();
 const result=await deps.assertConnection();
 assert.equal(result.connected,true);assert.equal(result.verified,true);
 assert.ok(result.connectionId.startsWith("gemini-key:"));
 assert.equal(calls[0].method,"GET");
 assert.ok(calls[0].url.endsWith("/v1beta/models/gemini-omni-1.1-flash"));
 assert.equal(calls[0].headers["x-goog-api-key"],key);
});
test("Gemini Omni plan rejects unsupported last-frame semantics and unapproved scopes",async()=>{
 const {deps}=setup({ledgerState:"prepared"});
 await assert.rejects(()=>deps.preparePlan({provider:"google",model:"gemini-omni-1.1-flash",requestHash,prompt:"x",durationSeconds:5,lastFrameAssetId:assetId},{job:{id:jobId,owner_id:ownerId,project_id:projectId,job_type:"video.generate",lease_owner:"video-worker-1",lease_token:leaseToken,approved_by:ownerId,approved_at:"2026-11-15T00:00:00.000Z",estimated_cost:{amount:2.586464,currency:"USD"}}}),/last-frame locking/);
 await assert.rejects(()=>deps.preparePlan({provider:"google",model:"gemini-omni-1.1-flash",requestHash,prompt:"x",durationSeconds:5,firstFrameAssetId:assetId},{job:{id:jobId,owner_id:ownerId,project_id:null,job_type:"video.generate"}}),/project/);
});
