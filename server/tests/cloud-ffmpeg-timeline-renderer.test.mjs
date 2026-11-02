import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCloudTimeline } from "../cloud-ffmpeg-timeline-renderer.mjs";

const hasFfmpeg=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-version"],{stdio:"ignore"}).status===0;
const hasFfprobe=spawnSync(process.env.FFPROBE_PATH||"ffprobe",["-version"],{stdio:"ignore"}).status===0;
const time=(value)=>({value,rate:1});
test("cloud FFmpeg renderer produces a playable master from materialized video and audio", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-render-test-"));
 try{
  const video=join(root,"source.mp4"),audio=join(root,"voice.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=blue:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:duration=1","-c:a","pcm_s16le",audio]);
  const timeline={name:"Cloud test",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"v",kind:"video",clips:[{id:"v1",assetId:"asset-video",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]},
   {id:"a",kind:"audio",clips:[{id:"a1",assetId:"asset-audio",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},gainDb:-3}]}
  ]};
  const assets=new Map([
   ["asset-video",{path:video,asset:{id:"asset-video",mediaType:"video/mp4",originalName:"source.mp4"}}],
   ["asset-audio",{path:audio,asset:{id:"asset-audio",mediaType:"audio/wav",originalName:"voice.wav"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","stream=codec_type","-of","json",result.path],{encoding:"utf8"}));
  assert.equal(result.mediaType,"video/mp4");
  assert.match(result.filename,/Cloud test-master\.mp4$/);
  assert.ok(probe.streams.some(stream=>stream.codec_type==="video"));
  assert.ok(probe.streams.some(stream=>stream.codec_type==="audio"));
  assert.equal(result.render.videoClips,1);
  assert.equal(result.render.audioClips,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("cloud FFmpeg renderer rejects overlapping primary video clips",async()=>{
 const timeline={tracks:[{kind:"video",clips:[
  {assetId:"v",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(2)}},
  {assetId:"v",timelineStart:time(1),duration:time(1),sourceRange:{start:time(2),duration:time(1)}}
 ]}]};
 const assets=new Map([["v",{path:"/not-used.mp4",asset:{id:"v",mediaType:"video/mp4",originalName:"v.mp4"}}]]);
 await assert.rejects(()=>renderCloudTimeline({timeline,assets,workDir:tmpdir()}),error=>error.code==="TIMELINE_OVERLAP");
});

test("cloud FFmpeg renderer honours an already-aborted signal",async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(()=>renderCloudTimeline({timeline:{tracks:[]},assets:new Map(),workDir:tmpdir(),signal:controller.signal}),error=>error.code==="JOB_CANCELLED");
});


test("cloud renderer attaches a revision-pinned manifest when verified source checksums are supplied", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-manifest-test-"));
 try{
  const video=join(root,"source.mp4");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=green:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",video]);
  const timeline={name:"Manifest test",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[{id:"v",kind:"video",clips:[{id:"v1",assetId:"asset-video",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]}]};
  const assets=new Map([["asset-video",{path:video,asset:{id:"asset-video",mediaType:"video/mp4",originalName:"source.mp4",size:100,sha256:"a".repeat(64)}}]]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,timelineRevision:12});
  assert.equal(result.renderManifest.timelineRevision,"12");
  assert.equal(result.renderManifest.sources[0].sha256,"a".repeat(64));
  const {verifyRenderManifest}=await import("../render-manifest.mjs");
  assert.equal(verifyRenderManifest(result.renderManifest),true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("cloud renderer refuses revision-pinned renders when source checksums are absent",async()=>{
 const timeline={tracks:[{kind:"video",clips:[{assetId:"v",timelineStart:time(0),duration:time(1)}]}]};
 const assets=new Map([["v",{path:"/not-used.mp4",asset:{id:"v",mediaType:"video/mp4"}}]]);
 await assert.rejects(()=>renderCloudTimeline({timeline,assets,workDir:tmpdir(),timelineRevision:1}),e=>e.code==="RENDER_MANIFEST_SOURCE_UNVERIFIED");
});
