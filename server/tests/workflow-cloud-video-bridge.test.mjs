import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCloudVideoWorkflowNode } from "../workflow-cloud-video-bridge.mjs";
import { createVideoWorkflowCloudRequest } from "../video-workflow-cloud-contract.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const projectId="423e4567-e89b-42d3-a456-426614174000";
const runId="523e4567-e89b-42d3-a456-426614174000";
const jobId="623e4567-e89b-42d3-a456-426614174000";
const cloudJobId="723e4567-e89b-42d3-a456-426614174000";
const cloudAssetId="823e4567-e89b-42d3-a456-426614174000";
const quoteId="923e4567-e89b-42d3-a456-426614174000";
const video=Buffer.from("0000ftypisom0000");
const sha256=createHash("sha256").update(video).digest("hex");

function fixture({budget=2,jobStatus="running",cloudStatus="succeeded",priorOutput=null,values={},assetProjectId=projectId,assetMediaType="video/mp4",existingAsset=null}={}){
 const stored=[],calls=[];
 const localJob={status:jobStatus,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000",lease_expires_at:new Date(Date.now()+60000).toISOString(),lease_token:"a23e4567-e89b-42d3-a456-426614174000"};
 const db={prepare(sql){
  if(sql.startsWith("SELECT id,owner_id,name,description FROM projects"))return{get:()=>({id:projectId,owner_id:owner,name:"Project",description:""})};
  if(sql.startsWith("SELECT * FROM assets WHERE id=? AND deleted_at IS NULL"))return{get:id=>[values.sourceVideoAssetId,values.startFrameAssetId,values.endFrameAssetId,...(values.keyframeAssetIds||[])].includes(id)?{id,owner_id:owner,project_id:assetProjectId,original_name:assetMediaType.startsWith("image/")?"frame.png":"source.mp4",media_type:assetMediaType,byte_size:video.length,sha256,storage_path:assetMediaType.startsWith("image/")?"uploads/frame.png":"uploads/source.mp4",metadata_json:"{}"}:null};
  if(sql.startsWith("SELECT * FROM projects WHERE id=? AND archived_at IS NULL"))return{get:id=>id===projectId?{id:projectId,owner_id:owner}:id===assetProjectId?{id:assetProjectId,owner_id:owner}:null};
  if(sql.startsWith("SELECT role FROM project_members"))return{get:()=>null};
  if(sql.startsWith("SELECT status,lease_owner,lease_expires_at,lease_token FROM jobs"))return{get:()=>localJob};
  if(sql.startsWith("SELECT output_json FROM workflow_node_runs"))return{get:()=>priorOutput?{output_json:JSON.stringify(priorOutput)}:null};
  if(sql.startsWith("SELECT id,metadata_json,storage_path,byte_size,sha256,media_type FROM assets"))return{get:()=>existingAsset};
  if(sql.startsWith("INSERT INTO assets"))return{run(...args){stored.push({sql,args});}};
  if(sql.startsWith("UPDATE assets SET metadata_json"))return{run(...args){stored.push({sql,args});}};
  throw new Error("Unexpected SQL in workflow bridge test: "+sql);
 }};
 const cloudTimelineApi={
  async handle(input){
   calls.push(input);
   if(input.method==="GET"&&input.path==="/api/cloud/projects/"+projectId)return{status:200,body:{project:{id:projectId}}};
   if(input.method==="POST"&&input.path==="/api/cloud/workflows/video/quote"){const quotedRequest=createVideoWorkflowCloudRequest({node:input.body.node,values:input.body.values,projectId,requestId:request.requestId});return{status:200,body:{quote:{id:quoteId,requestId:quotedRequest.requestId,requestHash:quotedRequest.requestHash,provider:"runway",model:"seedance2_5",operation:"generate",routedProvider:"runway",estimatedCredits:42,estimatedAmount:1,currency:"USD",pricingSource:"runway_model_router_dry_run",pricingUrl:"https://docs.dev.runwayml.com/guides/pricing/",expiresAt:"2026-11-30T23:59:00.000Z",paidExecutionEnabled:true,billable:false,requiresExplicitApproval:true,routedModel:"routed-video-model",configId:"runway-direct-seedance-2-5"}}};}
   if(input.method==="POST"&&input.path==="/api/cloud/workflows/video/approve"){
    if(input.body.approvedMaxAmount<1)return{status:409,body:{error:{code:"VIDEO_WORKFLOW_BUDGET_BELOW_QUOTE",message:"Budget below quote"}}};
    return{status:202,body:{job:{id:cloudJobId,status:"queued"}}};
   }
   if(input.method==="GET"&&input.path==="/api/cloud/jobs/"+cloudJobId)return{status:200,body:{job:{id:cloudJobId,owner_id:owner,project_id:projectId,job_type:"video.generate",input:{workflowQuoteId:quoteId,workflowRequestId:request.requestId,requestHash:request.requestHash,approvedMaxAmount:2},status:cloudStatus,output:cloudStatus==="succeeded"?{assetIds:[cloudAssetId],model:"routed-video-model",usage:{seconds:5},actualAmount:0.72,currency:"USD",costEvidenceReference:"cost:verified"}:null}}};
   if(input.method==="GET"&&input.path==="/api/cloud/assets/"+cloudAssetId)return{status:200,body:{asset:{id:cloudAssetId,projectId,mediaType:"video/mp4",size:video.length,sha256},url:"https://supabase.example/storage/v1/object/sign/video"}};
   if(input.method==="POST"&&input.path==="/api/cloud/jobs/"+cloudJobId+"/cancel")return{status:202,body:{}};
   throw new Error("Unexpected cloud API call: "+input.method+" "+input.path);
  },
  async uploadAsset({req,ownerId:uploadOwner,projectId:uploadProject,originalName,mediaType}){const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);calls.push({method:"UPLOAD",ownerId:uploadOwner,projectId:uploadProject,originalName,mediaType,bytes,streaming:!Buffer.isBuffer(req),declaredLength:req.headers?.["content-length"]||""});return{status:201,body:{asset:{id:"a23e4567-e89b-42d3-a456-426614174000",ownerId:uploadOwner,projectId:uploadProject,name:originalName,mediaType,size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")}}};}
 };
 const node={id:"video-node",kind:"video.generate",config:{provider:"runway",model:"model-router",prompt:"A cinematic sunrise over a quiet lake.",durationSeconds:5,approvedMaxAmount:budget},outputs:[{id:"video",type:"video"}]};
 const requestId="workflow-"+createHash("sha256").update(runId+":"+node.id).digest("hex");
 const request=createVideoWorkflowCloudRequest({node,values,projectId,requestId});
 return{db,stored,calls,localJob,cloudTimelineApi,node,request,values};
}

test("Luma multi-keyframe workflow privately transfers every anchor before creating its quote",async()=>{
 const frameId="b23e4567-e89b-42d3-a456-426614174000";
 const f=fixture({values:{keyframeAssetIds:[frameId],keyframeIndexes:[0]},assetMediaType:"image/png"});
 f.node.config={provider:"luma",model:"ray-3.2",prompt:"A continuous cinematic camera move",durationSeconds:5,aspectRatio:"16:9",resolution:"720p",rightsConfirmed:true};
 const mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-luma-keyframes-")),prior=process.env.SUPABASE_URL;
 process.env.SUPABASE_URL="https://supabase.example";
 try{
  await mkdir(join(mediaRoot,"uploads"),{recursive:true});
  await writeFile(join(mediaRoot,"uploads","frame.png"),video);
  const result=await executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:f.values,mediaRoot,cloudTimelineApi:f.cloudTimelineApi,
   probeMedia:async()=>({format:{duration:"1.5"},streams:[{codec_type:"video",duration:"1.5"}]})
  });
  assert.equal(result.awaitingApproval,true);
  const upload=f.calls.find(call=>call.method==="UPLOAD");
  assert.ok(upload);
  assert.equal(upload.ownerId,owner);
  assert.equal(upload.projectId,projectId);
  assert.equal(upload.originalName,"frame.png");
  assert.equal(upload.mediaType,"image/png");
  const quote=f.calls.find(call=>call.path==="/api/cloud/workflows/video/quote");
  assert.deepEqual(quote.body.values.keyframeAssetIds,["a23e4567-e89b-42d3-a456-426614174000"]);
  assert.deepEqual(quote.body.values.keyframeIndexes,[0]);
  assert.equal(quote.body.node.config.rightsConfirmed,true);
 }finally{
  if(prior===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior;
  await rm(mediaRoot,{recursive:true,force:true});
 }
});
test("Luma last-frame workflow privately transfers its anchor into the linked cloud project",async()=>{
 const frameId="b23e4567-e89b-42d3-a456-426614174003";
 const f=fixture({values:{endFrameAssetId:frameId},assetMediaType:"image/png"});
 f.node.config={provider:"luma",model:"ray-3.2",prompt:"Animate toward the final composition",durationSeconds:5,aspectRatio:"16:9",resolution:"720p",rightsConfirmed:true};
 const mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-luma-end-frame-")),prior=process.env.SUPABASE_URL;
 process.env.SUPABASE_URL="https://supabase.example";
 try{
  await mkdir(join(mediaRoot,"uploads"),{recursive:true});
  await writeFile(join(mediaRoot,"uploads","frame.png"),video);
  const result=await executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:f.values,mediaRoot,cloudTimelineApi:f.cloudTimelineApi
  });
  assert.equal(result.awaitingApproval,true);
  assert.equal(f.calls.find(call=>call.method==="UPLOAD")?.mediaType,"image/png");
  const quote=f.calls.find(call=>call.path==="/api/cloud/workflows/video/quote");
  assert.equal(quote.body.values.endFrameAssetId,"a23e4567-e89b-42d3-a456-426614174000");
 }finally{
  if(prior===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior;
  await rm(mediaRoot,{recursive:true,force:true});
 }
});
test("Luma source-video edit privately transfers the project video before quoting",async()=>{
 const sourceId="b23e4567-e89b-42d3-a456-426614174021";
 const f=fixture({values:{sourceVideoAssetId:sourceId},assetMediaType:"video/mp4"});
 f.node.config={provider:"luma",model:"ray-3.2",operation:"edit",prompt:"Replace the background",durationSeconds:5,aspectRatio:"16:9",resolution:"720p",editStrength:"flex_2",rightsConfirmed:true};
 const mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-luma-edit-")),prior=process.env.SUPABASE_URL;
 process.env.SUPABASE_URL="https://supabase.example";
 try{
  await mkdir(join(mediaRoot,"uploads"),{recursive:true});
  await writeFile(join(mediaRoot,"uploads","source.mp4"),video);
  const result=await executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:f.values,mediaRoot,cloudTimelineApi:f.cloudTimelineApi,
   probeMedia:async()=>({format:{duration:"5"},streams:[{codec_type:"video",duration:"5"}]})
  });
  assert.equal(result.awaitingApproval,true);
  const upload=f.calls.find(call=>call.method==="UPLOAD");
  assert.ok(upload);
  assert.equal(upload.ownerId,owner);
  assert.equal(upload.projectId,projectId);
  assert.equal(upload.mediaType,"video/mp4");
  const quote=f.calls.find(call=>call.path==="/api/cloud/workflows/video/quote");
  assert.equal(quote.body.node.config.operation,"edit");
  assert.equal(quote.body.values.sourceVideoAssetId,"a23e4567-e89b-42d3-a456-426614174000");
 }finally{
  if(prior===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior;
  await rm(mediaRoot,{recursive:true,force:true});
 }
});
test("cloud workflow node creates a non-billable quote and pauses without approving or enqueueing",async()=>{
 const f=fixture(),mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-quote-test-")),prior=process.env.SUPABASE_URL;
 process.env.SUPABASE_URL="https://supabase.example";
 let approvalReceipt=null;
 try{
  const result=await executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi,
   onApprovalRequired:receipt=>{approvalReceipt=receipt;}
  });
  assert.equal(result.awaitingApproval,true);
  assert.equal(result.quoteId,quoteId);
  assert.equal(result.requestHash,f.request.requestHash);
  assert.equal(approvalReceipt.quoteId,quoteId);
  assert.equal(approvalReceipt.requestHash,f.request.requestHash);
  assert.equal(approvalReceipt.provider,"runway");
  assert.equal(approvalReceipt.model,"seedance2_5");
  assert.equal(approvalReceipt.operation,"generate");
  assert.equal(approvalReceipt.routedProvider,"runway");
  assert.equal(approvalReceipt.estimatedCredits,42);
  assert.equal(approvalReceipt.pricingSource,"runway_model_router_dry_run");
  assert.equal(approvalReceipt.pricingUrl,"https://docs.dev.runwayml.com/guides/pricing/");
  assert.equal(approvalReceipt.paidExecutionEnabled,true);
  assert.equal(f.calls.filter(call=>call.path==="/api/cloud/workflows/video/quote").length,1);
  assert.equal(f.calls.some(call=>call.path==="/api/cloud/workflows/video/approve"),false);
  assert.equal(f.calls.some(call=>call.path==="/api/cloud/jobs/"+cloudJobId),false);
  assert.equal(f.stored.filter(item=>item.sql.startsWith("INSERT INTO assets")).length,0);
 }finally{
  if(prior===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior;
  await rm(mediaRoot,{recursive:true,force:true});
 }
});

