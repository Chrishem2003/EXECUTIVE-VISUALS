import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVariableSpeedSetptsExpression, renderCloudTimeline } from "../cloud-ffmpeg-timeline-renderer.mjs";

const hasFfmpeg=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-version"],{stdio:"ignore"}).status===0;
const hasFfprobe=spawnSync(process.env.FFPROBE_PATH||"ffprobe",["-version"],{stdio:"ignore"}).status===0;
const hasMinterpolate=(()=>{const result=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-filters"],{encoding:"utf8"});return /\bminterpolate\b/.test((result.stdout||"")+"\\n"+(result.stderr||""));})();
const hasRubberband=(()=>{const result=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-filters"],{encoding:"utf8"});return /\brubberband\b/.test((result.stdout||"")+"\\n"+(result.stderr||""));})();
const time=(value)=>({value,rate:1});
test("variable-speed setpts mapping clips the curve at the effective render duration",()=>{
 const expression=buildVariableSpeedSetptsExpression({duration:time(4),speedCurve:[{timeSeconds:0,speed:1},{timeSeconds:2,speed:2},{timeSeconds:4,speed:1}]},1);
 assert.match(expression,/lt\(T,1\.25\)/);
 assert.doesNotMatch(expression,/lt\(T,3\)/);
});

test("cloud FFmpeg renderer reports missing Rubber Band capability before processing variable-speed audio",{skip:hasRubberband},async()=>{
 const timeline={name:"Audio speed curve export guard",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
  {id:"v",kind:"video",clips:[{id:"v1",assetId:"missing-video",timelineStart:time(0),duration:time(4),sourceRange:{start:time(0),duration:time(4)}}]},
  {id:"a",kind:"audio",clips:[{id:"a1",assetId:"missing-audio",timelineStart:time(0),duration:time(4),sourceRange:{start:time(0),duration:time(6)},speed:1,speedCurve:[{timeSeconds:0,speed:1},{timeSeconds:2,speed:2},{timeSeconds:4,speed:1}]}]}
 ]};
 await assert.rejects(()=>renderCloudTimeline({timeline,assets:new Map(),workDir:tmpdir(),onProgress(){}}),error=>error.code==="RUBBERBAND_UNAVAILABLE");
});

test("cloud FFmpeg renderer renders variable-speed video with exact integrated source-time mapping",{skip:!hasFfmpeg||!hasFfprobe},async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-variable-speed-test-"));
 try{
  const colors=["red","green","blue"],files=[];
  for(const color of colors){
   const path=join(root,color+".mp4");files.push(path);
   execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i",`color=c=${color}:s=320x240:r=24:d=2`,"-c:v","libx264","-pix_fmt","yuv420p",path]);
  }
  const listPath=join(root,"inputs.txt");
  await writeFile(listPath,files.map(path=>"file '"+path.replace(/'/g,"'\\''")+"'").join("\n")+"\n");
  const source=join(root,"source.mp4");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","concat","-safe","0","-i",listPath,"-c:v","libx264","-pix_fmt","yuv420p",source]);
  const timeline={name:"Variable speed export",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[{id:"v",kind:"video",clips:[
   {id:"ramp",assetId:"source",timelineStart:time(0),duration:time(4),sourceRange:{start:time(0),duration:time(6)},speed:1,speedCurve:[{timeSeconds:0,speed:1},{timeSeconds:2,speed:2},{timeSeconds:4,speed:1}]}
  ]}]};
  const assets=new Map([["source",{path:source,asset:{id:"source",mediaType:"video/mp4",originalName:"source.mp4"}}]]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  assert.equal(result.render.durationSeconds,4);
  const duration=Number(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",result.path],{encoding:"utf8"}).trim());
  assert.ok(Math.abs(duration-4)<0.06,"rendered video should match the four-second timeline duration");
  const pixels=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",result.path,"-vf","select='eq(n,24)+eq(n,48)+eq(n,72)',scale=1:1","-vsync","0","-frames:v","3","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]);
  assert.equal(pixels.length,9);
  const samples=[0,1,2].map(index=>[pixels[index*3],pixels[index*3+1],pixels[index*3+2]]);
  assert.ok(samples[0][0]>samples[0][1]*2,"one second into the ramp should still sample the red source interval");
  assert.ok(samples[1][1]>samples[1][0]*2,"two seconds into the ramp should sample the green source interval");
  assert.ok(samples[2][2]>samples[2][1]*2,"three seconds into the ramp should sample the blue source interval");
 }finally{await rm(root,{recursive:true,force:true});}
});

test("cloud FFmpeg renderer retimes variable-speed audio with frame-sampled Rubber Band commands",{skip:!hasFfmpeg||!hasFfprobe||!hasRubberband},async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-variable-audio-speed-test-"));
 try{
  const video=join(root,"picture.mp4"),audio=join(root,"source.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=navy:s=320x240:r=24:d=4","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=6","-c:a","pcm_s16le",audio]);
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
 }finally{await rm(root,{recursive:true,force:true});}
});

test("cloud FFmpeg renderer applies motion-compensated interpolation to retimed slow-motion video",{skip:!hasFfmpeg||!hasFfprobe||!hasMinterpolate},async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-motion-interpolation-test-"));
 try{
  const source=join(root,"source.mp4");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","testsrc2=size=320x240:rate=24:duration=2","-c:v","libx264","-pix_fmt","yuv420p",source]);
  const timeline={name:"Optical flow slow motion",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[{id:"v",kind:"video",clips:[
   {id:"slow",assetId:"source",timelineStart:time(0),duration:time(4),sourceRange:{start:time(0),duration:time(2)},speed:0.5,metadata:{motionInterpolationMultiplier:2}}
  ]}]};
  const assets=new Map([["source",{path:source,asset:{id:"source",mediaType:"video/mp4",originalName:"source.mp4"}}]]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  assert.equal(result.render.durationSeconds,4);
  assert.equal(result.render.motionInterpolatedVideoClips,1);
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-count_frames","-select_streams","v:0","-show_entries","stream=nb_read_frames,avg_frame_rate,duration","-of","json",result.path],{encoding:"utf8"}));
  assert.equal(Number(probe.streams[0].nb_read_frames),96);
  assert.ok(Math.abs(Number(probe.streams[0].duration)-4)<0.06);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("cloud FFmpeg renderer applies a frame-bounded dip-to-black transition between adjacent clips", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-transition-test-"));
 try{
  const red=join(root,"red.mp4"),green=join(root,"green.mp4");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=red:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",red]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=green:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",green]);
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
  const pixels=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",result.path,"-vf","select='eq(n,23)+eq(n,24)+eq(n,30)',scale=1:1","-vsync","0","-frames:v","3","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]);
  assert.equal(pixels.length,9);
  const brightness=[0,1,2].map(index=>pixels[index*3]+pixels[index*3+1]+pixels[index*3+2]);
  assert.ok(brightness[0]<60,"the outgoing clip should be almost black at the end of its fade");
  assert.ok(brightness[1]<40,"the incoming clip should begin at black");
  assert.ok(brightness[2]>100,"the incoming clip should reach full brightness after its fade");
 }finally{await rm(root,{recursive:true,force:true});}
});
test("cloud FFmpeg renderer creates a frame-accurate primary video crossfade with exact overlap duration", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-crossfade-test-"));
 try{
  const red=join(root,"red.mp4"),green=join(root,"green.mp4");
  for(const [color,path] of [["red",red],["green",green]])execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i",`color=c=${color}:s=320x240:r=24:d=1`,"-c:v","libx264","-pix_fmt","yuv420p",path]);
  const timeline={name:"Crossfade test",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[{id:"primary",kind:"video",clips:[
   {id:"outgoing",assetId:"red",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},transitionToNext:{type:"crossfade",fadeFrames:6}},
   {id:"incoming",assetId:"green",timelineStart:time(.75),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}
  ]}]};
  const assets=new Map([
   ["red",{path:red,asset:{id:"red",mediaType:"video/mp4",originalName:"red.mp4"}}],
   ["green",{path:green,asset:{id:"green",mediaType:"video/mp4",originalName:"green.mp4"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  assert.equal(result.render.transitions,1);
  assert.equal(result.render.durationSeconds,1.75);
  const pixels=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",result.path,"-vf","select='eq(n,18)+eq(n,21)+eq(n,24)',crop=2:2:10:10,scale=1:1","-vsync","0","-frames:v","3","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]);
  assert.equal(pixels.length,9);
  const samples=[0,1,2].map(index=>[pixels[index*3],pixels[index*3+1],pixels[index*3+2]]);
  assert.ok(samples[0][0]>samples[0][1]*2,"the transition should begin with the outgoing red clip");
  assert.ok(samples[1][0]>60&&samples[1][1]>60,"the midpoint should blend outgoing red and incoming green");
  assert.ok(samples[2][1]>samples[2][0]*2,"the transition should finish with the incoming green clip");
 }finally{await rm(root,{recursive:true,force:true});}
});
test("cloud FFmpeg renderer rejects invalid dip-to-black transition metadata before materializing inputs",async()=>{
 const timeline={frameRate:{numerator:24,denominator:1},tracks:[{kind:"video",clips:[
  {assetId:"v",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},transitionToNext:{type:"dip-to-black",fadeFrames:0}},
  {assetId:"v",timelineStart:time(1),duration:time(1),sourceRange:{start:time(1),duration:time(1)}}
 ]}]};
 const assets=new Map([["v",{path:"/not-used.mp4",asset:{id:"v",mediaType:"video/mp4",originalName:"v.mp4"}}]]);
 await assert.rejects(()=>renderCloudTimeline({timeline,assets,workDir:tmpdir()}),error=>error.code==="INVALID_TIMELINE_TRANSITION");
});

test("cloud FFmpeg renderer composites a timed secondary video track over the primary picture", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-multitrack-test-"));
 try{
  const blue=join(root,"blue.mp4"),red=join(root,"red.mp4");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=blue:s=320x240:r=24:d=2","-c:v","libx264","-pix_fmt","yuv420p",blue]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=red:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",red]);
  const timeline={name:"Multitrack test",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"primary",kind:"video",clips:[{id:"base",assetId:"blue",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(2)}}]},
   {id:"secondary",kind:"video",clips:[{id:"insert",assetId:"red",timelineStart:time(.5),duration:time(1),sourceRange:{start:time(0),duration:time(1)},metadata:{x:0,y:0,width:160,height:120,opacity:1}}]}
  ]};
  const assets=new Map([
   ["blue",{path:blue,asset:{id:"blue",mediaType:"video/mp4",originalName:"blue.mp4"}}],
   ["red",{path:red,asset:{id:"red",mediaType:"video/mp4",originalName:"red.mp4"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  assert.equal(result.render.videoClips,2);
  assert.equal(result.render.primaryVideoClips,1);
  assert.equal(result.render.secondaryVideoClips,1);
  const pixels=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",result.path,"-vf","select='eq(n,0)+eq(n,24)+eq(n,47)',crop=2:2:10:10,scale=1:1","-vsync","0","-frames:v","3","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]);
  assert.equal(pixels.length,9);
  const samples=[0,1,2].map(index=>[pixels[index*3],pixels[index*3+1],pixels[index*3+2]]);
  assert.ok(samples[0][2]>samples[0][0]*2,"the primary blue picture should be visible before the secondary clip starts");
  assert.ok(samples[1][0]>samples[1][2]*2,"the red secondary video should composite over the primary during its active interval");
  assert.ok(samples[2][2]>samples[2][0]*2,"the primary picture should be visible again after the secondary clip ends");
 }finally{await rm(root,{recursive:true,force:true});}
});
test("cloud FFmpeg renderer rejects overlapping clips within a secondary video track",async()=>{
 const timeline={tracks:[
  {kind:"video",clips:[{assetId:"primary",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(2)}}]},
  {kind:"video",clips:[
   {assetId:"secondary",timelineStart:time(0),duration:time(1.5),sourceRange:{start:time(0),duration:time(1.5)}},
   {assetId:"secondary",timelineStart:time(1),duration:time(1),sourceRange:{start:time(1.5),duration:time(1)}}
  ]}
 ]};
 const assets=new Map([
  ["primary",{path:"/not-used-primary.mp4",asset:{id:"primary",mediaType:"video/mp4",originalName:"primary.mp4"}}],
  ["secondary",{path:"/not-used-secondary.mp4",asset:{id:"secondary",mediaType:"video/mp4",originalName:"secondary.mp4"}}]
 ]);
 await assert.rejects(()=>renderCloudTimeline({timeline,assets,workDir:tmpdir()}),error=>error.code==="TIMELINE_OVERLAP");
});
test("cloud FFmpeg renderer applies secondary-track fades through transparency while preserving the primary picture", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-secondary-fade-test-"));
 try{
  const blue=join(root,"blue.mp4"),red=join(root,"red.mp4"),green=join(root,"green.mp4");
  for(const [color,path] of [["blue",blue],["red",red],["green",green]])execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i",`color=c=${color}:s=320x240:r=24:d=2`,"-c:v","libx264","-pix_fmt","yuv420p",path]);
  const timeline={name:"Secondary fade test",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"primary",kind:"video",clips:[{id:"base",assetId:"blue",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(2)}}]},
   {id:"secondary",kind:"video",clips:[
    {id:"red-layer",assetId:"red",timelineStart:time(.5),duration:time(1),sourceRange:{start:time(0),duration:time(1)},transitionToNext:{type:"dip-to-black",fadeFrames:6}},
    {id:"green-layer",assetId:"green",timelineStart:time(1.5),duration:time(.5),sourceRange:{start:time(0),duration:time(.5)}}
   ]}
  ]};
  const assets=new Map([
   ["blue",{path:blue,asset:{id:"blue",mediaType:"video/mp4",originalName:"blue.mp4"}}],
   ["red",{path:red,asset:{id:"red",mediaType:"video/mp4",originalName:"red.mp4"}}],
   ["green",{path:green,asset:{id:"green",mediaType:"video/mp4",originalName:"green.mp4"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  assert.equal(result.render.transitions,1);
  const pixels=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",result.path,"-vf","select='eq(n,30)+eq(n,35)+eq(n,42)',crop=2:2:10:10,scale=1:1","-vsync","0","-frames:v","3","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]);
  assert.equal(pixels.length,9);
  const samples=[0,1,2].map(index=>[pixels[index*3],pixels[index*3+1],pixels[index*3+2]]);
  assert.ok(samples[0][0]>samples[0][2]*2,"the outgoing red secondary layer should initially cover the blue primary");
  assert.ok(samples[1][2]>samples[1][0]*2,"the outgoing layer should fade to transparency and reveal the blue primary");
  assert.ok(samples[2][1]>samples[2][2]*1.5,"the incoming green secondary layer should fade in above the primary");
 }finally{await rm(root,{recursive:true,force:true});}
});
test("cloud FFmpeg renderer rejects invalid secondary-track transition metadata",async()=>{
 const timeline={frameRate:{numerator:24,denominator:1},tracks:[
  {kind:"video",clips:[{assetId:"primary",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(2)}}]},
  {kind:"video",clips:[
   {assetId:"secondary",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},transitionToNext:{type:"dip-to-black",fadeFrames:0}},
   {assetId:"secondary",timelineStart:time(1),duration:time(1),sourceRange:{start:time(1),duration:time(1)}}
  ]}
 ]};
 const assets=new Map([["secondary",{path:"/not-used-secondary.mp4",asset:{id:"secondary",mediaType:"video/mp4",originalName:"secondary.mp4"}}]]);
 await assert.rejects(()=>renderCloudTimeline({timeline,assets,workDir:tmpdir()}),error=>error.code==="INVALID_TIMELINE_TRANSITION");
});
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
  const masterDuration=Number(probe.format?.duration);
  assert.ok(masterDuration>=0.95&&masterDuration<=1.1,"the rendered master must remain approximately one second, not extend to the two-second audio tail");
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

