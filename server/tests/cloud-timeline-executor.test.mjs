import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudTimelineExecutor } from "../cloud-timeline-executor.mjs";
import { createRenderManifest } from "../render-manifest.mjs";
import { verifyDeliveryManifest } from "../delivery-manifest.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const project="22222222-2222-4222-8222-222222222222";
const timelineId="33333333-3333-4333-8333-333333333333";
const time=value=>({value,rate:1});
const timeline={tracks:[{id:"v1",kind:"video",clips:[{id:"c1",assetId:"asset-a",enabled:true,timelineStart:time(0),duration:time(6)}]},{id:"a1",kind:"audio",clips:[{id:"c2",assetId:"asset-b",timelineStart:time(0),duration:time(6)}]}]};
const sha="a".repeat(64);
test("cloud timeline executor materializes all unique sources and publishes a revision-linked master",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-timeline-test-"));
 const cleanups=[],materialized=[],published=[];
 const executor=createCloudTimelineExecutor({
  tempRoot:root,
  timelines:{async get(args){assert.deepEqual(args,{ownerId:owner,timelineId});return{id:timelineId,ownerId:owner,projectId:project,revision:7,timeline};}},
  mediaIO:{
   async materialize(args){materialized.push(args);const path=join(root,args.assetId+".bin");await writeFile(path,args.assetId);return{path,sha256:sha,asset:{id:args.assetId,mediaType:args.assetId==="asset-a"?"video/mp4":"audio/wav",sha256:sha},async cleanup(){cleanups.push(args.assetId);}};},
   async publish(args){published.push({...args,content:await readFile(args.path,"utf8")});return{id:"master-asset",name:args.filename};}
  },
  async probeOutput(){return{format:{duration:"12",format_name:"mov,mp4,m4a,3gp,3g2,mj2"},streams:[{codec_type:"video",codec_name:"h264",width:1920,height:1080,avg_frame_rate:"24/1"}]};},
  async renderTimeline(args){assert.equal(args.timeline,timeline);assert.equal(args.assets.size,2);assert.equal(args.timelineRevision,7);const path=join(args.workDir,"master.mp4");await writeFile(path,"final-master");return{path,filename:"episode-master.mp4",mediaType:"video/mp4",render:{durationSeconds:12},renderManifest:createRenderManifest({timeline:args.timeline,assets:args.assets,timelineRevision:args.timelineRevision,output:{codec:"h264"}})};}
 });
 const result=await executor({job:{id:"job-1",owner_id:owner,project_id:project,job_type:"timeline.render",input:{timelineId,timelineRevision:7}},onProgress(){}});
 assert.equal(materialized.length,2);assert.deepEqual(materialized.map(x=>x.assetId).sort(),["asset-a","asset-b"]);
 assert.deepEqual(cleanups.sort(),["asset-a","asset-b"]);
 assert.equal(published[0].ownerId,owner);assert.equal(published[0].projectId,project);
 assert.equal(published[0].metadata.timelineRevision,7);assert.equal(published[0].metadata.renderManifest.timelineRevision,"7");assert.equal(published[0].metadata.probe.streams[0].codec_name,"h264");assert.equal(published[0].metadata.render.durationSeconds,12);assert.equal(published[0].content,"final-master");
 assert.equal(result.outputAsset.id,"master-asset");assert.equal(result.byteSize,12);assert.equal(result.timelineRevision,7);assert.equal(result.renderManifest.timelineRevision,"7");assert.equal(result.probeValidation.validatedStreamType,"video");assert.equal(result.deliveryManifest.outputAsset,"master-asset");assert.equal(result.deliveryManifest.sha256,result.sha256);assert.equal(result.deliveryManifest.byteSize,result.byteSize);assert.equal(verifyDeliveryManifest(result.deliveryManifest),true);
 await rm(root,{recursive:true,force:true});
});

test("cloud timeline executor rejects project mismatch before materializing media",async()=>{
 let materialized=false;
 const executor=createCloudTimelineExecutor({
  timelines:{async get(){return{id:timelineId,projectId:"other-project",revision:1,timeline};}},
  mediaIO:{async materialize(){materialized=true;},async publish(){}},
  async renderTimeline(){}
 });
 await assert.rejects(()=>executor({job:{id:"job-2",owner_id:owner,project_id:project,job_type:"timeline.render",input:{timelineId,timelineRevision:1}}}),error=>error.code==="CLOUD_TIMELINE_PROJECT_MISMATCH");
 assert.equal(materialized,false);
});