test("configured budget ceiling is not treated as human approval",async()=>{
 const f=fixture({budget:200}),mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-no-auto-approval-"));
 try{
  const result=await executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi
  });
  assert.equal(result.awaitingApproval,true);
  assert.equal(f.calls.some(call=>call.path==="/api/cloud/workflows/video/approve"),false);
 }finally{await rm(mediaRoot,{recursive:true,force:true});}
});

test("cloud workflow uploads a checksum-verified local source into the same private cloud project before quoting",async()=>{
 const sourceId="b23e4567-e89b-42d3-a456-426614174000";
 const f=fixture({values:{prompt:"Transform the source clip",sourceVideoAssetId:sourceId}});
 f.node.config.rightsConfirmed=true;
 const mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-source-handoff-")),prior=process.env.SUPABASE_URL;
 process.env.SUPABASE_URL="https://supabase.example";
 try{
  await mkdir(join(mediaRoot,"uploads"),{recursive:true});
  await writeFile(join(mediaRoot,"uploads","source.mp4"),video);
  const result=await executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:f.values,mediaRoot,cloudTimelineApi:f.cloudTimelineApi,
   probeMedia:async()=>({format:{duration:"1.5"},streams:[{codec_type:"video",duration:"1.5"}]})
  });
  const upload=f.calls.find(call=>call.method==="UPLOAD");
  assert.equal(result.awaitingApproval,true);
  assert.equal(upload.ownerId,owner);
  assert.equal(upload.projectId,projectId);
  assert.equal(upload.originalName,"source.mp4");
  assert.equal(upload.mediaType,"video/mp4");
  assert.equal(upload.streaming,true);
  assert.equal(upload.declaredLength,String(video.length));
  assert.deepEqual(upload.bytes,video);
  const quote=f.calls.find(call=>call.path==="/api/cloud/workflows/video/quote");
  assert.equal(quote.body.values.sourceVideoAssetId,"a23e4567-e89b-42d3-a456-426614174000");
  assert.equal(quote.body.node.config.rightsConfirmed,true);
  const metadataUpdate=f.stored.find(item=>item.sql.startsWith("UPDATE assets SET metadata_json"));
  assert.ok(metadataUpdate);
  const savedMetadata=JSON.parse(metadataUpdate.args[0]);
  assert.deepEqual(savedMetadata.cloudWorkspace,{assetId:"a23e4567-e89b-42d3-a456-426614174000",projectId,sha256});
 }finally{
  if(prior===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior;
  await rm(mediaRoot,{recursive:true,force:true});
 }
});

