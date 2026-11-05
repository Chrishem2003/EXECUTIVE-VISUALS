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
test("cloud FFmpeg renderer mixes audio and accepts automation beyond the picture tail", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-render-test-"));
 try{
  const video=join(root,"source.mp4"),audio=join(root,"voice.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=blue:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:duration=2","-c:a","pcm_s16le",audio]);
  const timeline={name:"Cloud test",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"v",kind:"video",clips:[{id:"v1",assetId:"asset-video",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]},
   {id:"a",kind:"audio",clips:[{id:"a1",assetId:"asset-audio",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(2)},gainDb:-3,pan:0,audioAutomation:[{timeSeconds:0,gainDb:-3,pan:-1,interpolation:"linear"},{timeSeconds:0.2,gainDb:-3,pan:-1,interpolation:"step"},{timeSeconds:0.5,gainDb:-12,pan:1,interpolation:"linear"},{timeSeconds:1.5,gainDb:-18,pan:1,interpolation:"linear"}]}]}
  ]};
  const assets=new Map([
   ["asset-video",{path:video,asset:{id:"asset-video",mediaType:"video/mp4",originalName:"source.mp4"}}],
   ["asset-audio",{path:audio,asset:{id:"asset-audio",mediaType:"audio/wav",originalName:"voice.wav"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","format=duration:stream=codec_type,channels","-of","json",result.path],{encoding:"utf8"}));
  assert.equal(result.mediaType,"video/mp4");
  assert.match(result.filename,/Cloud test-master\.mp4$/);
  assert.ok(probe.streams.some(stream=>stream.codec_type==="video"));
  assert.ok(probe.streams.some(stream=>stream.codec_type==="audio"&&stream.channels===2));
  assert.equal(result.render.videoClips,1);
  assert.equal(result.render.audioClips,1);
  assert.equal(result.render.automatedAudioClips,1);
  assert.ok(Number(probe.format?.duration)<=1.1,"audio extending beyond the picture sequence must not extend the rendered master");
  const pcm=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",result.path,"-map","0:a:0","-f","f32le","-acodec","pcm_f32le","-ar","48000","-ac","2","pipe:1"]);
  const samples=new Float32Array(pcm.buffer,pcm.byteOffset,pcm.byteLength/4);
  const rms=(from,to,channel)=>{let sum=0,count=0;for(let frame=Math.floor(from*48000);frame<Math.floor(to*48000);frame++){const value=samples[frame*2+channel]||0;sum+=value*value;count++;}return Math.sqrt(sum/Math.max(1,count));};
  const earlyLeft=rms(.1,.3,0),earlyRight=rms(.1,.3,1),lateLeft=rms(.7,.9,0),lateRight=rms(.7,.9,1);
  assert.ok(earlyLeft>earlyRight*4,"left-panned opening keyframe should favour the left channel (left="+earlyLeft+", right="+earlyRight+")");
  assert.ok(lateRight>lateLeft*4,"right-panned ending keyframe should favour the right channel (left="+lateLeft+", right="+lateRight+")");
  const earlyLevel=Math.hypot(earlyLeft,earlyRight),lateLevel=Math.hypot(lateLeft,lateRight);
  assert.ok(earlyLevel>lateLevel*1.5,"the rendered gain automation should attenuate the later section");
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