test("cloud FFmpeg renderer rejects automation beyond the full audio clip even when the render window is shorter",async()=>{
 const timeline={tracks:[
  {kind:"video",clips:[{assetId:"v",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]},
  {kind:"audio",clips:[{assetId:"a",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(2)},audioAutomation:[{timeSeconds:2.1,gainDb:-12}]}]}
 ]};
 const assets=new Map([
  ["v",{path:"/not-used-video.mp4",asset:{id:"v",mediaType:"video/mp4",originalName:"v.mp4"}}],
  ["a",{path:"/not-used-audio.wav",asset:{id:"a",mediaType:"audio/wav",originalName:"a.wav"}}]
 ]);
 await assert.rejects(()=>renderCloudTimeline({timeline,assets,workDir:tmpdir()}),error=>error.code==="INVALID_AUDIO_AUTOMATION");
});

test("cloud FFmpeg renderer rejects overlapping primary video clips",async()=>{
 const timeline={tracks:[{kind:"video",clips:[
  {assetId:"v",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(2)}},
  {assetId:"v",timelineStart:time(1),duration:time(1),sourceRange:{start:time(2),duration:time(1)}}
 ]}]};
 const assets=new Map([["v",{path:"/not-used.mp4",asset:{id:"v",mediaType:"video/mp4",originalName:"v.mp4"}}]]);
 await assert.rejects(()=>renderCloudTimeline({timeline,assets,workDir:tmpdir()}),error=>error.code==="TIMELINE_OVERLAP");
});