test("cloud workflow rejects a video source without a verifiable video stream before upload or quote",async()=>{
 const sourceId="b23e4567-e89b-42d3-a456-426614174000";
 const f=fixture({values:{prompt:"Transform the source clip",sourceVideoAssetId:sourceId}});
 f.node.config.rightsConfirmed=true;
 const mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-invalid-source-media-"));
 try{
  await mkdir(join(mediaRoot,"uploads"),{recursive:true});
  await writeFile(join(mediaRoot,"uploads","source.mp4"),video);
  await assert.rejects(()=>executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:f.values,mediaRoot,cloudTimelineApi:f.cloudTimelineApi,
   probeMedia:async()=>({format:{duration:"1.5"},streams:[{codec_type:"audio",duration:"1.5"}]})
  }),error=>error.code==="VIDEO_WORKFLOW_INPUT_MEDIA_INVALID");
  assert.equal(f.calls.some(call=>call.method==="UPLOAD"),false);
  assert.equal(f.calls.some(call=>call.path==="/api/cloud/workflows/video/quote"),false);
 }finally{await rm(mediaRoot,{recursive:true,force:true});}
});

test("cloud workflow refuses source assets from a different project before upload or quote",async()=>{
 const sourceId="b23e4567-e89b-42d3-a456-426614174000";
 const otherProjectId="c23e4567-e89b-42d3-a456-426614174000";
 const f=fixture({values:{prompt:"Transform the source clip",sourceVideoAssetId:sourceId},assetProjectId:otherProjectId});
 f.node.config.rightsConfirmed=true;
 const mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-cross-project-"));
 try{
  await assert.rejects(()=>executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:f.values,mediaRoot,cloudTimelineApi:f.cloudTimelineApi
  }),error=>error.code==="VIDEO_WORKFLOW_INPUT_ASSET_FORBIDDEN");
  assert.equal(f.calls.some(call=>call.method==="UPLOAD"),false);
  assert.equal(f.calls.some(call=>call.path==="/api/cloud/workflows/video/quote"),false);
 }finally{await rm(mediaRoot,{recursive:true,force:true});}
});

