import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAudioMasteringFilter, parseAudioLoudnessMeasurement, renderCloudTimeline } from "../cloud-ffmpeg-timeline-renderer.mjs";

const hasFfmpeg=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-version"],{stdio:"ignore"}).status===0;
const hasFfprobe=spawnSync(process.env.FFPROBE_PATH||"ffprobe",["-version"],{stdio:"ignore"}).status===0;

test("audio loudness QC parser extracts integrated loudness, LRA and encoded true peak",()=>{
 const stderr=`[Parsed_ebur128_0] Summary:
Integrated loudness:
 I:         -23.4 LUFS
 Threshold: -33.4 LUFS
Loudness range:
 LRA:         4.2 LU
 Threshold: -43.4 LUFS
Sample peak:
 Peak:       -1.8 dBFS
True peak:
 Peak:       -1.2 dBFS`;
 assert.deepEqual(parseAudioLoudnessMeasurement(stderr),{integratedLoudness:-23.4,loudnessRange:4.2,truePeak:-1.2});
 assert.deepEqual(parseAudioLoudnessMeasurement("no loudness summary"),{integratedLoudness:null,loudnessRange:null,truePeak:null});
});

test("audio mastering filter enforces fixed named delivery profiles server-side",()=>{
 assert.match(buildAudioMasteringFilter({enabled:true,profile:"web-podcast",integratedLoudness:-23}),/loudnorm=I=-16:/);
 assert.match(buildAudioMasteringFilter({enabled:true,profile:"ebu-r128",integratedLoudness:-16}),/loudnorm=I=-23:/);
 assert.match(buildAudioMasteringFilter({enabled:true,profile:"custom",integratedLoudness:-18.5}),/loudnorm=I=-18.5:/);
 assert.match(buildAudioMasteringFilter({enabled:true,profile:"ebu-r128",integratedLoudness:-16,loudnessRange:8,truePeak:-1,dualMono:true}),/LRA=8:TP=-1:dual_mono=true/);
 assert.throws(()=>buildAudioMasteringFilter({enabled:true,profile:"ebu-r128",truePeak:-0.5}),error=>error.code==="INVALID_AUDIO_MASTERING");
 assert.throws(()=>buildAudioMasteringFilter({enabled:true,profile:"unknown"}),error=>error.code==="INVALID_AUDIO_MASTERING");
 assert.equal(buildAudioMasteringFilter({enabled:false,profile:"ebu-r128",integratedLoudness:-16}),"");
});
const time=(value)=>({value,rate:1});
test("cloud FFmpeg renderer produces a playable master from materialized video and audio", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-render-test-"));
 try{
  const video=join(root,"source.mp4"),audio=join(root,"voice.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=blue:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:duration=1","-c:a","pcm_s16le",audio]);
  const timeline={name:"Cloud test",width:320,height:240,frameRate:{numerator:24,denominator:1},audioMastering:{enabled:true,integratedLoudness:-16,loudnessRange:11,truePeak:-1.5,dualMono:true},tracks:[
   {id:"v",kind:"video",clips:[{id:"v1",assetId:"asset-video",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},metadata:{timelineEffects:{brightness:0.05,contrast:1.1,saturation:0.9,denoise:1,sharpen:0.3}}}]},
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
  assert.equal(result.render.effectClips,1);
  assert.equal(result.render.audioClips,1);
  assert.equal(result.render.audioMastering.applied,true);
  assert.equal(result.render.audioMastering.profile,"custom");
  assert.equal(result.render.audioMastering.integratedLoudness,-16);
  assert.equal(result.render.audioMastering.dualMono,true);
  assert.ok(Number.isFinite(result.render.audioMastering.measurement.integratedLoudness),"render receipt must include measured encoded integrated loudness");
  assert.ok(Number.isFinite(result.render.audioMastering.measurement.loudnessRange),"render receipt must include measured encoded loudness range");
  assert.ok(Number.isFinite(result.render.audioMastering.measurement.truePeak),"render receipt must include measured encoded true peak");
  assert.equal(typeof result.render.audioMastering.qualityControl.loudnessRangeWithinLimit,"boolean","render receipt must check the measured loudness-range ceiling");
  assert.equal(typeof result.render.audioMastering.qualityControl.passed,"boolean","render receipt must report whether measured delivery targets passed");
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

test("cloud FFmpeg renderer refuses enabled mastering when no audio clips exist",async()=>{
 const assets=new Map([["v",{path:"/not-used.mp4",asset:{id:"v",mediaType:"video/mp4",originalName:"v.mp4"}}]]);
 const clip={assetId:"v",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}};
 await assert.rejects(()=>renderCloudTimeline({timeline:{audioMastering:{enabled:true,profile:"web-podcast"},tracks:[{kind:"video",clips:[clip]}]},assets,workDir:tmpdir()}),error=>error.code==="AUDIO_MASTERING_REQUIRES_AUDIO");
});

test("cloud FFmpeg renderer honours an already-aborted signal",async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(()=>renderCloudTimeline({timeline:{tracks:[]},assets:new Map(),workDir:tmpdir(),signal:controller.signal}),error=>error.code==="JOB_CANCELLED");
});

test("cloud FFmpeg renderer rejects invalid and out-of-range clip timing before invoking FFmpeg",async()=>{
 const assets=new Map([["v",{path:"/not-used.mp4",asset:{id:"v",mediaType:"video/mp4",originalName:"v.mp4"}}]]);
 const base={assetId:"v",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}};
 const invalid=[
  {...base,timelineStart:{value:1,rate:0}},
  {...base,duration:time(-1)},
  {...base,sourceRange:{start:time(0),duration:time(2)}},
  {...base,timelineStart:time(86400),duration:time(1)},
  {...base,speed:Number.NaN}
 ];
 for(const clip of invalid){
  await assert.rejects(()=>renderCloudTimeline({timeline:{tracks:[{kind:"video",clips:[clip]}]},assets,workDir:tmpdir()}),error=>error.code==="INVALID_TIMELINE_TIMING");
 }
});

test("cloud FFmpeg renderer rejects audio mastering targets outside EBU R128 ranges",async()=>{
 const assets=new Map([["v",{path:"/not-used.mp4",asset:{id:"v",mediaType:"video/mp4",originalName:"v.mp4"}}]]);
 const clip={assetId:"v",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}};
 for(const audioMastering of [
  {enabled:true,integratedLoudness:1},
  {enabled:true,integratedLoudness:-71},
  {enabled:true,loudnessRange:0},
  {enabled:true,loudnessRange:51},
  {enabled:true,truePeak:0.1},
  {enabled:true,truePeak:-10}
 ]){
  await assert.rejects(()=>renderCloudTimeline({timeline:{audioMastering,tracks:[{kind:"video",clips:[clip]}]},assets,workDir:tmpdir()}),error=>error.code==="INVALID_AUDIO_MASTERING");
 }
});
