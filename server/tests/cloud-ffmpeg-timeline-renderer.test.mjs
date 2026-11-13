import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAudioMasteringFilter, buildVariableSpeedSetptsExpression, evaluateAudioMasteringQuality, parseAudioLoudnessMeasurement, renderCloudTimeline, sourceDurationForClip } from "../cloud-ffmpeg-timeline-renderer.mjs";

const hasFfmpeg=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-version"],{stdio:"ignore"}).status===0;
const hasFfprobe=spawnSync(process.env.FFPROBE_PATH||"ffprobe",["-version"],{stdio:"ignore"}).status===0;
const hasRubberband=(()=>{const result=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-filters"],{encoding:"utf8"});return /\brubberband\b/.test((result.stdout||"")+"\n"+(result.stderr||""));})();

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
  const pcm=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",result.path,"-map","0:a:0","-ac","2","-ar","48000","-f","f32le","pipe:1"]);
  const samples=new Float32Array(pcm.buffer,pcm.byteOffset,Math.floor(pcm.byteLength/4));
  const channelRms=(channel,startSeconds,endSeconds)=>{
   const start=Math.floor(startSeconds*48000),end=Math.min(Math.floor(endSeconds*48000),Math.floor(samples.length/2));
   let energy=0,count=0;
   for(let frame=start;frame<end;frame++){const value=samples[frame*2+channel];energy+=value*value;count++;}
   return count?Math.sqrt(energy/count):0;
  };
  const earlyLeft=channelRms(0,.01,.04),earlyRight=channelRms(1,.01,.04);
  const lateLeft=channelRms(0,.75,.9),lateRight=channelRms(1,.75,.9);
  assert.ok(earlyLeft>earlyRight*4,"the opening hard-left automation should favor the left channel");
  assert.ok(lateRight>lateLeft*4,"the later hard-right automation should favor the right channel");
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



test("cloud FFmpeg renderer applies frame-bounded dip-to-black fades to adjacent video clips", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-transition-test-"));
 try{
  const red=join(root,"red.mp4"),green=join(root,"green.mp4");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=red:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",red]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=green:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",green]);
  const time=value=>({value,rate:1});
  const timeline={name:"Transition test",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[{id:"v",kind:"video",clips:[
   {id:"v1",assetId:"red",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},transitionToNext:{type:"dip-to-black",fadeFrames:6}},
   {id:"v2",assetId:"green",timelineStart:time(1),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}
  ]}]};
  const assets=new Map([
   ["red",{path:red,asset:{id:"red",mediaType:"video/mp4",originalName:"red.mp4"}}],
   ["green",{path:green,asset:{id:"green",mediaType:"video/mp4",originalName:"green.mp4"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  assert.equal(result.render.transitions,1);
  const sample=frame=>execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",result.path,"-vf","select=eq(n\\,"+frame+")","-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","-s","1x1","pipe:1"]);
  const brightness=[23,24,30].map(frame=>{const pixel=sample(frame);assert.equal(pixel.length,3);return pixel[0]+pixel[1]+pixel[2];});
  assert.ok(brightness[0]<60,"outgoing clip should be almost black at the end of its fade");
  assert.ok(brightness[1]<40,"incoming clip should begin at black");
  assert.ok(brightness[2]>100,"incoming clip should reach full brightness after its fade");
 }finally{await rm(root,{recursive:true,force:true});}
});

test("cloud FFmpeg renderer rejects invalid or non-video transition metadata before materializing inputs",async()=>{
 const time=value=>({value,rate:1});
 const video={kind:"video",clips:[
  {assetId:"v",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},transitionToNext:{type:"dip-to-black",fadeFrames:0}},
  {assetId:"v",timelineStart:time(1),duration:time(1),sourceRange:{start:time(1),duration:time(1)}}
 ]};
 const assets=new Map([["v",{path:"/not-used.mp4",asset:{id:"v",mediaType:"video/mp4",originalName:"v.mp4"}}]]);
 await assert.rejects(()=>renderCloudTimeline({timeline:{frameRate:{numerator:24,denominator:1},tracks:[video]},assets,workDir:tmpdir()}),error=>error.code==="INVALID_TIMELINE_TRANSITION");
 const nonVideo={...video,kind:"audio",clips:video.clips.map(clip=>({...clip,transitionToNext:{type:"dip-to-black",fadeFrames:6}}))};
 await assert.rejects(()=>renderCloudTimeline({timeline:{frameRate:{numerator:24,denominator:1},tracks:[{kind:"video",clips:[{assetId:"v",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]},nonVideo]},assets,workDir:tmpdir()}),error=>error.code==="INVALID_TIMELINE_TRANSITION");
});


const hasMinterpolate=(()=>{const result=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-filters"],{encoding:"utf8"});return /\bminterpolate\b/.test((result.stdout||"")+"\n"+(result.stderr||""));})();
test("cloud renderer rejects optical-flow metadata on clips without a slow-motion section",async()=>{
 const time=value=>({value,rate:1});
 const timeline={frameRate:{numerator:24,denominator:1},tracks:[{kind:"video",clips:[{id:"v",assetId:"missing",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},metadata:{motionInterpolation:"optical-flow"}}]}]};
 await assert.rejects(()=>renderCloudTimeline({timeline,assets:new Map(),workDir:tmpdir()}),error=>error.code==="MOTION_INTERPOLATION_REQUIRES_SLOW_MOTION");
});
test("cloud renderer rejects unknown motion interpolation modes before asset access",async()=>{
 const time=value=>({value,rate:1});
 const timeline={frameRate:{numerator:24,denominator:1},tracks:[{kind:"video",clips:[{id:"v",assetId:"missing",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(1)},speed:0.5,metadata:{motionInterpolation:"neural-magic"}}]}]};
 await assert.rejects(()=>renderCloudTimeline({timeline,assets:new Map(),workDir:tmpdir()}),error=>error.code==="INVALID_MOTION_INTERPOLATION");
});
test("cloud FFmpeg renderer motion-compensates slow-motion frames and records the render receipt",{skip:!hasFfmpeg||!hasFfprobe||!hasMinterpolate},async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-optical-flow-test-"));
 try{
  const source=join(root,"slow-source.mp4");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","testsrc2=size=160x120:rate=12:duration=1","-c:v","libx264","-pix_fmt","yuv420p",source]);
  const time=value=>({value,rate:1});
  const timeline={name:"Optical flow slow motion",width:160,height:120,frameRate:{numerator:24,denominator:1},tracks:[{id:"v",kind:"video",clips:[
   {id:"slow",assetId:"source",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(1)},speed:0.5,metadata:{motionInterpolation:"optical-flow"}}
  ]}]};
  const assets=new Map([["source",{path:source,asset:{id:"source",mediaType:"video/mp4",originalName:"slow-source.mp4"}}]]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  assert.equal(result.render.motionInterpolatedClips,1);
  assert.equal(result.render.durationSeconds,2);
  const decoded=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",result.path,"-vf","scale=16:16,format=rgb24","-fps_mode","passthrough","-f","rawvideo","pipe:1"]);
  const frameBytes=16*16*3,unique=new Set();
  assert.equal(decoded.length%frameBytes,0);
  for(let offset=0;offset<decoded.length;offset+=frameBytes)unique.add(decoded.subarray(offset,offset+frameBytes).toString("base64"));
  assert.ok(unique.size>12,"motion interpolation should create intermediate frames beyond the 12 source frames");
 }finally{await rm(root,{recursive:true,force:true});}
});


test("cloud FFmpeg renderer fails closed when variable-speed audio requires unavailable Rubber Band", {skip:hasRubberband}, async()=>{
 const time=value=>({value,rate:1});
 const timeline={name:"Audio speed curve capability guard",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
  {id:"v",kind:"video",clips:[{id:"picture",assetId:"missing-video",timelineStart:time(0),duration:time(4),sourceRange:{start:time(0),duration:time(4)}}]},
  {id:"a",kind:"audio",clips:[{id:"ramp-audio",assetId:"missing-audio",timelineStart:time(0),duration:time(4),sourceRange:{start:time(0),duration:time(6)},speed:1,speedCurve:[{timeSeconds:0,speed:1},{timeSeconds:2,speed:2},{timeSeconds:4,speed:1}]}]}
 ]};
 await assert.rejects(()=>renderCloudTimeline({timeline,assets:new Map(),workDir:tmpdir()}),error=>error.code==="RUBBERBAND_UNAVAILABLE");
});

test("cloud FFmpeg renderer retimes variable-speed audio with frame-sampled Rubber Band commands",{skip:!hasFfmpeg||!hasFfprobe||!hasRubberband},async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-variable-audio-speed-test-"));
 try{
  const video=join(root,"picture.mp4"),audio=join(root,"source.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=navy:s=320x240:r=24:d=4","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=6","-c:a","pcm_s16le",audio]);
  const time=value=>({value,rate:1});
  const timeline={name:"Variable speed audio export",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"v",kind:"video",clips:[{id:"picture",assetId:"video",timelineStart:time(0),duration:time(4),sourceRange:{start:time(0),duration:time(4)}}]},
   {id:"a",kind:"audio",clips:[{id:"ramp-audio",assetId:"audio",timelineStart:time(0),duration:time(4),sourceRange:{start:time(0),duration:time(6)},speed:1,speedCurve:[{timeSeconds:0,speed:1},{timeSeconds:2,speed:2},{timeSeconds:4,speed:1}]}]}
  ]};
  const assets=new Map([
   ["video",{path:video,asset:{id:"video",mediaType:"video/mp4",originalName:"picture.mp4"}}],
   ["audio",{path:audio,asset:{id:"audio",mediaType:"audio/wav",originalName:"source.wav"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_streams","-of","json",result.path],{encoding:"utf8"}));
  const audioStream=probe.streams.find(stream=>stream.codec_type==="audio");
  assert.ok(audioStream,"variable-speed export should retain its audio stream");
  assert.ok(Math.abs(Number(audioStream.duration)-4)<0.08,"retimed audio should be padded/trimmed to the exact four-second clip duration");
  assert.equal(result.render.durationSeconds,4);
  assert.equal(result.render.retimedAudioClips,1);
 }finally{await rm(root,{recursive:true,force:true});}
});


test("cloud speed curves validate against full clip duration and clip safely to the master tail",()=>{
 const clip={duration:{value:4,rate:1},speedCurve:[{timeSeconds:0,speed:1},{timeSeconds:2,speed:2},{timeSeconds:4,speed:1}]};
 assert.ok(buildVariableSpeedSetptsExpression(clip,1.25).includes("sqrt"));
 assert.ok(Math.abs(sourceDurationForClip(clip,1.25)-1.640625)<1e-9);
 assert.throws(()=>sourceDurationForClip({...clip,speedCurve:[{timeSeconds:0,speed:1},{timeSeconds:5,speed:1}]},1.25),error=>error.code==="INVALID_SPEED_CURVE");
});


test("cloud renderer accepts audio automation keyframes through the full audio clip when the master ends earlier", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-audio-automation-tail-test-"));
 try{
  const video=join(root,"picture.mp4"),audio=join(root,"voice.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=blue:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=2","-c:a","pcm_s16le",audio]);
  const timeline={name:"Audio automation tail",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"v",kind:"video",clips:[{id:"picture",assetId:"video",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]},
   {id:"a",kind:"audio",clips:[{id:"voice",assetId:"audio",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(2)},audioAutomation:[
    {timeSeconds:0,gainDb:-3,interpolation:"linear"},
    {timeSeconds:1.5,gainDb:-18,interpolation:"linear"}
   ]}]}
  ]};
  const assets=new Map([
   ["video",{path:video,asset:{id:"video",mediaType:"video/mp4",originalName:"picture.mp4"}}],
   ["audio",{path:audio,asset:{id:"audio",mediaType:"audio/wav",originalName:"voice.wav"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","format=duration:stream=codec_type","-of","json",result.path],{encoding:"utf8"}));
  assert.ok(probe.streams.some(stream=>stream.codec_type==="video"));
  assert.ok(probe.streams.some(stream=>stream.codec_type==="audio"));
  assert.equal(result.render.audioClips,1);
  assert.equal(result.render.durationSeconds,1);
  assert.ok(Number(probe.format.duration)>=0.95&&Number(probe.format.duration)<=1.1,"the audio tail must not extend the one-second picture master");
 }finally{await rm(root,{recursive:true,force:true});}
});