test("cloud workflow rejects a source file whose checksum differs from the persisted asset record",async()=>{
 const sourceId="b23e4567-e89b-42d3-a456-426614174000";
 const f=fixture({values:{prompt:"Transform the source clip",sourceVideoAssetId:sourceId}});
 f.node.config.rightsConfirmed=true;
 const mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-source-checksum-"));
 try{
  await mkdir(join(mediaRoot,"uploads"),{recursive:true});
  await writeFile(join(mediaRoot,"uploads","source.mp4"),Buffer.alloc(video.length,7));
  await assert.rejects(()=>executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:f.values,mediaRoot,cloudTimelineApi:f.cloudTimelineApi
  }),error=>error.code==="VIDEO_WORKFLOW_INPUT_ASSET_CHECKSUM_MISMATCH");
  assert.equal(f.calls.some(call=>call.method==="UPLOAD"),false);
  assert.equal(f.calls.some(call=>call.path==="/api/cloud/workflows/video/quote"),false);
 }finally{await rm(mediaRoot,{recursive:true,force:true});}
});

test("cloud workflow requires explicit source/reference rights confirmation before private upload",async()=>{
 const sourceId="b23e4567-e89b-42d3-a456-426614174000";
 const f=fixture({values:{prompt:"Transform the source clip",sourceVideoAssetId:sourceId}});
 const mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-rights-"));
 try{
  await assert.rejects(()=>executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:f.values,mediaRoot,cloudTimelineApi:f.cloudTimelineApi
  }),error=>error.code==="MEDIA_RIGHTS_REQUIRED");
  assert.equal(f.calls.some(call=>call.method==="UPLOAD"),false);
  assert.equal(f.calls.some(call=>call.path==="/api/cloud/workflows/video/quote"),false);
 }finally{await rm(mediaRoot,{recursive:true,force:true});}
});

