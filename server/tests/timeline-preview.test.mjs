import test from "node:test";
import assert from "node:assert/strict";
import { rational } from "../../src/core/timeline.ts";
import { clipSourceSecondsAtTimelineFrame, clampPreviewSeconds, decibelsToLinearGain, isPreviewTrackAudible, frameToSeconds, getTimelineDurationFrames, resolveTimelineFrame, resolveTimelineOverlays, secondsToFrame, stepPreviewSeconds } from "../../src/core/timeline-preview.ts";

const rate={numerator:30000,denominator:1001};
const clip={id:"c",assetId:"a",name:"clip",sourceRange:{start:rational(90,30),duration:rational(150,30)},timelineStart:rational(30,24),duration:rational(120,24),enabled:true};

test("rational frame conversion preserves fractional frame rates",()=>{
 assert.equal(frameToSeconds(30000,rate),1001);
 assert.equal(secondsToFrame(1001,rate),30000);
 assert.equal(frameToSeconds(1,{numerator:24,denominator:1}),1/24);
});

test("clip preview maps timeline frames to source time and respects source trims",()=>{
 assert.equal(clipSourceSecondsAtTimelineFrame(clip,30,{numerator:24,denominator:1}),3);
 assert.equal(clipSourceSecondsAtTimelineFrame(clip,54,{numerator:24,denominator:1}),4);
 assert.equal(clipSourceSecondsAtTimelineFrame(clip,500,{numerator:24,denominator:1}),8);
});

const makeClip=(id,trackId,start,duration,sourceStart=0,speed=1)=>({
 id,assetId:"asset-"+id,name:id,sourceRange:{start:rational(sourceStart,1),duration:rational(20,1)},
 timelineStart:rational(start,24),duration:rational(duration,24),enabled:true,speed,metadata:{trackId}
});
const makeTimeline=(tracks)=>({
 id:"timeline",projectId:"project",name:"Sequence",revision:1,frameRate:{numerator:24,denominator:1},
 width:1920,height:1080,pixelAspectRatio:1,tracks,markers:[],createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"
});

test("sequence resolver returns all active layers in track order with correct source-time mapping",()=>{
 const video=makeClip("video", "v1",24,48,3,2);
 const overlay=makeClip("overlay","o1",36,24,7);
 const muted=makeClip("muted","a1",0,120);
 const timeline=makeTimeline([
  {id:"v1",name:"Video",kind:"video",enabled:true,locked:false,clips:[video]},
  {id:"o1",name:"Overlay",kind:"overlay",enabled:true,locked:false,clips:[overlay]},
  {id:"a1",name:"Muted track",kind:"audio",enabled:false,locked:false,clips:[muted]}
 ]);
 const active=resolveTimelineFrame(timeline,48);
 assert.deepEqual(active.map(item=>item.clip.id),["video","overlay"]);
 assert.equal(active[0].sourceSeconds,5);
 assert.equal(active[1].sourceSeconds,7.5);
 assert.equal(active[0].timelineSeconds,2);
});

test("sequence resolver treats clip out points as exclusive and respects disabled clips",()=>{
 const timeline=makeTimeline([{id:"v",name:"Video",kind:"video",enabled:true,locked:false,clips:[
  makeClip("first","v",0,24),{...makeClip("disabled","v",24,24),enabled:false}
 ]}]);
 assert.equal(resolveTimelineFrame(timeline,23).length,1);
 assert.equal(resolveTimelineFrame(timeline,24).length,0);
});

test("sequence duration includes enabled tracks and rounds up fractional final frames",()=>{
 const timeline=makeTimeline([{id:"v",name:"Video",kind:"video",enabled:true,locked:false,clips:[
  {...makeClip("fractional","v",0,25),duration:rational(25.2,24)}
 ]},{id:"off",name:"Off",kind:"audio",enabled:false,locked:false,clips:[makeClip("ignored","off",0,240)]}]);
 assert.equal(getTimelineDurationFrames(timeline),26);
});

