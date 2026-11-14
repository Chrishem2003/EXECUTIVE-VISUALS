import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {openDatabase} from "../db.mjs";
import {ensureTransformationPlanSchema,createTransformationPlan,approveTransformationPlan,listTransformationPlans} from "../transformation-plans.mjs";

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),"ev-transform-plans-")),db=openDatabase(join(dir,"test.sqlite"));
 const owner="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222",project="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(owner,"owner@example.test");
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(other,"other@example.test");
 db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run(project,owner,"Studio");
 for(const [id,type] of [["33333333-3333-4333-8333-333333333333","video/mp4"],["44444444-4444-4444-8444-444444444444","image/png"]])
  db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path) VALUES(?,?,?,?,?,?,?,?)").run(id,owner,project,id,type,1,"a".repeat(64),"uploads/"+id);
 ensureTransformationPlanSchema(db);
 const body={projectId:project,sourceAssetId:"33333333-3333-4333-8333-333333333333",operation:"vehicle_replace",prompt:"Replace the parked car with a red electric coupe.",durationSeconds:8,referenceAssetIds:["44444444-4444-4444-8444-444444444444"],preservation:["camera_movement","composition"],rightsConfirmed:true,subjectConsentConfirmed:false};
 return{dir,db,owner,other,project,body,close:async()=>{db.close();await rm(dir,{recursive:true,force:true});}};
}
test("creates a project-scoped transformation draft and idempotent replay",async()=>{const f=await fixture();try{const a=createTransformationPlan(f.db,{ownerId:f.owner,body:f.body,idempotencyKey:"transform-key-001"});const b=createTransformationPlan(f.db,{ownerId:f.owner,body:f.body,idempotencyKey:"transform-key-001"});assert.equal(a.plan.status,"draft");assert.equal(b.idempotentReplay,true);assert.equal(a.plan.id,b.plan.id);assert.equal(listTransformationPlans(f.db,f.owner,f.project).length,1);assert.throws(()=>listTransformationPlans(f.db,f.other,f.project),e=>e.code==="PROJECT_NOT_FOUND");}finally{await f.close();}});
test("rejects missing rights, missing person consent and invalid reference assets",async()=>{const f=await fixture();try{assert.throws(()=>createTransformationPlan(f.db,{ownerId:f.owner,body:{...f.body,rightsConfirmed:false},idempotencyKey:"transform-key-002"}),e=>e.code==="MEDIA_RIGHTS_REQUIRED");assert.throws(()=>createTransformationPlan(f.db,{ownerId:f.owner,body:{...f.body,operation:"person_replace"},idempotencyKey:"transform-key-003"}),e=>e.code==="SUBJECT_CONSENT_REQUIRED");assert.throws(()=>createTransformationPlan(f.db,{ownerId:f.owner,body:{...f.body,referenceAssetIds:["33333333-3333-4333-8333-333333333333"]},idempotencyKey:"transform-key-004"}),e=>e.code==="REFERENCE_ASSET_INVALID");}finally{await f.close();}});
test("approval requires known cost and a budget covering the estimate",async()=>{const f=await fixture();try{const {plan}=createTransformationPlan(f.db,{ownerId:f.owner,body:f.body,idempotencyKey:"transform-key-005"});assert.throws(()=>approveTransformationPlan(f.db,{ownerId:f.owner,planId:plan.id,body:{estimatedCostMicros:100,approvedBudgetMicros:99,currency:"USD",adapterId:"provider-a",capability:"video.transform"}}),e=>e.code==="TRANSFORMATION_BUDGET_INVALID");const approved=approveTransformationPlan(f.db,{ownerId:f.owner,planId:plan.id,body:{estimatedCostMicros:100,approvedBudgetMicros:100,currency:"USD",adapterId:"provider-a",capability:"video.transform"}});assert.equal(approved.status,"approved");assert.ok(approved.approval.id);assert.throws(()=>approveTransformationPlan(f.db,{ownerId:f.owner,planId:plan.id,body:{estimatedCostMicros:0,approvedBudgetMicros:0,currency:"USD",adapterId:"provider-a",capability:"video.transform"}}),e=>e.code==="TRANSFORMATION_STATE_CONFLICT");assert.throws(()=>approveTransformationPlan(f.db,{ownerId:f.other,planId:plan.id,body:{}}),e=>e.code==="TRANSFORMATION_NOT_FOUND");}finally{await f.close();}});