test("cloud workflow node refuses to run without an authenticated cloud API",async()=>{
 await assert.rejects(()=>executeCloudVideoWorkflowNode({}),error=>error.code==="VIDEO_WORKFLOW_CLOUD_DISABLED");
});

test("expired local worker lease cannot continue polling or import cloud video output",async()=>{
 const seed=fixture(),priorOutput={cloudJobId,quoteId,requestId:seed.request.requestId,requestHash:seed.request.requestHash,
  routedModel:"routed-video-model",approvedMaxAmount:2,status:"queued"};
 const f=fixture({priorOutput}),mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-expired-lease-"));
 f.localJob.lease_expires_at=new Date(Date.now()-1000).toISOString();
 try{
  await assert.rejects(()=>executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi
  }),error=>error.code==="WORKFLOW_WORKER_LEASE_LOST");
  assert.equal(f.calls.some(call=>call.path==="/api/cloud/jobs/"+cloudJobId),false);
  assert.equal(f.stored.filter(item=>item.sql.startsWith("INSERT INTO assets")).length,0);
 }finally{await rm(mediaRoot,{recursive:true,force:true});}
});

test("replaced local worker lease token cannot continue polling or import cloud video output",async()=>{
 const seed=fixture(),priorOutput={cloudJobId,quoteId,requestId:seed.request.requestId,requestHash:seed.request.requestHash,
  routedModel:"routed-video-model",approvedMaxAmount:2,status:"queued"};
 const f=fixture({priorOutput}),mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-replaced-lease-"));
 f.localJob.lease_token="b23e4567-e89b-42d3-a456-426614174000";
 try{
  await assert.rejects(()=>executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi
  }),error=>error.code==="WORKFLOW_WORKER_LEASE_LOST");
  assert.equal(f.calls.some(call=>call.path==="/api/cloud/jobs/"+cloudJobId),false);
  assert.equal(f.stored.filter(item=>item.sql.startsWith("INSERT INTO assets")).length,0);
 }finally{await rm(mediaRoot,{recursive:true,force:true});}
});

