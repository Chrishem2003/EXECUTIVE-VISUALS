import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAudioMasteringFilter, buildVariableSpeedSetptsExpression, evaluateAudioMasteringQuality, parseAudioLoudnessMeasurement, renderCloudTimeline } from "../cloud-ffmpeg-timeline-renderer.mjs";

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
 const sampleOnly="Sample peak:\\n Peak: -1.8 dBFS";
 assert.deepEqual(parseAudioLoudnessMeasurement(sampleOnly),{integratedLoudness:null,loudnessRange:null,truePeak:null},"sample peak must never be mistaken for encoded true peak");
});

test("audio mastering QC enforces integrated loudness, LRA ceiling and true peak",()=>{
 const targets={profile:"ebu-r128",integratedLoudness:-23,loudnessRange:7,truePeak:-1.5};
 const passing=evaluateAudioMasteringQuality({integratedLoudness:-23.2,loudnessRange:7.5,truePeak:-1.2},targets);
 assert.equal(passing.passed,true);
 assert.equal(passing.loudnessRangeWithinLimit,true);
 assert.equal(passing.loudnessRangeLimit,8);
 const excessiveRange=evaluateAudioMasteringQuality({integratedLoudness:-23.2,loudnessRange:8.1,truePeak:-1.2},targets);
 assert.equal(excessiveRange.loudnessRangeWithinLimit,false);
 assert.equal(excessiveRange.passed,false,"a master exceeding its configured LRA ceiling cannot pass QC");
 const excessivePeak=evaluateAudioMasteringQuality({integratedLoudness:-23.2,loudnessRange:4,truePeak:-0.8},targets);
 assert.equal(excessivePeak.truePeakWithinLimit,false);
 assert.equal(excessivePeak.passed,false);
 const missing=evaluateAudioMasteringQuality({integratedLoudness:-23,loudnessRange:null,truePeak:-1.2},targets);
 assert.equal(missing.measurementComplete,false);
 assert.equal(missing.passed,false,"missing post-encode measurements must never certify mastering");
 const absent=evaluateAudioMasteringQuality({},targets);
 assert.equal(absent.passed,false);
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
 const invalidTiming=[
  {...base,timelineStart:{value:1,rate:0}},
  {...base,duration:time(-1)},
  {...base,sourceRange:{start:time(0),duration:time(2)}},
  {...base,timelineStart:time(86400),duration:time(1)}
 ];
 for(const clip of invalidTiming){
  await assert.rejects(()=>renderCloudTimeline({timeline:{tracks:[{kind:"video",clips:[clip]}]},assets,workDir:tmpdir()}),error=>error.code==="INVALID_TIMELINE_TIMING");
 }
 await assert.rejects(()=>renderCloudTimeline({timeline:{tracks:[{kind:"video",clips:[{...base,speed:Number.NaN}]}]},assets,workDir:tmpdir()}),error=>error.code==="INVALID_CLIP_SPEED");
 await assert.rejects(()=>renderCloudTimeline({timeline:{tracks:[{kind:"video",clips:[{...base,speed:5}]}]},assets,workDir:tmpdir()}),error=>error.code==="INVALID_CLIP_SPEED");
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

test("cloud renderer applies clip gain and pan automation to the encoded audio", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-audio-automation-"));
 try{
  const video=join(root,"source.mp4"),audio=join(root,"voice.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=blue:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:duration=1","-c:a","pcm_s16le",audio]);
  const timeline={name:"Audio automation",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"v",kind:"video",clips:[{id:"v1",assetId:"v",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]},
   {id:"a",kind:"audio",clips:[{id:"a1",assetId:"a",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},gainDb:-3,pan:0,audioAutomation:[
    {timeSeconds:0,gainDb:-18,pan:-1,interpolation:"linear"},
    {timeSeconds:.5,gainDb:-6,pan:1,interpolation:"linear"}
   ]}]}
  ]};
  const assets=new Map([
   ["v",{path:video,asset:{id:"v",mediaType:"video/mp4",originalName:"source.mp4"}}],
   ["a",{path:audio,asset:{id:"a",mediaType:"audio/wav",originalName:"voice.wav"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","stream=codec_type,channels","-of","json",result.path],{encoding:"utf8"}));
  assert.ok(probe.streams.some(stream=>stream.codec_type==="audio"&&stream.channels===2));
  assert.equal(result.render.audioClips,1);
 }finally{await rm(root,{recursive:true,force:true});}
});



test("cloud renderer accepts audio automation after the picture tail but within the full audio clip", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-audio-tail-"));
 try{
  const video=join(root,"picture.mp4"),audio=join(root,"long-audio.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=blue:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:duration=2","-c:a","pcm_s16le",audio]);
  const timeline={name:"Audio tail automation",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"v",kind:"video",clips:[{id:"v1",assetId:"v",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]},
   {id:"a",kind:"audio",clips:[{id:"a1",assetId:"a",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(2)},audioAutomation:[
    {timeSeconds:0,gainDb:-3,pan:0,interpolation:"linear"},
    {timeSeconds:.5,gainDb:-6,pan:.25,interpolation:"linear"},
    {timeSeconds:1.5,gainDb:-18,pan:1,interpolation:"linear"}
   ]}]}
  ]};
  const assets=new Map([
   ["v",{path:video,asset:{id:"v",mediaType:"video/mp4",originalName:"picture.mp4"}}],
   ["a",{path:audio,asset:{id:"a",mediaType:"audio/wav",originalName:"long-audio.wav"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","format=duration:stream=codec_type","-of","json",result.path],{encoding:"utf8"}));
  const duration=Number(probe.format?.duration);
  assert.ok(probe.streams.some(stream=>stream.codec_type==="audio"));
  assert.ok(duration>=.95&&duration<=1.1,"the one-second picture sequence must still bound the master output; received "+duration);
  const invalid={...timeline,tracks:timeline.tracks.map(track=>track.id==="a"?{...track,clips:track.clips.map(clip=>({...clip,audioAutomation:[{timeSeconds:2.1,gainDb:-18}]}))}:track)};
  await assert.rejects(()=>renderCloudTimeline({timeline:invalid,assets,workDir:root,onProgress(){}}),error=>error.code==="INVALID_AUDIO_AUTOMATION");
 }finally{await rm(root,{recursive:true,force:true});}
});

test("cloud renderer rejects malformed or out-of-clip audio automation",async()=>{
 const assets=new Map([["v",{path:"/not-used.mp4",asset:{id:"v",mediaType:"video/mp4",originalName:"v.mp4"}}]]);
 const clip={assetId:"v",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}};
 const audioClip={...clip,assetId:"a",audioAutomation:[{timeSeconds:2,gainDb:-3}]};
 const timeline={tracks:[{kind:"video",clips:[clip]},{kind:"audio",clips:[audioClip]}]};
 const withAudio=new Map([...assets,["a",{path:"/not-used.wav",asset:{id:"a",mediaType:"audio/wav",originalName:"a.wav"}}]]);
 await assert.rejects(()=>renderCloudTimeline({timeline,assets:withAudio,workDir:tmpdir()}),error=>error.code==="INVALID_AUDIO_AUTOMATION");
});

test("cloud renderer time-remaps video and audio clips while preserving timeline duration", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-time-remap-"));
 try{
  const video=join(root,"source.mp4"),audio=join(root,"voice.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","testsrc2=size=320x240:rate=24:duration=2","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:duration=2","-c:a","pcm_s16le",audio]);
  const timeline={name:"Time remapping",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"v",kind:"video",clips:[{id:"v1",assetId:"v",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(2)},speed:2}]},
   {id:"a",kind:"audio",clips:[{id:"a1",assetId:"a",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(2)},speed:2}]}
  ]};
  const assets=new Map([
   ["v",{path:video,asset:{id:"v",mediaType:"video/mp4",originalName:"source.mp4"}}],
   ["a",{path:audio,asset:{id:"a",mediaType:"audio/wav",originalName:"voice.wav"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","format=duration:stream=codec_type","-of","json",result.path],{encoding:"utf8"}));
  const duration=Number(probe.format.duration);
  assert.ok(duration>=0.9&&duration<=1.15,"expected a one-second master, received "+duration);
  assert.ok(probe.streams.some(stream=>stream.codec_type==="audio"));
  assert.equal(result.render.audioClips,1);
 }finally{await rm(root,{recursive:true,force:true});}
});


test("variable-speed video renderer maps the source-time ramp to the exact timeline duration", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-variable-speed-test-"));
 try{
  const source=join(root,"source.mp4");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","testsrc2=size=320x240:rate=24:duration=6","-c:v","libx264","-pix_fmt","yuv420p",source]);
  const curve=[{timeSeconds:0,speed:1},{timeSeconds:2,speed:2},{timeSeconds:4,speed:1}];
  const expression=buildVariableSpeedSetptsExpression({speedCurve:curve},4);
  assert.match(expression,/sqrt/);
  assert.throws(()=>buildVariableSpeedSetptsExpression({speedCurve:[{timeSeconds:0,speed:1},null]},4),error=>error.code==="INVALID_SPEED_CURVE");
  const timeline={name:"Variable speed",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"v",kind:"video",clips:[{id:"ramp",assetId:"source",timelineStart:{value:0,rate:24},duration:{value:96,rate:24},sourceRange:{start:{value:0,rate:24},duration:{value:144,rate:24}},speed:1,speedCurve:curve}]}
  ]};
  const assets=new Map([["source",{path:source,asset:{id:"source",mediaType:"video/mp4",originalName:"source.mp4"}}]]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const duration=Number(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",result.path],{encoding:"utf8"}).trim());
  assert.ok(duration>=3.9&&duration<=4.1,"variable-speed master should retain the four-second timeline duration; received "+duration);
 }finally{await rm(root,{recursive:true,force:true});}
});