test("accepts the exact wardrobe/restyle controls used by the studio and rejects conflicting idempotency reuse",async()=>{const f=await fixture();try{
 const {plan}=createTransformationPlan(f.db,{ownerId:f.owner,body:{...f.body,operation:"wardrobe_replace",preservation:["camera_motion","pose","timing"]},idempotencyKey:"transform-key-006"});
 assert.equal(plan.operation,"wardrobe_replace");assert.deepEqual(plan.preservation,["camera_motion","pose","timing"]);
 assert.throws(()=>createTransformationPlan(f.db,{ownerId:f.owner,body:{...f.body,prompt:"A materially different edit request."},idempotencyKey:"transform-key-006"}),e=>e.code==="IDEMPOTENCY_CONFLICT");
 const restyle=createTransformationPlan(f.db,{ownerId:f.owner,body:{...f.body,operation:"style_transfer"},idempotencyKey:"transform-key-007"});
 assert.equal(restyle.plan.operation,"style_transfer");
}finally{await f.close();}});

test("rejects null and array request bodies with a client error",async()=>{const f=await fixture();try{
 assert.throws(()=>createTransformationPlan(f.db,{ownerId:f.owner,body:null,idempotencyKey:"transform-key-008"}),e=>e.code==="TRANSFORMATION_BODY_INVALID");
 assert.throws(()=>createTransformationPlan(f.db,{ownerId:f.owner,body:[],idempotencyKey:"transform-key-009"}),e=>e.code==="TRANSFORMATION_BODY_INVALID");
}finally{await f.close();}});


test("rejects malformed requests and unsupported preservation or parameter fields",async()=>{const f=await fixture();try{
 assert.throws(()=>createTransformationPlan(f.db,{ownerId:f.owner,body:null,idempotencyKey:"transform-key-008"}),e=>e.code==="TRANSFORMATION_BODY_INVALID");
 assert.throws(()=>createTransformationPlan(f.db,{ownerId:f.owner,body:{...f.body,unexpectedProviderParameter:"secret"},idempotencyKey:"transform-key-009"}),e=>e.code==="TRANSFORMATION_FIELD_UNSUPPORTED");
 assert.throws(()=>createTransformationPlan(f.db,{ownerId:f.owner,body:{...f.body,preservation:["camera_motion","invented_constraint"]},idempotencyKey:"transform-key-010"}),e=>e.code==="TRANSFORMATION_PRESERVATION_INVALID");
 assert.throws(()=>createTransformationPlan(f.db,{ownerId:f.owner,body:{...f.body,referenceAssetIds:"not-an-array"},idempotencyKey:"transform-key-011"}),e=>e.code==="REFERENCE_ASSET_INVALID");
}finally{await f.close();}});

test("rejects coercion, truncation and duplicate transformation values",async()=>{const f=await fixture();try{
 const invalid=[
  [{...f.body,projectId:42},"TRANSFORMATION_INPUT_INVALID"],
  [{...f.body,sourceAssetId:42},"TRANSFORMATION_INPUT_INVALID"],
  [{...f.body,operation:42},"TRANSFORMATION_OPERATION_INVALID"],
  [{...f.body,prompt:"x".repeat(8001)},"TRANSFORMATION_PROMPT_INVALID"],
  [{...f.body,durationSeconds:"8"},"TRANSFORMATION_DURATION_INVALID"],
  [{...f.body,referenceAssetIds:["44444444-4444-4444-8444-444444444444","44444444-4444-4444-8444-444444444444"]},"REFERENCE_ASSET_INVALID"],
  [{...f.body,preservation:["camera_motion","camera_motion"]},"TRANSFORMATION_PRESERVATION_INVALID"]
 ];
 for(let i=0;i<invalid.length;i++)assert.throws(()=>createTransformationPlan(f.db,{ownerId:f.owner,body:invalid[i][0],idempotencyKey:"strict-transform-"+String(i).padStart(3,"0")}),error=>error.code===invalid[i][1]);
}finally{await f.close();}});

test("local transformation idempotency keys reject coercion and truncation",async()=>{const f=await fixture();try{
 const invalid=[undefined,null,42,{}, "short", "x".repeat(181), " ".repeat(181)];
 for(const key of invalid)assert.throws(()=>createTransformationPlan(f.db,{ownerId:f.owner,body:f.body,idempotencyKey:key}),error=>error.code==="IDEMPOTENCY_KEY_REQUIRED");
 const spaced="  strict-local-key-123  ";
 const result=createTransformationPlan(f.db,{ownerId:f.owner,body:f.body,idempotencyKey:spaced});
 assert.ok(result.plan.id);
}finally{await f.close();}});