test("cloud job receipt with a changed approved spending ceiling is rejected before output import",async()=>{
 const seed=fixture(),priorOutput={cloudJobId,quoteId,requestId:seed.request.requestId,requestHash:seed.request.requestHash,
  routedModel:"routed-video-model",approvedMaxAmount:3,status:"queued"};
 const f=fixture({priorOutput}),mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-ceiling-mismatch-"));
 try{
  await assert.rejects(()=>executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi
  }),error=>error.code==="VIDEO_WORKFLOW_JOB_RECEIPT_MISMATCH");
  assert.equal(f.stored.filter(item=>item.sql.startsWith("INSERT INTO assets")).length,0);
 }finally{await rm(mediaRoot,{recursive:true,force:true});}
});

test("approved cloud receipt resumes polling and imports checksum-verified private output",async()=>{
 const seed=fixture(),priorOutput={cloudJobId,quoteId,requestId:seed.request.requestId,requestHash:seed.request.requestHash,
  routedModel:"routed-video-model",approvedMaxAmount:2,status:"queued"};
 const f=fixture({priorOutput}),mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-resume-test-")),prior=process.env.SUPABASE_URL;
 process.env.SUPABASE_URL="https://supabase.example";
 try{
  const result=await executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi,
   fetchImpl:async()=>new Response(video,{status:200,headers:{"content-length":String(video.length)}}),
   verifyC2paAsset:async input=>{
    assert.equal(input.mediaType,"video/mp4");
    assert.equal(input.expectedSha256,sha256);
    assert.equal(input.expectedSize,video.length);
    assert.ok(input.filePath.endsWith(".mp4"));
    return{status:"valid_untrusted",present:true,valid:true,trusted:false,validationState:"Valid",findings:[]};
   }
  });
  assert.equal(result.provider,"runway");
  assert.equal(result.cloudJobId,cloudJobId);
  assert.equal(result.assetIds.length,1);
  assert.deepEqual(result.cloudAssetIds,[cloudAssetId]);
  assert.equal(result.durationSeconds,5);
  assert.equal(result.costEvidenceReference,"cost:verified");
  assert.equal(result.actualAmount,0.72);
  assert.equal(result.currency,"USD");
  assert.deepEqual(result.assetProvenance,[{assetId:result.assetId,status:"valid_untrusted",present:true,valid:true,trusted:false,validationState:"Valid",findings:[]}]);
  const metadataUpdate=f.stored.find(item=>item.sql.startsWith("UPDATE assets SET metadata_json"));
  assert.ok(metadataUpdate,"C2PA verification snapshot must be persisted with the imported private asset");
  assert.equal(JSON.parse(metadataUpdate.args[0]).c2paVerification.status,"valid_untrusted");
  assert.equal(f.calls.some(call=>call.path==="/api/cloud/workflows/video/quote"),false);
  assert.equal(f.calls.some(call=>call.path==="/api/cloud/workflows/video/approve"),false);
  assert.equal(f.stored.filter(item=>item.sql.startsWith("INSERT INTO assets")).length,1);
  const inserted=f.stored.find(item=>item.sql.startsWith("INSERT INTO assets"));
  const metadata=JSON.parse(inserted.args[8]);
  assert.equal(metadata.cloudWorkspaceAssetId,cloudAssetId);
  assert.equal(metadata.cloudVideoJobId,cloudJobId);
  assert.equal(metadata.cloudSha256,sha256);
  assert.deepEqual(await readFile(join(mediaRoot,inserted.args[7])),video);
 }finally{
  if(prior===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior;
  await rm(mediaRoot,{recursive:true,force:true});
 }
});

