import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudTimelineExecutor } from "../cloud-timeline-executor.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const project="22222222-2222-4222-8222-222222222222";
const timelineId="33333333-3333-4333-8333-333333333333";
const timeline={tracks:[{id:"v1",kind:"video",clips:[{id:"c1",assetId:"asset-a",enabled:true}]},{id:"a1",kind:"audio",clips:[{id:"c2",assetId:"asset-b"}]}]};
test("cloud timeline executor materializes all unique sources and publishes a revision-linked master",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-timeline-test-"));
 const cleanups=[],materialized=[],published=[];
 const executor=createCloudTimelineExecutor({
  tempRoot:root,
  timelines:{async get(args){assert.deepEqual(args,{ownerId:owner,timelineId});return{id:timelineId,ownerId:owner,projectId:project,revision:7,timeline};}},
  mediaIO:{
   async materialize(args){materialized.push(args);const path=join(root,args.assetId+".bin");await writeFile(path,args.assetId);return{path,asset:{id:args.assetId},async cleanup(){cleanups.push(args.assetId);}};},
   async publish(args){published.push({...args,content:await readFile(args.path,"utf8")});return{id:"master-asset",name:args.filename};}
  },
  async renderTimeline(args){assert.equal(args.timeline,timeline);assert.equal(args.assets.size,2);const path=join(args.workDir,"master.mp4");await writeFile(path,"final-master");return{path,filename:"episode-master.mp4",mediaType:"video/mp4",render:{durationSeconds:12}};}
 });
 const result=await executor({job:{id:"job-1",owner_id:owner,project_id:project,job_type:"timeline.render",input:{timelineId}},onProgress(){}});
 assert.equal(materialized.length,2);assert.deepEqual(materialized.map(x=>x.assetId).sort(),["asset-a","asset-b"]);
 assert.deepEqual(cleanups.sort(),["asset-a","asset-b"]);
 assert.equal(published[0].ownerId,owner);assert.equal(published[0].projectId,project);
 assert.equal(published[0].metadata.timelineRevision,7);assert.equal(published[0].content,"final-master");
 assert.equal(result.outputAsset.id,"master-asset");assert.equal(result.byteSize,12);assert.equal(result.timelineRevision,7);
 await rm(root,{recursive:true,force:true});
});

test("cloud timeline executor rejects project mismatch before materializing media",async()=>{
 let materialized=false;
 const executor=createCloudTimelineExecutor({
  timelines:{async get(){return{id:timelineId,projectId:"other-project",revision:1,timeline};}},
  mediaIO:{async materialize(){materialized=true;},async publish(){}},
  async renderTimeline(){}
 });
 await assert.rejects(()=>executor({job:{id:"job-2",owner_id:owner,project_id:project,job_type:"timeline.render",input:{timelineId}}}),error=>error.code==="CLOUD_TIMELINE_PROJECT_MISMATCH");
 assert.equal(materialized,false);
});

test("cloud timeline executor cleans every materialized source if rendering fails",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-timeline-test-"));const cleaned=[];
 const executor=createCloudTimelineExecutor({
  tempRoot:root,
  timelines:{async get(){return{id:timelineId,projectId:null,revision:1,timeline};}},
  mediaIO:{async materialize({assetId}){const path=join(root,assetId);await writeFile(path,"source");return{path,asset:{id:assetId},async cleanup(){cleaned.push(assetId);}};},async publish(){throw new Error("not reached");}},
  async renderTimeline(){throw new Error("render failure");}
 });
 await assert.rejects(()=>executor({job:{id:"job-3",owner_id:owner,project_id:null,job_type:"timeline.render",input:{timelineId}}}),/render failure/);
 assert.deepEqual(cleaned.sort(),["asset-a","asset-b"]);
 await rm(root,{recursive:true,force:true});
});

test("cloud timeline executor requires an explicit cloud render engine",()=>{
 assert.throws(()=>createCloudTimelineExecutor({timelines:{get(){}},mediaIO:{materialize(){},publish(){}}}),/render engine/);
});
