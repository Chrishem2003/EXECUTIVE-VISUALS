import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAudioAutomation, evaluateAudioAutomation, buildGainAutomationExpression } from "../../src/core/audio-automation.ts";
import { createTimeline, addTrack, addClip, rational, validateTimeline, toOpenTimelineIo } from "../../src/core/timeline.ts";

const points=[{timeSeconds:1,gainDb:-12,pan:-1,interpolation:"linear"},{timeSeconds:3,gainDb:-24,pan:1,interpolation:"step"}];

test("normalizes audio automation bounds, ordering and interpolation",()=>{
 const normalized=normalizeAudioAutomation([{timeSeconds:2,gainDb:40,pan:2},{timeSeconds:1,gainDb:-80,pan:-2}]);
 assert.deepEqual(normalized.map(point=>point.timeSeconds),[1,2]);
 assert.equal(normalized[0].gainDb,-60);assert.equal(normalized[0].pan,-1);
 assert.equal(normalized[1].gainDb,24);assert.equal(normalized[1].pan,1);
 assert.ok(Math.abs(evaluateAudioAutomation(points,.5,"gainDb",0)+6)<1e-9);
 assert.equal(evaluateAudioAutomation(points,2,"gainDb",0),-12);
 assert.equal(evaluateAudioAutomation(points,4,"pan",0),1);
});

test("rejects malformed, duplicate and excessive automation keyframes",()=>{
 assert.throws(()=>normalizeAudioAutomation([{timeSeconds:1,gainDb:0},{timeSeconds:1,pan:0}]),/unique/);
 assert.throws(()=>normalizeAudioAutomation([{timeSeconds:-1,gainDb:0}]),/time/);
 assert.throws(()=>normalizeAudioAutomation([{timeSeconds:1}]),/define gain or pan/);
 assert.throws(()=>normalizeAudioAutomation(Array.from({length:257},(_,i)=>({timeSeconds:i,gainDb:0}))),/256/);
});

test("builds bounded FFmpeg gain expressions for linear and step automation",()=>{
 const expression=buildGainAutomationExpression(points,0);
 assert.match(expression,/if\(lt\(t,1\)/);
 assert.match(expression,/0\.251188643/);
 assert.equal(buildGainAutomationExpression([],0),"1");
});

test("timeline validates and exports audio pan and automation with the clip",()=>{
 const timeline=createTimeline("project","timeline");
 const withVideo=addTrack(timeline,{id:"v",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});
 const withAudio=addTrack(withVideo,{id:"a",name:"Audio",kind:"audio",enabled:true,locked:false,clips:[]});
 const clip={id:"a1",assetId:"audio-1",name:"Voice",sourceRange:{start:rational(0,1),duration:rational(4,1)},timelineStart:rational(0,1),duration:rational(4,1),enabled:true,gainDb:-3,pan:-.25,audioAutomation:points};
 const result=addClip(withAudio,"a",clip);
 assert.equal(validateTimeline(result).valid,true);
 const otio=toOpenTimelineIo(result);
 const exported=otio.tracks.children[1].children[0].metadata.executiveVisuals;
 assert.equal(exported.pan,-.25);
 assert.deepEqual(exported.audioAutomation,points);
 const invalid={...result,tracks:result.tracks.map(track=>track.id==="a"?{...track,clips:[{...clip,audioAutomation:[{timeSeconds:5,gainDb:-3}]}]}:track)};
 assert.equal(validateTimeline(invalid).issues.some(issue=>issue.code==="invalid_audio_automation"),true);
});