test("C2PA verifier errors are recorded as unavailable without losing a checksum-verified cloud output",async()=>{
 const seed=fixture(),priorOutput={cloudJobId,quoteId,requestId:seed.request.requestId,requestHash:seed.request.requestHash,
  routedModel:"routed-video-model",approvedMaxAmount:2,status:"queued"};
 const f=fixture({priorOutput}),mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-c2pa-unavailable-")),prior=process.env.SUPABASE_URL;
 process.env.SUPABASE_URL="https://supabase.example";
 try{
  const result=await executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi,
   fetchImpl:async()=>new Response(video,{status:200,headers:{"content-length":String(video.length)}}),
   verifyC2paAsset:async()=>{throw Object.assign(new Error("SDK unavailable"),{code:"C2PA_SDK_UNAVAILABLE"});}
  });
  assert.equal(result.assetIds.length,1);
  assert.equal(result.assetProvenance[0].status,"validation_unavailable");
  assert.deepEqual(result.assetProvenance[0].findings,["C2PA_SDK_UNAVAILABLE"]);
  const metadataUpdate=f.stored.find(item=>item.sql.startsWith("UPDATE assets SET metadata_json"));
  assert.equal(JSON.parse(metadataUpdate.args[0]).c2paVerification.status,"validation_unavailable");
 }finally{
  if(prior===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior;
  await rm(mediaRoot,{recursive:true,force:true});
 }
});