test("cloud FFmpeg renderer applies frame-accurate audio crossfades on audio tracks", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-audio-crossfade-test-"));
 try{
  const video=join(root,"picture.mp4"),first=join(root,"first.wav"),second=join(root,"second.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=blue:s=320x240:r=24:d=1.75","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:duration=1","-c:a","pcm_s16le",first]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=660:duration=1","-c:a","pcm_s16le",second]);
  const timeline={name:"Audio transition test",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"v",kind:"video",clips:[{id:"v1",assetId:"picture",timelineStart:time(0),duration:time(1.75),sourceRange:{start:time(0),duration:time(1.75)}}]},
   {id:"a",kind:"audio",clips:[
    {id:"a1",assetId:"first",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},transitionToNext:{type:"crossfade",fadeFrames:6}},
    {id:"a2",assetId:"second",timelineStart:time(0.75),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}
   ]}
  ]};
  const assets=new Map([
   ["picture",{path:video,asset:{id:"picture",mediaType:"video/mp4",originalName:"picture.mp4"}}],
   ["first",{path:first,asset:{id:"first",mediaType:"audio/wav",originalName:"first.wav"}}],
   ["second",{path:second,asset:{id:"second",mediaType:"audio/wav",originalName:"second.wav"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","format=duration:stream=codec_type","-of","json",result.path],{encoding:"utf8"}));
  assert.ok(probe.streams.some(stream=>stream.codec_type==="audio"));
  assert.equal(result.render.audioCrossfades,1);
  assert.ok(Number(probe.format.duration)>=1.7&&Number(probe.format.duration)<=1.8);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("cloud FFmpeg renderer retimes video and audio sources at the requested constant speed", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-time-remap-test-"));
 try{
  const video=join(root,"picture.mp4"),audio=join(root,"music.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","testsrc2=s=320x240:r=24:d=2","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:duration=2","-c:a","pcm_s16le",audio]);
  const timeline={name:"Constant speed test",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"v",kind:"video",clips:[{id:"v1",assetId:"picture",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(2)},speed:2}]},
   {id:"a",kind:"audio",clips:[{id:"a1",assetId:"music",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(2)},speed:2}]}
  ]};
  const assets=new Map([
   ["picture",{path:video,asset:{id:"picture",mediaType:"video/mp4",originalName:"picture.mp4"}}],
   ["music",{path:audio,asset:{id:"music",mediaType:"audio/wav",originalName:"music.wav"}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","format=duration:stream=codec_type","-of","json",result.path],{encoding:"utf8"}));
  const duration=Number(probe.format.duration);
  assert.ok(duration>=0.95&&duration<=1.1,"the two-second source should render to one second at 2×");
  assert.ok(probe.streams.some(stream=>stream.codec_type==="video"));
  assert.ok(probe.streams.some(stream=>stream.codec_type==="audio"));
 }finally{await rm(root,{recursive:true,force:true});}
});

test("cloud FFmpeg renderer rejects audio crossfades with mismatched overlap",async()=>{
 const timeline={tracks:[
  {kind:"video",clips:[{assetId:"v",timelineStart:time(0),duration:time(2),sourceRange:{start:time(0),duration:time(2)}}]},
  {kind:"audio",clips:[
   {assetId:"a",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},transitionToNext:{type:"crossfade",fadeFrames:6}},
   {assetId:"a",timelineStart:time(0.5),duration:time(1),sourceRange:{start:time(1),duration:time(1)}}
  ]}
 ]};
 const assets=new Map([["v",{path:"/not-used-video.mp4",asset:{id:"v",mediaType:"video/mp4",originalName:"v.mp4"}}],["a",{path:"/not-used-audio.wav",asset:{id:"a",mediaType:"audio/wav",originalName:"a.wav"}}]]);
 await assert.rejects(()=>renderCloudTimeline({timeline,assets,workDir:tmpdir()}),error=>error.code==="INVALID_TIMELINE_TRANSITION");
});

test("cloud FFmpeg renderer rejects transitions on non-video tracks",async()=>{
 const timeline={tracks:[
  {kind:"video",clips:[{assetId:"v",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]},
  {kind:"audio",clips:[{assetId:"a",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},transitionToNext:{type:"dip-to-black",fadeFrames:6}}]}
 ]};
 const assets=new Map([
  ["v",{path:"/not-used-video.mp4",asset:{id:"v",mediaType:"video/mp4",originalName:"v.mp4"}}],
  ["a",{path:"/not-used-audio.wav",asset:{id:"a",mediaType:"audio/wav",originalName:"a.wav"}}]
 ]);
 await assert.rejects(()=>renderCloudTimeline({timeline,assets,workDir:tmpdir()}),error=>error.code==="INVALID_TIMELINE_TRANSITION");
});
test("cloud FFmpeg renderer honours an already-aborted signal",async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(()=>renderCloudTimeline({timeline:{tracks:[]},assets:new Map(),workDir:tmpdir(),signal:controller.signal}),error=>error.code==="JOB_CANCELLED");
});
test("cloud FFmpeg renderer matches Web Audio equal-power panning for mono sources", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-mono-pan-parity-test-"));
 try{
  const video=join(root,"picture.mp4"),audio=join(root,"mono.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=blue:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=1","-ac","1","-c:a","pcm_s16le",audio]);
  const timeline={name:"Mono pan parity",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"v",kind:"video",clips:[{id:"v1",assetId:"picture",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]},
   {id:"a",kind:"audio",clips:[{id:"a1",assetId:"mono",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},gainDb:0,pan:0}]}
  ]};
  const assets=new Map([
   ["picture",{path:video,asset:{id:"picture",mediaType:"video/mp4",originalName:"picture.mp4"}}],
   ["mono",{path:audio,asset:{id:"mono",mediaType:"audio/wav",originalName:"mono.wav",metadata:{probe:{streams:[{codec_type:"audio",channels:1}]}}}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const input=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",audio,"-f","f32le","-acodec","pcm_f32le","-ar","48000","-ac","1","pipe:1"]);
  const output=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",result.path,"-map","0:a:0","-f","f32le","-acodec","pcm_f32le","-ar","48000","-ac","2","pipe:1"]);
  const source=new Float32Array(input.buffer,input.byteOffset,input.byteLength/4),samples=new Float32Array(output.buffer,output.byteOffset,output.byteLength/4);
  const rms=(values,channelCount,channel)=>{let sum=0,count=0;for(let frame=4800;frame<values.length/channelCount-4800;frame++){const value=values[frame*channelCount+channel]||0;sum+=value*value;count++;}return Math.sqrt(sum/Math.max(1,count));};
  const sourceLevel=rms(source,1,0),left=rms(samples,2,0),right=rms(samples,2,1);
  assert.ok(Math.abs(left/right-1)<0.06,"center mono pan should remain balanced across output channels");
  assert.ok(Math.abs(left/sourceLevel-Math.SQRT1_2)<0.08,"center mono pan should apply the equal-power -3 dB coefficient (source="+sourceLevel+", left="+left+", right="+right+", ratio="+(left/sourceLevel)+")");
 }finally{await rm(root,{recursive:true,force:true});}
});

test("cloud FFmpeg renderer matches Web Audio stereo panning for stereo sources", {skip:!hasFfmpeg||!hasFfprobe}, async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-stereo-pan-parity-test-"));
 try{
  const video=join(root,"picture.mp4"),audio=join(root,"stereo.wav");
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=blue:s=320x240:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",video]);
  execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","aevalsrc=0.1*sin(2*PI*440*t)|0.1*sin(2*PI*880*t):s=48000:d=1","-c:a","pcm_s16le",audio]);
  const timeline={name:"Stereo pan parity",width:320,height:240,frameRate:{numerator:24,denominator:1},tracks:[
   {id:"v",kind:"video",clips:[{id:"v1",assetId:"picture",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)}}]},
   {id:"a",kind:"audio",clips:[{id:"a1",assetId:"stereo",timelineStart:time(0),duration:time(1),sourceRange:{start:time(0),duration:time(1)},gainDb:0,pan:0.5}]}
  ]};
  const assets=new Map([
   ["picture",{path:video,asset:{id:"picture",mediaType:"video/mp4",originalName:"picture.mp4"}}],
   ["stereo",{path:audio,asset:{id:"stereo",mediaType:"audio/wav",originalName:"stereo.wav",metadata:{probe:{streams:[{codec_type:"audio",channels:2}]}}}}]
  ]);
  const result=await renderCloudTimeline({timeline,assets,workDir:root,onProgress(){}});
  const output=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-i",result.path,"-map","0:a:0","-f","f32le","-acodec","pcm_f32le","-ar","48000","-ac","2","pipe:1"]);
  const samples=new Float32Array(output.buffer,output.byteOffset,output.byteLength/4);
  const rms=channel=>{let sum=0,count=0;for(let frame=4800;frame<samples.length/2-4800;frame++){const value=samples[frame*2+channel]||0;sum+=value*value;count++;}return Math.sqrt(sum/Math.max(1,count));};
  const left=rms(0),right=rms(1),ratio=left/right;
  assert.ok(Math.abs(ratio-(1/Math.sqrt(3)))<0.09,"stereo pan at +0.5 should follow the StereoPannerNode equal-power channel matrix (left/right="+ratio+")");
 }finally{await rm(root,{recursive:true,force:true});}
});