test("preview seek clamps to source in/out and frame steps use source rate",()=>{
 assert.equal(clampPreviewSeconds(-1,3,8),3);
 assert.equal(clampPreviewSeconds(12,3,8),8);
 assert.equal(stepPreviewSeconds(4,1,25,3,8),4.04);
 assert.equal(stepPreviewSeconds(3,-1,25,3,8),3);
});

test("invalid frame and playback inputs fail closed",()=>{
 assert.throws(()=>frameToSeconds(-1,rate));
 assert.throws(()=>secondsToFrame(Number.NaN,rate));
 assert.throws(()=>stepPreviewSeconds(4,1,0,3,8));
 assert.throws(()=>clampPreviewSeconds(2,4,3));
});

test("decibel gain maps to linear amplitude and clamps to the supported preview range",()=>{
 assert.equal(decibelsToLinearGain(0),1);
 assert.ok(Math.abs(decibelsToLinearGain(-6.020599913)-0.5)<1e-8);
 assert.equal(decibelsToLinearGain(-100),0.001);
 assert.ok(Math.abs(decibelsToLinearGain(24)-15.8489319246)<1e-8);
 assert.throws(()=>decibelsToLinearGain(Number.NaN));
});
test("sequence resolver keeps simultaneous audio clips on separate tracks",()=>{
 const timeline=makeTimeline([
  {id:"music",name:"Music",kind:"audio",enabled:true,locked:false,clips:[makeClip("music-bed","music",0,96,0,1)]},
  {id:"voice",name:"Voice",kind:"audio",enabled:true,locked:false,clips:[makeClip("voiceover","voice",24,48,2,1.25)]}
 ]);
 const active=resolveTimelineFrame(timeline,48);
 assert.deepEqual(active.map(item=>item.clip.id),["music-bed","voiceover"]);
 assert.deepEqual(active.map(item=>item.track.kind),["audio","audio"]);
 assert.equal(active[1].sourceSeconds,3.25);
});

test("preview mute and solo routing is temporary and does not alter timeline tracks",()=>{
 const muted=new Set(["music"]);
 assert.equal(isPreviewTrackAudible("music",muted,null),false);
 assert.equal(isPreviewTrackAudible("voice",muted,null),true);
 assert.equal(isPreviewTrackAudible("music",new Set(),"voice"),false);
 assert.equal(isPreviewTrackAudible("voice",new Set(),"voice"),true);
 assert.equal(isPreviewTrackAudible("voice",new Set(),null),true);
});

test("overlay resolver preserves track order and clamps geometry to the sequence canvas",()=>{
 const first=makeClip("logo","ov1",0,48),second={...makeClip("bug","ov2",0,48),metadata:{x:5000,y:-5,width:3000,height:10,opacity:2}};
 const timeline=makeTimeline([
  {id:"base",name:"Picture",kind:"video",enabled:true,locked:false,clips:[makeClip("base-shot","base",0,48)]},
  {id:"ov1",name:"Logo",kind:"overlay",enabled:true,locked:false,clips:[{...first,metadata:{x:24,y:36,width:240,height:120,opacity:0.75}}]},
  {id:"ov2",name:"Bug",kind:"overlay",enabled:true,locked:false,clips:[second]},
  {id:"off",name:"Disabled overlay",kind:"overlay",enabled:false,locked:false,clips:[makeClip("hidden","off",0,48)]}
 ]);
 const overlays=resolveTimelineOverlays(timeline,12);
 assert.deepEqual(overlays.map(item=>item.clip.id),["logo","bug"]);
 assert.deepEqual([overlays[0].x,overlays[0].y,overlays[0].width,overlays[0].height,overlays[0].opacity],[24,36,240,120,0.75]);
 assert.deepEqual([overlays[1].x,overlays[1].y,overlays[1].width,overlays[1].height,overlays[1].opacity],[0,0,1920,16,1]);
 assert.equal(resolveTimelineOverlays(timeline,48).length,0);
});
