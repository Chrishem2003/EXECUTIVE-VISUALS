import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline, addTrack, addClip, trimClip, splitClip, rational, seconds, validateTimeline, evaluateTimelineAtFrame } from "../../src/core/timeline.ts";

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
test("constant-speed remapping keeps timeline duration and maps source time at playback rate",()=>{
 const timeline=createTimeline("project","speed","Speed test",{numerator:24,denominator:1});
 const withTrack=addTrack(timeline,{id:"video",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});
 const clip={id:"fast",assetId:"source",name:"Fast clip",sourceRange:{start:rational(0,24),duration:rational(480,24)},timelineStart:rational(0,24),duration:rational(240,24),enabled:true,speed:2};
 const added=addClip(withTrack,"video",clip),evaluated=validateTimeline(added);
 assert.equal(evaluated.valid,true);
 const frame=evaluateTimelineAtFrame(added,24).activeClips[0];
 assert.equal(frame.sourceTimeSeconds,2);
 assert.equal(frame.playbackSpeed,2);
});

test("trimming and splitting a retimed clip preserve source-to-record mapping",()=>{
 const timeline=createTimeline("project","speed-edit","Speed edit",{numerator:24,denominator:1});
 const withTrack=addTrack(timeline,{id:"video",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});
 const added=addClip(withTrack,"video",{id:"fast",assetId:"source",name:"Fast clip",sourceRange:{start:rational(0,24),duration:rational(480,24)},timelineStart:rational(0,24),duration:rational(240,24),enabled:true,speed:2});
 const trimmed=trimClip(added,"video","fast",24,24),trimmedClip=trimmed.tracks[0].clips[0];
 assert.equal(seconds(trimmedClip.timelineStart),1);
 assert.equal(seconds(trimmedClip.duration),8);
 assert.equal(seconds(trimmedClip.sourceRange.start),2);
 assert.equal(seconds(trimmedClip.sourceRange.duration),16);
 const split=splitClip(added,"video","fast",120,"fast-b"),[first,second]=split.tracks[0].clips;
 assert.equal(seconds(first.duration),5);
 assert.equal(seconds(first.sourceRange.duration),10);
 assert.equal(seconds(second.timelineStart),5);
 assert.equal(seconds(second.sourceRange.start),10);
 assert.equal(seconds(second.sourceRange.duration),10);
});

test("retimed trim and split preserve source time when start and duration use different timebases",()=>{
 const timeline=createTimeline("project","speed-timebases","Mixed source timebases",{numerator:24,denominator:1});
 const withTrack=addTrack(timeline,{id:"video",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});
 const clip={id:"mixed",assetId:"source",name:"Mixed-rate source",sourceRange:{start:rational(30,30),duration:rational(480,24)},timelineStart:rational(0,24),duration:rational(240,24),enabled:true,speed:2};
 const added=addClip(withTrack,"video",clip);
 const trimmed=trimClip(added,"video","mixed",24,24).tracks[0].clips[0];
 assert.equal(seconds(trimmed.sourceRange.start),3);
 assert.equal(seconds(trimmed.sourceRange.duration),18);
 const [first,second]=splitClip(added,"video","mixed",120,"mixed-b").tracks[0].clips;
 assert.equal(seconds(first.sourceRange.duration),10);
 assert.equal(seconds(second.sourceRange.start),11);
 assert.equal(seconds(second.sourceRange.duration),10);
});

test("timeline validation rejects non-finite and out-of-range playback speeds",()=>{
 const timeline=createTimeline("project","speed-invalid","Invalid speed",{numerator:24,denominator:1});
 const withTrack=addTrack(timeline,{id:"video",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});
 const base={id:"bad",assetId:"source",name:"Bad speed",sourceRange:{start:rational(0,24),duration:rational(24,24)},timelineStart:rational(0,24),duration:rational(24,24),enabled:true};
 for(const speed of [0,0.1,4.1,Number.NaN,Number.POSITIVE_INFINITY]){
  const candidate={...withTrack,tracks:withTrack.tracks.map(track=>({...track,clips:[{...base,speed}]}))};
  assert.equal(validateTimeline(candidate).issues.some(issue=>issue.code==="invalid_speed"),true);
 }
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
