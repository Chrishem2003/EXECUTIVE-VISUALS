import test from "node:test";
import assert from "node:assert/strict";
import {createCloudTimelineApi} from "../cloud-timeline-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const project="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const source="33333333-3333-4333-8333-333333333333";
const reference="44444444-4444-4444-8444-444444444444";

function fixture({canWrite=true,readiness={}}={}){
 const state={jobs:[],events:[]};
 const assets=new Map([
  [source,{id:source,ownerId:owner,projectId:project,mediaType:"video/mp4"}],
  [reference,{id:reference,ownerId:owner,projectId:project,mediaType:"image/png"}]
 ]);
 const service={
  projects:{get:async()=>({id:project,ownerId:owner})},
  assets:{get:async({assetId})=>{const item=assets.get(assetId);if(!item){const e=new Error("missing");e.code="CLOUD_ASSET_NOT_FOUND";throw e;}return item;}},
  timelines:{}
 };
 const fetchImpl=async(url,options={})=>{
  const parsed=new URL(url),method=options.method||"GET",table=parsed.pathname.split("/").pop();
  let result=[];
  if(table==="jobs"){
   if(method==="GET"){
    result=state.jobs.filter(row=>{
     for(const key of ["id","owner_id","idempotency_key","project_id","job_type","status"]){const value=parsed.searchParams.get(key);if(value&&value.startsWith("eq.")&&String(row[key])!==decodeURIComponent(value.slice(3)))return false;}
     return true;
    });
   }else if(method==="POST"){
    const row=JSON.parse(options.body);row.created_at=new Date().toISOString();row.updated_at=row.created_at;state.jobs.push(row);result=[row];
   }else if(method==="PATCH"){
    result=state.jobs.filter(row=>{for(const key of ["id","status"]){const value=parsed.searchParams.get(key);if(value&&value.startsWith("eq.")&&String(row[key])!==decodeURIComponent(value.slice(3)))return false;}if(parsed.searchParams.has("approved_at")&&row.approved_at!==null&&row.approved_at!==undefined)return false;return true;});
    for(const row of result)Object.assign(row,JSON.parse(options.body));
   }
  }else if(table==="job_events"&&method==="POST"){state.events.push(JSON.parse(options.body));result=[];}
  return new Response(JSON.stringify(result),{status:200,headers:{"content-type":"application/json"}});
 };
 const api=createCloudTimelineApi({url:"https://cloud.example.test",serviceRoleKey:"server-only-test-secret",fetchImpl,timelineService:service,authorize:async({action})=>action==="read"||canWrite,transformationReadiness:async()=>readiness});
 const body={projectId:project,sourceAssetId:source,operation:"vehicle_replace",prompt:"Replace the vehicle with a graphite electric SUV.",durationSeconds:8,referenceAssetIds:[reference],preservation:["camera_motion","composition"],rightsConfirmed:true,subjectConsentConfirmed:false};
 return{api,state,body,assets};
}

test("cloud transformation drafts persist in project jobs and idempotent retries reuse them",async()=>{
 const f=fixture(),key="cloud-transform-001";
 const first=await f.api.handle({method:"POST",path:"/api/cloud/transformations",ownerId:owner,body:f.body,idempotencyKey:key});
 assert.equal(first.status,201);assert.equal(first.body.plan.status,"draft");assert.equal(f.state.jobs.length,1);assert.equal(f.state.jobs[0].status,"draft");
 const replay=await f.api.handle({method:"POST",path:"/api/cloud/transformations",ownerId:owner,body:f.body,idempotencyKey:key});
 assert.equal(replay.status,200);assert.equal(replay.body.idempotentReplay,true);assert.equal(f.state.jobs.length,1);
 const list=await f.api.handle({method:"GET",path:"/api/cloud/transformations",ownerId:owner,query:{projectId:project}});
 assert.equal(list.status,200);assert.equal(list.body.plans.length,1);
});