test("idempotent recovery verifies an existing cloud import that has no C2PA snapshot",async()=>{
 const seed=fixture();
 const existingAsset={id:"a23e4567-e89b-42d3-a456-426614174000",metadata_json:JSON.stringify({cloudWorkspaceAssetId:cloudAssetId}),
  storage_path:owner+"/"+projectId+"/existing.mp4",byte_size:video.length,sha256,media_type:"video/mp4"};
 const f=fixture({priorOutput:{cloudJobId,quoteId,requestId:seed.request.requestId,requestHash:seed.request.requestHash,
  routedModel:"routed-video-model",approvedMaxAmount:2,status:"queued"},existingAsset});
 const mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-c2pa-recovery-"));
 try{
  await mkdir(join(mediaRoot,owner,projectId),{recursive:true});
  await writeFile(join(mediaRoot,existingAsset.storage_path),video);
  let verificationCalls=0;
  const result=await executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi,
   verifyC2paAsset:async input=>{
    verificationCalls++;
    assert.equal(input.expectedSha256,sha256);
    assert.equal(input.expectedSize,video.length);
    return{status:"not_present",present:false,valid:false,trusted:false,findings:["C2PA_MANIFEST_NOT_PRESENT"]};
   }
  });
  assert.equal(verificationCalls,1);
  assert.deepEqual(result.assetIds,[existingAsset.id]);
  assert.equal(result.assetProvenance[0].status,"not_present");
  assert.equal(f.stored.filter(item=>item.sql.startsWith("INSERT INTO assets")).length,0);
  const update=f.stored.find(item=>item.sql.startsWith("UPDATE assets SET metadata_json"));
  assert.ok(update);
  assert.equal(JSON.parse(update.args[0]).c2paVerification.status,"not_present");
 }finally{await rm(mediaRoot,{recursive:true,force:true});}
});


test("cloud output checksum mismatch aborts streamed import and removes the partial file",async()=>{
 const seed=fixture(),priorOutput={cloudJobId,quoteId,requestId:seed.request.requestId,requestHash:seed.request.requestHash,
  routedModel:"routed-video-model",approvedMaxAmount:2,status:"queued"};
 const f=fixture({priorOutput}),mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-stream-checksum-")),prior=process.env.SUPABASE_URL;
 process.env.SUPABASE_URL="https://supabase.example";
 try{
  await assert.rejects(()=>executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi,
   fetchImpl:async()=>new Response(Buffer.from("0000ftypbad-checksum"),{status:200})
  }),error=>error.code==="VIDEO_WORKFLOW_OUTPUT_CHECKSUM_MISMATCH");
  assert.equal(f.stored.filter(item=>item.sql.startsWith("INSERT INTO assets")).length,0);
  const files=await readdir(join(mediaRoot,owner,projectId)).catch(()=>[]);
  assert.deepEqual(files,[]);
 }finally{
  if(prior===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior;
  await rm(mediaRoot,{recursive:true,force:true});
 }
});

test("interrupted private output stream is cleaned up and never published as an asset",async()=>{
 const seed=fixture(),priorOutput={cloudJobId,quoteId,requestId:seed.request.requestId,requestHash:seed.request.requestHash,
  routedModel:"routed-video-model",approvedMaxAmount:2,status:"queued"};
 const f=fixture({priorOutput}),mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-stream-interrupted-")),prior=process.env.SUPABASE_URL;
 process.env.SUPABASE_URL="https://supabase.example";
 try{
  const body=new ReadableStream({start(controller){controller.enqueue(video.subarray(0,8));},pull(controller){controller.error(new Error("simulated network interruption"));}},{highWaterMark:0});
  await assert.rejects(()=>executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1",lease_token:"a23e4567-e89b-42d3-a456-426614174000"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi,
   fetchImpl:async()=>new Response(body,{status:200})
  }));
  assert.equal(f.stored.filter(item=>item.sql.startsWith("INSERT INTO assets")).length,0);
  const files=await readdir(join(mediaRoot,owner,projectId)).catch(()=>[]);
  assert.deepEqual(files,[]);
 }finally{
  if(prior===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior;
  await rm(mediaRoot,{recursive:true,force:true});
 }
});
