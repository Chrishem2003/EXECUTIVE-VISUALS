import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline, addTrack, addClip, trimClip, splitClip, rational, seconds, validateTimeline } from "../../src/core/timeline.ts";

function fixture(){
 let timeline=createTimeline("project","timeline","Audio test",{numerator:24,denominator:1});
 timeline=addTrack(timeline,{id:"audio",name:"Audio",kind:"audio",enabled:true,locked:false,clips:[]});
 return addClip(timeline,"audio",{id:"clip",assetId:"asset",name:"Music",sourceRange:{start:rational(0,24),duration:rational(240,24)},timelineStart:rational(0,24),duration:rational(240,24),enabled:true,gainDb:0,pan:0,audioAutomation:[
  {timeSeconds:0,gainDb:0,pan:-1,interpolation:"linear"},
  {timeSeconds:5,gainDb:-12,pan:1,interpolation:"linear"},
  {timeSeconds:9,gainDb:-24,pan:0,interpolation:"step"}
 ]});
}
test("trimming audio clips shifts keyframes and inserts the evaluated boundary value",()=>{
 const next=trimClip(fixture(),"audio","clip",48,24),clip=next.tracks[0].clips[0];
 assert.equal(seconds(clip.duration),7);
 assert.equal(clip.audioAutomation[0].timeSeconds,0);
 assert.ok(Math.abs(clip.audioAutomation[0].gainDb+4.8)<1e-9);
 assert.ok(Math.abs(clip.audioAutomation[0].pan+0.2)<1e-9);
 assert.equal(clip.audioAutomation[1].timeSeconds,3);
 assert.equal(clip.audioAutomation[2].timeSeconds,7);
});
test("splitting audio clips preserves automation on both clip segments",()=>{
 const next=splitClip(fixture(),"audio","clip",120,"clip-b"),[first,second]=next.tracks[0].clips;
 assert.equal(seconds(first.duration),5);assert.equal(seconds(second.duration),5);
 assert.equal(first.audioAutomation.at(-1).timeSeconds,5);
 assert.equal(second.audioAutomation[0].timeSeconds,0);
 assert.equal(second.audioAutomation[0].gainDb,-12);
 assert.equal(second.audioAutomation[0].pan,1);
 assert.equal(second.audioAutomation[1].timeSeconds,4);
});
test("timeline validation accepts only frame-matched audio crossfade overlaps",()=>{
 const timeline=fixture(),track=timeline.tracks[0],first={id:"out",assetId:"out",name:"Outgoing",sourceRange:{start:rational(0,24),duration:rational(24,24)},timelineStart:rational(0,24),duration:rational(24,24),enabled:true,transitionToNext:{type:"crossfade",fadeFrames:6}},second={id:"in",assetId:"in",name:"Incoming",sourceRange:{start:rational(0,24),duration:rational(24,24)},timelineStart:rational(18,24),duration:rational(24,24),enabled:true};
 const valid={...timeline,tracks:[{...track,clips:[first,second]}]};
 assert.equal(validateTimeline(valid).valid,true);
 const mismatched={...valid,tracks:[{...track,clips:[first,{...second,timelineStart:rational(12,24)}]}]};
 assert.equal(validateTimeline(mismatched).issues[0].code,"crossfade_overlap_mismatch");
 const invalidType={...valid,tracks:[{...track,clips:[{...first,transitionToNext:{type:"dip-to-black",fadeFrames:6}},second]}]};
 assert.equal(validateTimeline(invalidType).issues[0].code,"invalid_transition");
});

test("timeline validation rejects malformed audio automation",()=>{
 const timeline=fixture(),clip=timeline.tracks[0].clips[0];
 clip.audioAutomation=[{timeSeconds:12,gainDb:-3}];
 assert.throws(()=>addClip(createTimeline("p","t"),"missing",clip),/Track not found/);
 const invalid={...timeline,tracks:timeline.tracks.map(track=>({...track,clips:track.clips.map(item=>({...item,audioAutomation:[{timeSeconds:12,gainDb:-3}]}))}))};
 assert.equal(validateTimeline(invalid).valid,false);
});