test("cloud timeline executor cleans every materialized source if rendering fails",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-timeline-test-"));const cleaned=[];
 const executor=createCloudTimelineExecutor({
  tempRoot:root,
  timelines:{async get(){return{id:timelineId,projectId:null,revision:1,timeline};}},
  mediaIO:{async materialize({assetId}){const path=join(root,assetId);await writeFile(path,"source");return{path,asset:{id:assetId},async cleanup(){cleaned.push(assetId);}};},async publish(){throw new Error("not reached");}},
  async probeOutput(){throw new Error("probe failure");},
  async renderTimeline(){throw new Error("render failure");}
 });
 await assert.rejects(()=>executor({job:{id:"job-3",owner_id:owner,project_id:null,job_type:"timeline.render",input:{timelineId,timelineRevision:1}}}),/render failure/);
 assert.deepEqual(cleaned.sort(),["asset-a","asset-b"]);
 await rm(root,{recursive:true,force:true});
});

test("cloud timeline executor requires an explicit cloud render engine",()=>{
 assert.throws(()=>createCloudTimelineExecutor({timelines:{get(){}},mediaIO:{materialize(){},publish(){}}}),/render engine/);
});

test("cloud timeline executor refuses to render a stale revision after the job was queued",async()=>{
 let materialized=false;
 const executor=createCloudTimelineExecutor({
  timelines:{async get(){return{id:timelineId,projectId:null,revision:3,timeline};}},
  mediaIO:{async materialize(){materialized=true;},async publish(){}},
  async renderTimeline(){}
 });
 await assert.rejects(()=>executor({job:{id:"job-stale",owner_id:owner,project_id:null,job_type:"timeline.render",input:{timelineId,timelineRevision:2}}}),error=>error.code==="CLOUD_TIMELINE_REVISION_CHANGED");
 assert.equal(materialized,false);
});

test("cloud timeline executor refuses to publish a master when its output probe fails",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-timeline-probe-test-"));const cleaned=[],published=[];
 const executor=createCloudTimelineExecutor({
  tempRoot:root,
  timelines:{async get(){return{id:timelineId,projectId:null,revision:1,timeline};}},
  mediaIO:{async materialize({assetId}){const path=join(root,assetId);await writeFile(path,"source");return{path,asset:{id:assetId},async cleanup(){cleaned.push(assetId);}};},async publish(args){published.push(args);}},
  async renderTimeline({workDir}){const path=join(workDir,"master.mp4");await writeFile(path,"rendered");return{path,filename:"master.mp4",mediaType:"video/mp4",renderManifest:createRenderManifest({timeline,assets:new Map([["asset-a",{path:join(root,"asset-a"),asset:{id:"asset-a",sha256:sha,mediaType:"video/mp4"}}],["asset-b",{path:join(root,"asset-b"),asset:{id:"asset-b",sha256:sha,mediaType:"audio/wav"}}]]),timelineRevision:1})};},
  async probeOutput(){throw new Error("ffprobe failed");}
 });
 await assert.rejects(()=>executor({job:{id:"job-probe-fail",owner_id:owner,project_id:null,job_type:"timeline.render",input:{timelineId,timelineRevision:1}}}),/ffprobe failed/);
 assert.equal(published.length,0);assert.deepEqual(cleaned.sort(),["asset-a","asset-b"]);
 await rm(root,{recursive:true,force:true});
});


test("cloud timeline executor refuses to publish output that fails the selected delivery profile",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-delivery-gate-"));const published=[];
 const selectedTimeline={...timeline,deliveryProfileId:"youtube-1080p"};
 const executor=createCloudTimelineExecutor({
  tempRoot:root,
  timelines:{async get(){return{id:timelineId,projectId:null,revision:1,timeline:selectedTimeline};}},
  mediaIO:{
   async materialize({assetId}){const path=join(root,assetId);await writeFile(path,"source");return{path,asset:{id:assetId,mediaType:assetId==="asset-a"?"video/mp4":"audio/wav",sha256:sha},async cleanup(){}};},
   async publish(args){published.push(args);return{id:"should-not-publish"};}
  },
  async renderTimeline({workDir,assets,timeline:renderTimeline}){const path=join(workDir,"profile-failed.mp4");await writeFile(path,"rendered");return{path,filename:"failed.mp4",mediaType:"video/mp4",renderManifest:createRenderManifest({timeline:renderTimeline,assets,timelineRevision:1,output:{codec:"h264"}})};},
  async probeOutput(){return{format:{duration:"10"},streams:[{codec_type:"video",codec_name:"h264",width:1280,height:720,pix_fmt:"yuv420p",avg_frame_rate:"30/1"},{codec_type:"audio",codec_name:"aac",sample_rate:"48000"}]};}
 });
 await assert.rejects(()=>executor({job:{id:"delivery-gate",owner_id:owner,project_id:null,job_type:"timeline.render",input:{timelineId,timelineRevision:1}}}),error=>error.code==="DELIVERY_PROFILE_VALIDATION_FAILED"&&error.deliveryReport.status==="needs-attention");
 assert.equal(published.length,0);
 await rm(root,{recursive:true,force:true});
});
