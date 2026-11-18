import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createCloudCreativeProjectArtifactRepository } from "../creative-project-artifacts-postgres.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const editor="223e4567-e89b-42d3-a456-426614174000";
const project="423e4567-e89b-42d3-a456-426614174000";
const artifactId="523e4567-e89b-42d3-a456-426614174000";
const input={brief:"A community solar workshop"};
const inputHash=createHash("sha256").update("brief-v1").digest("hex");
const stable=value=>Array.isArray(value)?"["+value.map(stable).join(",")+"]":value&&typeof value==="object"?"{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stable(value[k])).join(",")+"}":(JSON.stringify(value)??"null");
const contentHash=value=>createHash("sha256").update(stable(value)).digest("hex");
const storyboard=()=>({
 schemaVersion:1,source:"model",id:"board-1",model:"test-model",generatedAt:"2026-11-19T09:00:00.000Z",
 inputHash,title:"Community solar workshop",logline:"A practical workshop.",targetDurationSeconds:30,durationSeconds:30,
 aspectRatio:"9:16",frameRate:30,globalContinuityRules:["Keep workshop layout consistent","Preserve equipment geometry","Maintain screen direction"],
 characterSuggestions:[],scenes:[1,2].map(number=>({
  id:"scene-"+number,number,title:"Scene "+number,slugline:"INT. WORKSHOP - DAY",purpose:"Show a verifiable process",storyBeat:"Proof",
  location:"Workshop",timeOfDay:"Day",durationSeconds:15,shots:[{
   id:"shot-"+number,number:1,shotType:"Detail",framing:"Close-up",angle:"Eye level",movement:"Slow push",lens:"50mm",
   action:"Show the verified step.",dialogue:"",narration:"",visualPrompt:"Workshop detail.",motionPrompt:"Slow movement.",
   negativePrompt:"No invented claims.",lighting:"Soft daylight",soundCue:"Room tone",continuityIn:"Match previous scene.",
   continuityOut:"Hold on the result.",proofReference:"Check source evidence.",transitionOut:"cut",durationSeconds:15,characterRefs:[]
  }]
 }))
});
const projectRow={id:project,owner_id:owner,archived_at:null};
const parentRow={id:artifactId,project_id:project,created_by:owner,artifact_type:"storyboard",revision:1,
 input_hash:inputHash,content_hash:contentHash(storyboard()),input,content:storyboard(),model:"test-model",usage:{totalTokens:80},created_at:"2026-11-19T09:00:00Z"};

function fixture({projectRows=[projectRow],artifactRows=[parentRow],membershipRows=[{role:"editor"}],rpcRows=null}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  const path=url.split("/rest/v1/")[1]||"";
  let rows=[];
  if(path.startsWith("projects?")&&options.method==="GET")rows=projectRows;
  else if(path.startsWith("projects?")&&options.method==="POST")rows=[{...JSON.parse(options.body),archived_at:null}];
  else if(path.startsWith("project_members?"))rows=membershipRows;
  else if(path.startsWith("creative_project_artifacts?"))rows=artifactRows.filter(row=>{
   const projectMatch=path.match(/project_id=eq\.([^&]+)/),idMatch=path.match(/id=eq\.([^&]+)/),typeMatch=path.match(/artifact_type=eq\.([^&]+)/);
   return (!projectMatch||row.project_id===decodeURIComponent(projectMatch[1]))&&(!idMatch||row.id===decodeURIComponent(idMatch[1]))&&(!typeMatch||row.artifact_type===decodeURIComponent(typeMatch[1]));
  });
  else if(path==="rpc/append_creative_project_artifact"){
   const body=JSON.parse(options.body),revision=artifactRows.filter(row=>row.project_id===body.p_project_id&&row.artifact_type===body.p_artifact_type).reduce((max,row)=>Math.max(max,Number(row.revision)),0)+1;
   const row={id:body.p_id,project_id:body.p_project_id,created_by:body.p_created_by,artifact_type:body.p_artifact_type,revision,input_hash:body.p_input_hash,content_hash:body.p_content_hash,input:body.p_input,content:body.p_content,model:body.p_model,usage:body.p_usage,created_at:"2026-11-19T10:00:00Z"};
   artifactRows.push(row);rows=rpcRows||[row];
  }
  return {ok:true,status:200,async text(){return JSON.stringify(rows);}};
 };
 return {calls,artifactRows,repository:createCloudCreativeProjectArtifactRepository({url:"https://example.supabase.co",serviceRoleKey:"test-secret",fetchImpl})};
}

test("persists a new creative artifact through an atomic Postgres append RPC",async()=>{
 const f=fixture({projectRows:[]});
 const result=await f.repository.save({projectId:project,ownerId:owner,projectName:"Solar workshop",createdBy:owner,type:"storyboard",input,content:storyboard(),inputHash,model:"test-model",usage:{totalTokens:80}});
 assert.equal(result.revision,2);
 assert.equal(result.projectId,project);
 const rpc=f.calls.find(call=>call.url.includes("/rpc/append_creative_project_artifact"));
 assert.ok(rpc);
 assert.equal(rpc.options.headers["content-profile"],"executive_visuals");
 assert.equal(JSON.parse(rpc.options.body).p_content_hash,contentHash(storyboard()));
 assert.equal(f.calls.some(call=>call.options.method==="POST"&&call.url.includes("/projects?")),true);
});

test("preflights cloud owner and editor authorization before writes",async()=>{
 const f=fixture();
 assert.equal(await f.repository.assertWriter({projectId:project,ownerId:owner,createdBy:owner,projectName:"Solar workshop"}),true);
 assert.equal(await f.repository.assertWriter({projectId:project,ownerId:owner,createdBy:editor,projectName:"Solar workshop"}),true);
 assert.ok(f.calls.some(call=>call.url.includes("project_members?")&&call.url.includes("member_id=eq."+editor)));
});

