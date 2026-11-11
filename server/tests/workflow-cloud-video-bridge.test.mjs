import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCloudVideoWorkflowNode } from "../workflow-cloud-video-bridge.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const projectId="423e4567-e89b-42d3-a456-426614174000";
const runId="523e4567-e89b-42d3-a456-426614174000";
const jobId="623e4567-e89b-42d3-a456-426614174000";
const cloudJobId="723e4567-e89b-42d3-a456-426614174000";
const cloudAssetId="823e4567-e89b-42d3-a456-426614174000";
const quoteId="923e4567-e89b-42d3-a456-426614174000";
const video=Buffer.from("0000ftypisom0000");
const sha256=createHash("sha256").update(video).digest("hex");

function fixture({budget=2,jobStatus="running",cloudStatus="succeeded"}={}){
 const stored=[],calls=[];
 const localJob={status:jobStatus,lease_owner:"worker-1",lease_expires_at:new Date(Date.now()+60000).toISOString()};
 const db={prepare(sql){
  if(sql.startsWith("SELECT id,owner_id,name,description FROM projects"))return{get:()=>({id:projectId,owner_id:owner,name:"Project",description:""})};
  if(sql.startsWith("SELECT status,lease_owner,lease_expires_at FROM jobs"))return{get:()=>localJob};
  if(sql.startsWith("SELECT output_json FROM workflow_node_runs"))return{get:()=>null};
  if(sql.startsWith("SELECT id,metadata_json FROM assets"))return{get:()=>null};
  if(sql.startsWith("INSERT INTO assets"))return{run(...args){stored.push({sql,args});}};
  if(sql.startsWith("UPDATE assets SET metadata_json"))return{run(...args){stored.push({sql,args});}};
  throw new Error("Unexpected SQL in workflow bridge test: "+sql);
 }};
 const cloudTimelineApi={
  async handle(input){
   calls.push(input);
   if(input.method==="GET"&&input.path==="/api/cloud/projects/"+projectId)return{status:200,body:{project:{id:projectId}}};
   if(input.method==="POST"&&input.path==="/api/cloud/workflows/video/quote")return{status:200,body:{quote:{id:quoteId,estimatedAmount:1,billable:false,requiresExplicitApproval:true,routedModel:"routed-video-model"}}};
   if(input.method==="POST"&&input.path==="/api/cloud/workflows/video/approve"){
    if(input.body.approvedMaxAmount<1)return{status:409,body:{error:{code:"VIDEO_WORKFLOW_BUDGET_BELOW_QUOTE",message:"Budget below quote"}}};
    return{status:202,body:{job:{id:cloudJobId,status:"queued"}}};
   }
   if(input.method==="GET"&&input.path==="/api/cloud/jobs/"+cloudJobId)return{status:200,body:{job:{id:cloudJobId,status:cloudStatus,output:cloudStatus==="succeeded"?{assetIds:[cloudAssetId],model:"routed-video-model",usage:{seconds:5},costEvidenceReference:"cost:verified"}:null}}};
   if(input.method==="GET"&&input.path==="/api/cloud/assets/"+cloudAssetId)return{status:200,body:{asset:{id:cloudAssetId,projectId,mediaType:"video/mp4",size:video.length,sha256},url:"https://supabase.example/storage/v1/object/sign/video"}};
   if(input.method==="POST"&&input.path==="/api/cloud/jobs/"+cloudJobId+"/cancel")return{status:202,body:{}};
   throw new Error("Unexpected cloud API call: "+input.method+" "+input.path);
  },
  async uploadAsset(){throw new Error("Text-only test must not upload input assets.");}
 };
 const node={id:"video-node",kind:"video.generate",config:{provider:"runway",model:"model-router",prompt:"A cinematic sunrise over a quiet lake.",durationSeconds:5,approvedMaxAmount:budget},outputs:[{id:"video",type:"video"}]};
 return{db,stored,calls,localJob,cloudTimelineApi,node};
}

test("cloud workflow node quotes, explicitly approves, waits for durable completion and imports verified output",async()=>{
 const f=fixture(),mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-test-")),prior=process.env.SUPABASE_URL;
 process.env.SUPABASE_URL="https://supabase.example";
 try{
  const result=await executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi,
   fetchImpl:async()=>new Response(video,{status:200,headers:{"content-length":String(video.length)}})
  });
  assert.equal(result.provider,"runway");
  assert.equal(result.cloudJobId,cloudJobId);
  assert.equal(result.assetIds.length,1);
  assert.equal(result.costEvidenceReference,"cost:verified");
  assert.ok(f.calls.some(call=>call.path==="/api/cloud/workflows/video/quote"));
  const approval=f.calls.find(call=>call.path==="/api/cloud/workflows/video/approve");
  assert.equal(approval.body.confirmed,true);
  assert.equal(approval.body.approvedMaxAmount,2);
  assert.equal(f.stored.filter(item=>item.sql.startsWith("INSERT INTO assets")).length,1);
  assert.equal(f.stored.filter(item=>item.sql.startsWith("UPDATE assets SET metadata_json")).length,0);
  const inserted=f.stored.find(item=>item.sql.startsWith("INSERT INTO assets"));
  const metadata=JSON.parse(inserted.args[8]);
  assert.equal(metadata.cloudWorkspaceAssetId,cloudAssetId);
  assert.equal(metadata.cloudVideoJobId,cloudJobId);
  assert.equal(metadata.cloudSha256,sha256);
 }finally{
  if(prior===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior;
  await rm(mediaRoot,{recursive:true,force:true});
 }
});

test("cloud workflow node refuses a budget ceiling below the fresh quote before approval",async()=>{
 const f=fixture({budget:0.5}),mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-budget-test-"));
 try{
  await assert.rejects(()=>executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi
  }),error=>error.code==="VIDEO_WORKFLOW_BUDGET_CEILING_REQUIRED");
  assert.equal(f.calls.some(call=>call.path==="/api/cloud/workflows/video/approve"),false);
 }finally{await rm(mediaRoot,{recursive:true,force:true});}
});

test("cloud workflow node refuses to run without an authenticated cloud API",async()=>{
 await assert.rejects(()=>executeCloudVideoWorkflowNode({}),error=>error.code==="VIDEO_WORKFLOW_CLOUD_DISABLED");
});

test("cloud workflow node returns a durable pending receipt without holding the local worker",async()=>{
 const f=fixture({cloudStatus:"running"}),mediaRoot=await mkdtemp(join(tmpdir(),"ev-cloud-workflow-pending-test-")),prior=process.env.SUPABASE_URL;
 process.env.SUPABASE_URL="https://supabase.example";
 try{
  const result=await executeCloudVideoWorkflowNode({
   db:f.db,job:{id:jobId,owner_id:owner,project_id:projectId,lease_owner:"worker-1"},
   run:{id:runId,project_id:projectId},node:f.node,values:{},mediaRoot,cloudTimelineApi:f.cloudTimelineApi
  });
  assert.equal(result.pending,true);
  assert.equal(result.cloudJobId,cloudJobId);
  assert.equal(result.quoteId,quoteId);
  assert.equal(f.calls.filter(call=>call.path==="/api/cloud/workflows/video/approve").length,1);
  assert.equal(f.stored.filter(item=>item.sql.startsWith("INSERT INTO assets")).length,0);
 }finally{
  if(prior===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior;
  await rm(mediaRoot,{recursive:true,force:true});
 }
});
