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
  async probeOutput(){return{format:{duration:"12",format_name:"mov,mp4,m4a,3gp,3g2,mj2"},streams:[{codec_type:"video",codec_name:"h264",width:1920,height:1080,avg_frame_rate:"24/1"}]};},
  async renderTimeline(args){assert.equal(args.timeline,timeline);assert.equal(args.assets.size,2);const path=join(args.workDir,"master.mp4");await writeFile(path,"final-master");return{path,filename:"episode-master.mp4",mediaType:"video/mp4",render:{durationSeconds:12}};}
 });
 const result=await executor({job:{id:"job-1",owner_id:owner,project_id:project,job_type:"timeline.render",input:{timelineId,timelineRevision:7}},onProgress(){}});
 assert.equal(materialized.length,2);assert.deepEqual(materialized.map(x=>x.assetId).sort(),["asset-a","asset-b"]);
 assert.deepEqual(cleanups.sort(),["asset-a","asset-b"]);
 assert.equal(published[0].ownerId,owner);assert.equal(published[0].projectId,project);
 assert.equal(published[0].metadata.timelineRevision,7);assert.equal(published[0].metadata.probe.streams[0].codec_name,"h264");assert.equal(published[0].metadata.render.durationSeconds,12);assert.equal(published[0].content,"final-master");
 assert.equal(result.outputAsset.id,"master-asset");assert.equal(result.byteSize,12);assert.equal(result.timelineRevision,7);assert.equal(result.probeValidation.validatedStreamType,"video");
 await rm(root,{recursive:true,force:true});
});

test("cloud timeline executor forwards mastering settings and preserves its verification report",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-timeline-mastering-"));
 const mastering={enabled:true,integratedLufs:-16,truePeakDbtp:-1.5};
 let received=null,published=null;
 const executor=createCloudTimelineExecutor({
  tempRoot:root,
  timelines:{async get(){return{id:timelineId,ownerId:owner,projectId:project,revision:7,timeline};}},
  mediaIO:{
   async materialize(args){const path=join(root,args.assetId+".bin");await writeFile(path,args.assetId);return{path,asset:{id:args.assetId},async cleanup(){}};},
   async publish(args){published=args;return{id:"mastered-asset"};}
  },
  async probeOutput(){return{format:{duration:"12"},streams:[{codec_type:"video"},{codec_type:"audio"}]};},
  async renderTimeline(args){received=args.mastering;const path=join(args.workDir,"master.mp4");await writeFile(path,"master");return{path,filename:"master.mp4",mediaType:"video/mp4",mastering:{enabled:true,verified:true,output:{integratedLufs:-16,truePeakDbtp:-1.5}}};}
 });
 const result=await executor({job:{id:"job-master",owner_id:owner,project_id:project,job_type:"timeline.render",input:{timelineId,timelineRevision:7,mastering}},onProgress(){}});
 assert.deepEqual(received,mastering);
 assert.equal(published.metadata.mastering.verified,true);
 assert.equal(result.mastering.verified,true);
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
  async renderTimeline({workDir}){const path=join(workDir,"master.mp4");await writeFile(path,"rendered");return{path,filename:"master.mp4",mediaType:"video/mp4"};},
  async probeOutput(){throw new Error("ffprobe failed");}
 });
 await assert.rejects(()=>executor({job:{id:"job-probe-fail",owner_id:owner,project_id:null,job_type:"timeline.render",input:{timelineId,timelineRevision:1}}}),/ffprobe failed/);
 assert.equal(published.length,0);assert.deepEqual(cleaned.sort(),["asset-a","asset-b"]);
 await rm(root,{recursive:true,force:true});
});


test("cloud timeline executor certifies requested delivery profile before publishing",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-delivery-cert-pass-"));let published=null;
 const executor=createCloudTimelineExecutor({
  tempRoot:root,
  timelines:{async get(){return{id:timelineId,projectId:project,revision:7,timeline};}},
  mediaIO:{
   async materialize({assetId}){const path=join(root,assetId+".bin");await writeFile(path,assetId);return{path,asset:{id:assetId},async cleanup(){}};},
   async publish(args){published=args;return{id:"certified-master"};}
  },
  async probeOutput(){return{format:{format_name:"mov,mp4,m4a,3gp,3g2,mj2",duration:"12"},streams:[
   {codec_type:"video",codec_name:"h264",pix_fmt:"yuv420p",width:1080,height:1920,avg_frame_rate:"24/1"},
   {codec_type:"audio",codec_name:"aac",sample_rate:"48000",channels:2}
  ]};},
  async renderTimeline(args){const path=join(args.workDir,"master.mp4");await writeFile(path,"master");return{path,filename:"master.mp4",mediaType:"video/mp4",render:{deliveryProfile:"vertical-1080p",width:1080,height:1920,frameRate:{numerator:24,denominator:1},durationSeconds:12,audioClips:1}};}
 });
 const result=await executor({job:{id:"job-delivery-pass",owner_id:owner,project_id:project,job_type:"timeline.render",input:{timelineId,timelineRevision:7,deliveryProfile:"vertical-1080p"}},onProgress(){}});
 assert.equal(result.deliveryCertification.status,"passed");
 assert.equal(result.deliveryCertification.summary.failed,0);
 assert.equal(published.metadata.deliveryCertification.status,"passed");
 await rm(root,{recursive:true,force:true});
});

test("cloud timeline executor blocks publishing when delivery profile dimensions do not match",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-delivery-cert-fail-"));let publishCount=0;
 const executor=createCloudTimelineExecutor({
  tempRoot:root,
  timelines:{async get(){return{id:timelineId,projectId:project,revision:7,timeline};}},
  mediaIO:{
   async materialize({assetId}){const path=join(root,assetId+".bin");await writeFile(path,assetId);return{path,asset:{id:assetId},async cleanup(){}};},
   async publish(){publishCount++;return{id:"should-not-publish"};}
  },
  async probeOutput(){return{format:{format_name:"mp4",duration:"12"},streams:[{codec_type:"video",codec_name:"h264",pix_fmt:"yuv420p",width:1920,height:1080,avg_frame_rate:"24/1"}]};},
  async renderTimeline(args){const path=join(args.workDir,"master.mp4");await writeFile(path,"master");return{path,filename:"master.mp4",mediaType:"video/mp4",render:{width:1080,height:1920,frameRate:{numerator:24,denominator:1},durationSeconds:12,audioClips:0}};}
 });
 await assert.rejects(()=>executor({job:{id:"job-delivery-fail",owner_id:owner,project_id:project,job_type:"timeline.render",input:{timelineId,timelineRevision:7,deliveryProfile:"vertical-1080p"}},onProgress(){}}),error=>error.code==="DELIVERY_CERTIFICATION_FAILED"&&error.certification.summary.failed===2);
 assert.equal(publishCount,0);
 await rm(root,{recursive:true,force:true});
});
