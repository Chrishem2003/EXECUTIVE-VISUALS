import test from "node:test";
import assert from "node:assert/strict";
import { rational } from "../../src/core/timeline.ts";
import { resolveTimelineAudioFrame } from "../../src/core/timeline-audio-preview.ts";

const clip=(id,start,duration,sourceStart,gainDb=0,speed=1)=>({
 id,assetId:"asset-"+id,name:id,sourceRange:{start:rational(sourceStart,1),duration:rational(duration,1)},
 timelineStart:rational(start,24),duration:rational(duration,24),enabled:true,gainDb,speed
});
const timeline=(tracks)=>({
 id:"mix",projectId:"p",name:"Audio mix",revision:1,frameRate:{numerator:24,denominator:1},
 width:1920,height:1080,pixelAspectRatio:1,tracks,markers:[],createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"
});

test("audio resolver mixes every enabled audio track at the requested frame",()=>{
 const value=timeline([
  {id:"a1",name:"Music",kind:"audio",enabled:true,locked:false,clips:[clip("music",0,120,4,-6,1)]},
  {id:"a2",name:"Voice",kind:"audio",enabled:true,locked:false,clips:[clip("voice",24,72,10,3,1.5)]},
  {id:"off",name:"Disabled",kind:"audio",enabled:false,locked:false,clips:[clip("muted",0,120,0)]}
 ]);
 const active=resolveTimelineAudioFrame(value,48);
 assert.deepEqual(active.map(item=>item.clipId),["music","voice"]);
 assert.equal(active[0].sourceSeconds,6);
 assert.equal(active[1].sourceSeconds,11.5);
 assert.ok(Math.abs(active[0].gainLinear-Math.pow(10,-6/20))<1e-12);
 assert.equal(active[1].playbackRate,1.5);
});

test("audio gain is clamped to supported dB range and output volume range",()=>{
 const value=timeline([{id:"a",name:"Audio",kind:"audio",enabled:true,locked:false,clips:[
  clip("quiet",0,24,0,-100),clip("loud",24,24,0,80)
 ]}]);
 assert.equal(resolveTimelineAudioFrame(value,0)[0].gainLinear,0.001);
 assert.equal(resolveTimelineAudioFrame(value,24)[0].gainLinear,1);
});

test("audio resolver returns no clips in gaps and ignores disabled clips",()=>{
 const value=timeline([{id:"a",name:"Audio",kind:"audio",enabled:true,locked:false,clips:[
  {...clip("disabled",0,24,0),enabled:false},clip("later",48,24,0)
 ]}]);
 assert.deepEqual(resolveTimelineAudioFrame(value,10),[]);
 assert.equal(resolveTimelineAudioFrame(value,50)[0].clipId,"later");
});

test("audio resolver rejects invalid playback speeds",()=>{
 const value=timeline([{id:"a",name:"Audio",kind:"audio",enabled:true,locked:false,clips:[clip("bad",0,24,0,0,0)]}]);
 assert.throws(()=>resolveTimelineAudioFrame(value,0),/speed must be positive/);
});