test("cloud transformation creation enforces rights, person consent, project assets and editor access",async()=>{
 const f=fixture();
 const noRights=await f.api.handle({method:"POST",path:"/api/cloud/transformations",ownerId:owner,body:{...f.body,rightsConfirmed:false},idempotencyKey:"cloud-transform-002"});
 assert.equal(noRights.body.error.code,"MEDIA_RIGHTS_REQUIRED");
 const noConsent=await f.api.handle({method:"POST",path:"/api/cloud/transformations",ownerId:owner,body:{...f.body,operation:"person_replace"},idempotencyKey:"cloud-transform-003"});
 assert.equal(noConsent.body.error.code,"SUBJECT_CONSENT_REQUIRED");
 f.assets.set(reference,{id:reference,ownerId:owner,projectId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",mediaType:"image/png"});
 const wrongProject=await f.api.handle({method:"POST",path:"/api/cloud/transformations",ownerId:owner,body:f.body,idempotencyKey:"cloud-transform-004"});
 assert.equal(wrongProject.body.error.code,"REFERENCE_ASSET_INVALID");
 const viewer=fixture({canWrite:false});
 const denied=await viewer.api.handle({method:"POST",path:"/api/cloud/transformations",ownerId:owner,body:viewer.body,idempotencyKey:"cloud-transform-005"});
 assert.equal(denied.status,404);
});

test("cloud approval records budget metadata but submit remains blocked without a verified adapter",async()=>{
 const f=fixture();
 const created=await f.api.handle({method:"POST",path:"/api/cloud/transformations",ownerId:owner,body:f.body,idempotencyKey:"cloud-transform-006"});
 const id=created.body.plan.id;
 const bad=await f.api.handle({method:"POST",path:"/api/cloud/transformations/"+id+"/approve",ownerId:owner,body:{estimatedCostMicros:100,approvedBudgetMicros:99,currency:"USD",adapterId:"video",capability:"video.transform"}});
 assert.equal(bad.body.error.code,"TRANSFORMATION_BUDGET_INVALID");
 const approved=await f.api.handle({method:"POST",path:"/api/cloud/transformations/"+id+"/approve",ownerId:owner,body:{estimatedCostMicros:100,approvedBudgetMicros:150,currency:"USD",adapterId:"video-transform",capability:"video.transform"}});
 assert.equal(approved.status,200);assert.equal(approved.body.plan.status,"approved");assert.ok(approved.body.plan.approval.id);
 const submit=await f.api.handle({method:"POST",path:"/api/cloud/transformations/"+id+"/submit",ownerId:owner,body:{}});
 assert.equal(submit.status,409);assert.equal(submit.body.error.code,"TRANSFORMATION_ADAPTER_UNAVAILABLE");
 assert.equal(f.state.jobs[0].status,"awaiting_approval");assert.equal(f.state.events.length,2);
});

test("transformation readiness endpoint is project-scoped and fails closed by default",async()=>{
 const f=fixture();
 const result=await f.api.handle({method:"GET",path:"/api/cloud/transformations/readiness",ownerId:owner,query:{projectId:project}});
 assert.equal(result.status,200);
 assert.equal(result.body.readiness.status,"blocked");
 assert.equal(result.body.readiness.canSubmit,false);
 assert.equal(result.body.readiness.missing.length,8);
 const invalid=await f.api.handle({method:"GET",path:"/api/cloud/transformations/readiness",ownerId:owner,query:{projectId:"not-a-project"}});
 assert.equal(invalid.status,400);
});

test("transformation readiness endpoint reports ready only when all release evidence is true",async()=>{
 const readiness={adapterVerified:true,workerAvailable:true,privateStorageVerified:true,durableCheckpointsAvailable:true,costPolicyVerified:true,consentVerifierAvailable:true,visualQaAvailable:true,cloudSchemaApplied:true};
 const f=fixture({readiness});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/transformations/readiness",ownerId:owner,query:{projectId:project}});
 assert.equal(result.status,200);
 assert.equal(result.body.readiness.status,"ready");
 assert.equal(result.body.readiness.canSubmit,true);
});

test("cloud transformation drafts reject inputs that would otherwise be silently discarded",async()=>{
 const f=fixture();
 const cases=[
  [{...f.body,referenceAssetIds:"not-an-array"},"REFERENCE_ASSET_INVALID"],
  [{...f.body,referenceAssetIds:[reference,reference]},"REFERENCE_ASSET_INVALID"],
  [{...f.body,preservation:"camera_motion"},"TRANSFORMATION_PRESERVATION_INVALID"],
  [{...f.body,preservation:["camera_motion","invented_constraint"]},"TRANSFORMATION_PRESERVATION_INVALID"],
  [{...f.body,preservation:["camera_motion","camera_motion"]},"TRANSFORMATION_PRESERVATION_INVALID"],
  [{...f.body,unexpectedProviderOption:"silently ignored"},"TRANSFORMATION_FIELD_UNSUPPORTED"],
  [{...f.body,prompt:"x".repeat(8001)},"TRANSFORMATION_INPUT_INVALID"]
 ];
 for(let i=0;i<cases.length;i++){
  const [body,code]=cases[i];
  const result=await f.api.handle({method:"POST",path:"/api/cloud/transformations",ownerId:owner,body,idempotencyKey:"strict-input-"+String(i).padStart(3,"0")});
  assert.equal(result.status,400);
  assert.equal(result.body.error.code,code);
 }
 assert.equal(f.state.jobs.length,0,"invalid drafts must not be persisted");
});

test("cloud transformation drafts preserve valid reference and preservation inputs exactly",async()=>{
 const f=fixture();
 const body={...f.body,preservation:["camera_motion","composition"]};
 const result=await f.api.handle({method:"POST",path:"/api/cloud/transformations",ownerId:owner,body,idempotencyKey:"strict-input-valid-001"});
 assert.equal(result.status,201);
 assert.deepEqual(result.body.plan.referenceAssetIds,[reference]);
 assert.deepEqual(result.body.plan.preservation,["camera_motion","composition"]);
});