test("rejects editor writes when cloud membership is absent",async()=>{
 const f=fixture({membershipRows:[]});
 await assert.rejects(()=>f.repository.assertWriter({projectId:project,ownerId:owner,createdBy:editor,projectName:"Solar workshop"}),error=>error.code==="CREATIVE_ARTIFACT_EDITOR_REQUIRED");
 assert.equal(f.calls.some(call=>call.url.includes("/rpc/append_creative_project_artifact")),false);
});

test("reports Postgres artifact storage ready only after a successful table query",async()=>{
 const f=fixture();
 const result=await f.repository.checkReadiness();
 assert.deepEqual(result,{backend:"supabase-postgres",configured:true,ready:true,durableAcrossDeploys:true});
 assert.ok(f.calls.some(call=>call.url.includes("creative_project_artifacts?select=id&limit=0")));
});

test("lists and retrieves artifacts scoped to one project",async()=>{
 const f=fixture();
 const item=await f.repository.get({projectId:project,artifactId});
 const items=await f.repository.list({projectId:project,type:"storyboard",limit:5});
 assert.equal(item.id,artifactId);
 assert.equal(items[0].type,"storyboard");
 assert.ok(f.calls.some(call=>call.url.includes("project_id=eq."+project)));
 assert.ok(f.calls.some(call=>call.url.includes("id=eq."+artifactId)));
});

test("appends reviewed edits as a new revision and preserves source lineage",async()=>{
 const edited=storyboard();edited.scenes[0].shots[0].action="Show the inspected solar controller.";
 const f=fixture();
 const result=await f.repository.appendRevision({projectId:project,ownerId:owner,projectName:"Solar workshop",createdBy:editor,artifactId,content:edited});
 assert.equal(result.revision,2);
 const body=JSON.parse(f.calls.find(call=>call.url.includes("/rpc/append_creative_project_artifact")).options.body);
 assert.equal(body.p_input_hash,inputHash);
 assert.deepEqual(body.p_input,input);
 assert.equal(body.p_created_by,editor);
});

test("does not create a duplicate revision for unchanged storyboard content",async()=>{
 const f=fixture();
 const result=await f.repository.appendRevision({projectId:project,ownerId:owner,projectName:"Solar workshop",createdBy:editor,artifactId,content:storyboard()});
 assert.equal(result.unchanged,true);
 assert.equal(f.calls.some(call=>call.url.includes("/rpc/append_creative_project_artifact")),false);
});

test("rejects an archived or differently-owned cloud project before appending",async()=>{
 const f=fixture({projectRows:[{...projectRow,owner_id:editor}]});
 await assert.rejects(()=>f.repository.save({projectId:project,ownerId:owner,projectName:"Solar workshop",createdBy:owner,type:"storyboard",input,content:storyboard(),inputHash}),e=>e.code==="CREATIVE_ARTIFACT_PROJECT_SCOPE_MISMATCH");
 assert.equal(f.calls.some(call=>call.url.includes("/rpc/append_creative_project_artifact")),false);
});

test("rejects invalid storyboard structure before the database append",async()=>{
 const edited=storyboard();edited.scenes[0].shots[0].durationSeconds=90;
 const f=fixture();
 await assert.rejects(()=>f.repository.appendRevision({projectId:project,ownerId:owner,projectName:"Solar workshop",createdBy:editor,artifactId,content:edited}),e=>e.code==="CREATIVE_ARTIFACT_REVISION_INVALID");
 assert.equal(f.calls.some(call=>call.url.includes("/rpc/append_creative_project_artifact")),false);
});

test("Postgres bootstrap enforces private access, immutable rows and serialized revisions",()=>{
 const sql=readFileSync(new URL("../../scripts/creative-project-artifacts-postgres-bootstrap.sql",import.meta.url),"utf8");
 assert.match(sql,/enable row level security/i);
 assert.match(sql,/revoke all on table executive_visuals\.creative_project_artifacts from public,anon,authenticated/i);
 assert.match(sql,/grant select,insert on table executive_visuals\.creative_project_artifacts to service_role/i);
 assert.match(sql,/before update or delete on executive_visuals\.creative_project_artifacts/i);
 assert.match(sql,/for update/i);
 assert.match(sql,/role='editor'/i);
 assert.match(sql,/unique\(project_id,artifact_type,revision\)/i);
 assert.match(sql,/security invoker/i);
 assert.match(sql,/revoke all on function executive_visuals\.append_creative_project_artifact/i);
});


test("backfills legacy SQLite artifact IDs and revisions idempotently",async()=>{
 const f=fixture({artifactRows:[]});
 const legacy={...parentRow,projectId:project,type:"storyboard",revision:1};
 const first=await f.repository.importLegacyArtifacts({projectId:project,ownerId:owner,projectName:"Solar workshop",artifacts:[legacy]});
 assert.deepEqual(first,{imported:1,alreadyPresent:0,total:1});
 assert.equal(f.artifactRows.length,1);
 assert.equal(f.artifactRows[0].id,artifactId);
 assert.equal(f.artifactRows[0].revision,1);
 const second=await f.repository.importLegacyArtifacts({projectId:project,ownerId:owner,projectName:"Solar workshop",artifacts:[legacy]});
 assert.deepEqual(second,{imported:0,alreadyPresent:1,total:1});
 assert.equal(f.calls.filter(call=>call.url.includes("/rpc/append_creative_project_artifact")).length,1);
});
