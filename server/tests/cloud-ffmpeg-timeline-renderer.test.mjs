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
   {id:"a",kind:"audio",clips:[{id:"a1",assetId:"asset-audio",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},gainDb:-3,pan:0,audioAutomation:[{timeSeconds:0,gainDb:-3,pan:-1,interpolation:"linear"},{timeSeconds:0.2,gainDb:-3,pan:-1,interpolation:"step"},{timeSeconds:0.5,gainDb:-12,pan:1,interpolation:"linear"}]}]}
  ]};
  const assets=new Map([
   ["asset-video",{path:video,asset:{id:"asset-video",mediaType:"video/mp4",originalName:"source.mp4"}}],
   ["asset-audio",{path:audio,asset:{id:"asset-audio",mediaType:"audio/wav",originalName:"voice.wav"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","stream=codec_type,channels","-of","json",result.path],{encoding:"utf8"}));
  assert.equal(result.mediaType,"video/mp4");
  assert.match(result.filename,/Cloud test-master\.mp4$/);
  assert.ok(probe.streams.some(stream=>stream.codec_type==="video"));
  assert.ok(probe.streams.some(stream=>stream.codec_type==="audio"&&stream.channels===2));
  assert.equal(result.render.videoClips,1);
  assert.equal(result.render.audioClips,1);
  assert.equal(result.render.automatedAudioClips,1);
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

test("cloud FFmpeg renderer matches Web Audio center panning for mono and stereo sources", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-pan-parity-"));
 try{
  const video=join(root,"picture.mp4"),mono=join(root,"mono.wav"),stereo=join(root,"stereo.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=black:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:duration=1","-ac","1","-c:a","pcm_s16le",mono]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","aevalsrc=0.2*sin(2*PI*440*t)|0.1*sin(2*PI*880*t):s=48000:d=1","-c:a","pcm_s16le",stereo]);
  const render=async(assetId,path,pan=0)=>{
   const timeline={name:"Pan parity",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
    {id:"v",kind:"video",clips:[{id:"v1",assetId:"video",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]},
    {id:"a",kind:"audio",clips:[{id:"a1",assetId,timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},pan}]}
   ]};
   return renderCloudTimeline({timeline,assets:new Map([
    ["video",{path:video,asset:{id:"video",mediaType:"video/mp4"}}],
    [assetId,{path,asset:{id:assetId,mediaType:"audio/wav"}}]
   ]),workDir:root,onProgress(){}});
  };
  const monoOutput=await render("mono",mono),stereoOutput=await render("stereo",stereo),hardLeft=await render("stereo",stereo,-1);
  const decode=path=>execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",path,"-map","0:a:0","-f","f32le","-acodec","pcm_f32le","-ar","48000","-ac","2","pipe:1"]);
  const rms=(buffer,from,to,channel)=>{const samples=new Float32Array(buffer.buffer,buffer.byteOffset,buffer.byteLength/4);let sum=0,count=0;for(let frame=Math.floor(from*48000);frame<Math.floor(to*48000);frame++){const value=samples[frame*2+channel]||0;sum+=value*value;count++;}return Math.sqrt(sum/Math.max(1,count));};
  const monoPcm=decode(monoOutput.path),monoLeft=rms(monoPcm,.1,.9,0),monoRight=rms(monoPcm,.1,.9,1);
  const sourcePcm=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",mono,"-f","f32le","-acodec","pcm_f32le","-ar","48000","-ac","1","pipe:1"]);
  const sourceSamples=new Float32Array(sourcePcm.buffer,sourcePcm.byteOffset,sourcePcm.byteLength/4);
  const sourceRms=Math.sqrt(sourceSamples.reduce((sum,value)=>sum+value*value,0)/sourceSamples.length);
  assert.ok(Math.abs(monoLeft/monoRight-1)<0.08,"mono center pan should produce equal left/right energy");
  assert.ok(Math.abs(monoLeft/sourceRms-Math.SQRT1_2)<0.09,"mono center pan should apply equal-power -3 dB per channel");
  const stereoPcm=decode(stereoOutput.path),stereoLeft=rms(stereoPcm,.1,.9,0),stereoRight=rms(stereoPcm,.1,.9,1);
  assert.ok(stereoLeft>stereoRight*1.6&&stereoLeft<stereoRight*2.4,"stereo center pan should preserve the source channel balance");
  const hardLeftPcm=decode(hardLeft.path),hardLeftRms=rms(hardLeftPcm,.1,.9,0),hardRightRms=rms(hardLeftPcm,.1,.9,1);
  assert.ok(hardLeftRms>hardRightRms*20,"stereo hard-left pan should move both source channels left");
 }finally{await rm(root,{recursive:true,force:true});}
});

test("cloud FFmpeg renderer downmixes 5.1 sources before stereo panning", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-pan-51-"));
 try{
  const video=join(root,"picture.mp4"),surround=join(root,"surround-51.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=black:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","aevalsrc=0.2*sin(2*PI*440*t)|0.1*sin(2*PI*550*t)|0.15*sin(2*PI*660*t)|0|0.08*sin(2*PI*770*t)|0.04*sin(2*PI*880*t):s=48000:c=5.1:d=1","-c:a","pcm_s16le",surround]);
  const sourceInfo=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","stream=channels,channel_layout","-of","json",surround],{encoding:"utf8"}));
  assert.equal(sourceInfo.streams?.[0]?.channels,6,"fixture must be a six-channel source");
  const render=async(pan)=>{
   const timeline={name:"Surround downmix",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
    {id:"v",kind:"video",clips:[{id:"v1",assetId:"video",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]},
    {id:"a",kind:"audio",clips:[{id:"a1",assetId:"surround",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},pan}]}
   ]};
   return renderCloudTimeline({timeline,assets:new Map([
    ["video",{path:video,asset:{id:"video",mediaType:"video/mp4"}}],
    ["surround",{path:surround,asset:{id:"surround",mediaType:"audio/wav"}}]
   ]),workDir:root,onProgress(){}});
  };
  const center=await render(0),hardLeft=await render(-1);
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","stream=codec_type,channels","-of","json",center.path],{encoding:"utf8"}));
  assert.ok(probe.streams.some(stream=>stream.codec_type==="audio"&&stream.channels===2),"5.1 source must render as a stereo master");
  const decode=path=>execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",path,"-map","0:a:0","-f","f32le","-acodec","pcm_f32le","-ar","48000","-ac","2","pipe:1"]);
  const rms=(buffer,from,to,channel)=>{const samples=new Float32Array(buffer.buffer,buffer.byteOffset,buffer.byteLength/4);let sum=0,count=0;for(let frame=Math.floor(from*48000);frame<Math.floor(to*48000);frame++){const value=samples[frame*2+channel]||0;sum+=value*value;count++;}return Math.sqrt(sum/Math.max(1,count));};
  const centerPcm=decode(center.path),centerLeft=rms(centerPcm,.1,.9,0),centerRight=rms(centerPcm,.1,.9,1);
  assert.ok(centerLeft>0.01&&centerRight>0.01,"center-panned 5.1 downmix should retain audible energy in both stereo channels");
  const leftPcm=decode(hardLeft.path),leftRms=rms(leftPcm,.1,.9,0),rightRms=rms(leftPcm,.1,.9,1);
  assert.ok(leftRms>rightRms*20,"hard-left panning should place the downmixed surround signal in the left channel");
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
