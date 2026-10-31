import test from "node:test";
import assert from "node:assert/strict";
import { createCloudTimelineApi } from "../cloud-timeline-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000",editor="223e4567-e89b-42d3-a456-426614174000",project="423e4567-e89b-42d3-a456-426614174000",timelineId="523e4567-e89b-42d3-a456-426614174000";
const timelineDoc={width:1280,height:720,frameRate:{numerator:24,denominator:1},tracks:[],markers:[]};
function setup({canWrite=true,projectId=project,existing=[]}={}){
 const calls=[],created=[];
 const timeline={id:timelineId,ownerId:owner,projectId,name:"Test timeline",revision:2,timeline:timelineDoc,otio:null};
 const timelines={
  async create(input){created.push(input);return{...timeline,...input,revision:1};},
  async get(input){calls.push(["get",input]);return input.ownerId===owner?timeline:null;},
  async update(input){calls.push(["update",input]);return{...timeline,revision:input.expectedRevision+1,timeline:input.timeline};}
 };
 const fetchImpl=async(url,options)=>{calls.push(["fetch",url,options]);if(url.includes("/jobs")&&options.method==="POST")return{ok:true,status:201,async text(){return JSON.stringify([{id:JSON.parse(options.body).id,owner_id:owner,project_id:projectId,job_type:"timeline.render",status:"queued",input:JSON.parse(options.body).input}])}};if(url.includes("/jobs?"))return{ok:true,status:200,async text(){return JSON.stringify(existing)}};return{ok:true,status:201,async text(){return""}};};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl,timelineService:{timelines,assets:{}},authorize:async({ownerId,projectId:pid,action})=>ownerId===owner&&(!pid||pid===project)&&(action==="read"||canWrite)});
 return{api,calls,created};
}
test("cloud timeline create binds ownership to verified identity, not request body",async()=>{const f=setup();const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines",ownerId:owner,body:{ownerId:editor,projectId:project,name:"Test",timeline:timelineDoc}});assert.equal(result.status,201);assert.equal(f.created[0].ownerId,owner);assert.equal(f.created[0].projectId,project);});
test("cloud timeline get and update use verified owner and optimistic revision",async()=>{const f=setup();const got=await f.api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId,ownerId:owner});assert.equal(got.status,200);const updated=await f.api.handle({method:"PUT",path:"/api/cloud/timelines/"+timelineId,ownerId:owner,body:{expectedRevision:2,timeline:timelineDoc}});assert.equal(updated.status,200);assert.equal(f.calls.find(c=>c[0]==="update")[1].expectedRevision,2);});
test("cloud render submission queues a durable job using current saved timeline revision",async()=>{const f=setup();const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{ownerId:editor,timelineId:"bad"},idempotencyKey:"render-1"});assert.equal(result.status,202);const inserted=f.calls.find(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST");const body=JSON.parse(inserted[2].body);assert.equal(body.owner_id,owner);assert.equal(body.input.timelineId,timelineId);assert.equal(body.input.timelineRevision,2);assert.equal(body.job_type,"timeline.render");});
test("cloud render submission requires project editor authorization",async()=>{const f=setup({canWrite:false});const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{}});assert.equal(result.status,404);assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST"),false);});
test("cloud render idempotency replays only the exact same timeline revision",async()=>{const existing=[{id:"623e4567-e89b-42d3-a456-426614174000",owner_id:owner,project_id:project,job_type:"timeline.render",status:"queued",input:{timelineId,timelineRevision:2}}];const f=setup({existing});const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,idempotencyKey:"render-1"});assert.equal(result.status,200);assert.equal(result.body.idempotentReplay,true);assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].endsWith("/jobs")),false);});
test("cloud timeline API rejects unverified or malformed owner IDs and ignores unrelated routes",async()=>{const f=setup();assert.equal((await f.api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId,ownerId:"not-uuid"})).status,401);assert.equal(await f.api.handle({method:"GET",path:"/api/not-cloud",ownerId:owner}),null);});
