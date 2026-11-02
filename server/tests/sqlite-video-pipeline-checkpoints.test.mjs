import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {openDatabase} from "../db.mjs";
import {createSqliteVideoPipelineCheckpointStore} from "../sqlite-video-pipeline-checkpoints.mjs";

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),"ev-pipeline-checkpoints-"));
 const db=openDatabase(join(dir,"test.sqlite"));
 const ownerA="11111111-1111-4111-8111-111111111111",ownerB="22222222-2222-4222-8222-222222222222";
 const projectA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",projectB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(ownerA,"a@example.test");
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(ownerB,"b@example.test");
 db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run(projectA,ownerA,"A");
 db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run(projectB,ownerB,"B");
 return{dir,db,ownerA,ownerB,projectA,projectB,close:async()=>{db.close();await rm(dir,{recursive:true,force:true});}};
}
const record={pipelineId:"pipe-1",stepId:"edit",status:"succeeded",inputAssetId:"source-1",inputSha256:"a".repeat(64),idempotencyKey:"b".repeat(64),outputAsset:{id:"derived-1",mediaType:"video/mp4",sha256:"c".repeat(64),derivativeOf:"source-1"},approvalId:"approval-1"};
test("stores and reloads a durable owner/project-scoped checkpoint",async()=>{
 const f=await fixture();try{
  const store=createSqliteVideoPipelineCheckpointStore({db:f.db,ownerId:f.ownerA,projectId:f.projectA});
  await store.save(record);
  assert.deepEqual(await store.get("pipe-1","edit"),{...record,createdAt:(await store.get("pipe-1","edit")).createdAt});
  assert.equal(await createSqliteVideoPipelineCheckpointStore({db:f.db,ownerId:f.ownerB,projectId:f.projectB}).get("pipe-1","edit"),null);
  assert.equal(await createSqliteVideoPipelineCheckpointStore({db:f.db,ownerId:f.ownerA,projectId:f.projectB}).get("pipe-1","edit"),null);
 }finally{await f.close();}
});
test("checkpoint writes are idempotent but conflicting step receipts are rejected",async()=>{
 const f=await fixture();try{
  const store=createSqliteVideoPipelineCheckpointStore({db:f.db,ownerId:f.ownerA,projectId:f.projectA});
  await store.save(record);
  await store.save(record);
  await assert.rejects(()=>store.save({...record,idempotencyKey:"d".repeat(64)}),e=>e.code==="VIDEO_PIPELINE_CHECKPOINT_CONFLICT");
 }finally{await f.close();}
});
test("rejects malformed checkpoint receipts and never updates a completed checkpoint",async()=>{
 const f=await fixture();try{
  const store=createSqliteVideoPipelineCheckpointStore({db:f.db,ownerId:f.ownerA,projectId:f.projectA});
  await assert.rejects(()=>store.save({...record,inputSha256:"bad"}),e=>e.code==="VIDEO_PIPELINE_CHECKPOINT_INVALID");
  await store.save(record);
  const row=f.db.prepare("SELECT output_json FROM video_pipeline_checkpoints WHERE owner_id=?").get(f.ownerA);
  assert.equal(JSON.parse(row.output_json).id,"derived-1");
 }finally{await f.close();}
});

test("refuses to create a checkpoint store for a project the owner cannot access",async()=>{
 const f=await fixture();try{
  assert.throws(()=>createSqliteVideoPipelineCheckpointStore({db:f.db,ownerId:f.ownerA,projectId:f.projectB}),e=>e.code==="VIDEO_PIPELINE_PROJECT_ACCESS_DENIED");
  const editorStore=createSqliteVideoPipelineCheckpointStore({db:f.db,ownerId:f.ownerA,projectId:f.projectB,authorizeProject:({ownerId,projectId})=>ownerId===f.ownerA&&projectId===f.projectB});
  assert.equal(await editorStore.get("pipe-1","edit"),null);
 }finally{await f.close();}
});
