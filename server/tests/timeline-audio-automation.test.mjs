import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline, addTrack, addClip, trimClip, splitClip, rational, seconds, validateTimeline, evaluateTimelineAtFrame } from "../../src/core/timeline.ts";
import { audioAutomationPointFromGraphPosition, buildDialogueDuckingAutomation, mapSourceActivityToTimelineRanges, parseAudioAutomationEditorInput } from "../../src/core/audio-automation.ts";

test("audio automation editor parser accepts valid keyframes and normalizes ordering",()=>{
 const points=parseAudioAutomationEditorInput('[{"timeSeconds":2,"gainDb":-12},{"timeSeconds":0,"pan":-0.5}]',3);
 assert.deepEqual(points.map(point=>point.timeSeconds),[0,2]);
 assert.equal(points[0].pan,-0.5);
 assert.equal(points[1].gainDb,-12);
});
test("audio automation editor parser rejects malformed JSON, invalid arrays and out-of-range points",()=>{
 assert.throws(()=>parseAudioAutomationEditorInput("{",3),/valid JSON/);
 assert.throws(()=>parseAudioAutomationEditorInput('{"timeSeconds":0,"gainDb":0}',3),/JSON array/);
 assert.throws(()=>parseAudioAutomationEditorInput('[{"timeSeconds":4,"gainDb":0}]',3),/clip duration/);
 assert.throws(()=>parseAudioAutomationEditorInput('[{"timeSeconds":1,"gainDb":0},{"timeSeconds":1,"pan":0}]',3),/unique/);
});
test("visual audio curve graph maps normalized coordinates into bounded clip keyframes",()=>{
 const point=audioAutomationPointFromGraphPosition(0.5,0.5,10,-0.25);
 assert.equal(point.timeSeconds,5);
 assert.equal(point.gainDb,-18);
 assert.equal(point.pan,-0.25);
 assert.equal(point.interpolation,"linear");
});
test("visual audio curve graph clamps pointer coordinates and rejects invalid clip duration",()=>{
 const point=audioAutomationPointFromGraphPosition(2,-1,8,4);
 assert.equal(point.timeSeconds,8);
 assert.equal(point.gainDb,24);
 assert.equal(point.pan,1);
 assert.throws(()=>audioAutomationPointFromGraphPosition(0,0,0),/duration/);
});
test("dialogue ducking creates attack, hold and release keyframes on the music clip",()=>{
 const points=buildDialogueDuckingAutomation({musicStartSeconds:0,musicDurationSeconds:8,baseGainDb:-3,duckingDb:-12,attackMs:100,releaseMs:300,dialogueRanges:[{startSeconds:1,endSeconds:3}]});
 assert.deepEqual(points.map(p=>[p.timeSeconds,p.gainDb]),[[1,-3],[1.1,-15],[3,-15],[3.3,-3]]);
});
test("dialogue ducking applies the configured attack when activity starts at the music clip boundary",()=>{
 const points=buildDialogueDuckingAutomation({musicStartSeconds:0,musicDurationSeconds:4,duckingDb:-12,attackMs:100,releaseMs:200,dialogueRanges:[{startSeconds:0,endSeconds:1}]});
 assert.deepEqual(points.map(p=>[p.timeSeconds,p.gainDb]),[[0,0],[0.1,-12],[1,-12],[1.2,0]]);
});
test("dialogue ducking remains immediate at the music clip boundary when attack is disabled",()=>{
 const points=buildDialogueDuckingAutomation({musicStartSeconds:0,musicDurationSeconds:4,duckingDb:-12,attackMs:0,releaseMs:200,dialogueRanges:[{startSeconds:0,endSeconds:1}]});
 assert.deepEqual(points.map(p=>[p.timeSeconds,p.gainDb]),[[0,-12],[1,-12],[1.2,0]]);
});
test("dialogue already active before music starts is ducked immediately without a new attack",()=>{
 const points=buildDialogueDuckingAutomation({musicStartSeconds:2,musicDurationSeconds:5,duckingDb:-10,attackMs:100,releaseMs:250,dialogueRanges:[{startSeconds:1,endSeconds:3}]});
 assert.deepEqual(points.map(p=>[p.timeSeconds,p.gainDb]),[[0,-10],[1,-10],[1.25,0]]);
});
test("dialogue ducking clips ranges to music boundaries and merges overlapping dialogue ranges",()=>{
 const points=buildDialogueDuckingAutomation({musicStartSeconds:2,musicDurationSeconds:5,duckingDb:-10,attackMs:100,releaseMs:250,dialogueRanges:[{startSeconds:1,endSeconds:3},{startSeconds:3.1,endSeconds:4},{startSeconds:6.5,endSeconds:8}]});
 assert.deepEqual(points.map(p=>[p.timeSeconds,p.gainDb]),[[0,-10],[2,-10],[2.25,0],[4.5,0],[4.6,-10],[5,-10]]);
});
test("dialogue ducking preserves pan keyframes while replacing gain automation",()=>{
 const points=buildDialogueDuckingAutomation({musicStartSeconds:0,musicDurationSeconds:4,dialogueRanges:[{startSeconds:1,endSeconds:2}],existing:[{timeSeconds:.5,pan:-.5},{timeSeconds:1.5,gainDb:-4,pan:.5}]});
 assert.equal(points.find(p=>p.timeSeconds===.5)?.pan,-.5);
 assert.equal(points.find(p=>p.timeSeconds===1.5)?.pan,.5);
 assert.equal(points.some(p=>p.gainDb===-4),false);
});
test("dialogue ducking rejects invalid timeline ranges and bounds reduction settings",()=>{
 assert.throws(()=>buildDialogueDuckingAutomation({musicStartSeconds:0,musicDurationSeconds:4,dialogueRanges:[{startSeconds:2,endSeconds:1}]}),/positive timeline intervals/);
 const points=buildDialogueDuckingAutomation({musicStartSeconds:0,musicDurationSeconds:4,duckingDb:-99,dialogueRanges:[{startSeconds:1,endSeconds:2}]});
 assert.ok(points.some(p=>p.gainDb===-36));
});

test("maps analyzed source activity through trimmed constant-speed dialogue clips",()=>{
 const ranges=mapSourceActivityToTimelineRanges([
  {startSeconds:0,endSeconds:2},
  {startSeconds:3,endSeconds:7},
  {startSeconds:10,endSeconds:12}
 ],{sourceStartSeconds:2,sourceDurationSeconds:10,timelineStartSeconds:10,timelineDurationSeconds:5,speed:2});
 assert.deepEqual(ranges,[{startSeconds:10.5,endSeconds:12.5},{startSeconds:14,endSeconds:15}]);
});
test("maps analyzed source activity through variable-speed dialogue clips",()=>{
 const ranges=mapSourceActivityToTimelineRanges([{startSeconds:1.25,endSeconds:3}],{
  sourceStartSeconds:0,sourceDurationSeconds:6,timelineStartSeconds:4,timelineDurationSeconds:4,speed:1,
  speedCurve:[{timeSeconds:0,speed:1},{timeSeconds:2,speed:2},{timeSeconds:4,speed:1}]
 });
 assert.ok(Math.abs(ranges[0].startSeconds-5)<1e-6);
 assert.ok(Math.abs(ranges[0].endSeconds-6)<1e-5);
});
test("source activity mapping rejects malformed intervals, timebases and inconsistent retiming",()=>{
 assert.throws(()=>mapSourceActivityToTimelineRanges([{startSeconds:2,endSeconds:1}],{sourceStartSeconds:0,sourceDurationSeconds:4,timelineStartSeconds:0,timelineDurationSeconds:4}),/positive source-time ranges/);
 assert.throws(()=>mapSourceActivityToTimelineRanges([],{sourceStartSeconds:0,sourceDurationSeconds:4,timelineStartSeconds:0,timelineDurationSeconds:4,speed:5}),/timing is invalid/);
 assert.throws(()=>mapSourceActivityToTimelineRanges([],{sourceStartSeconds:0,sourceDurationSeconds:4,timelineStartSeconds:0,timelineDurationSeconds:2,speed:1}),/do not match/);
});
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
 assert.equal(seconds(trimmed.sourceRange.duration),16);
 const [first,second]=splitClip(added,"video","mixed",120,"mixed-b").tracks[0].clips;
 assert.equal(seconds(first.sourceRange.duration),10);
 assert.equal(seconds(second.sourceRange.start),11);
 assert.equal(seconds(second.sourceRange.duration),10);
});

test("timeline validation permits optical-flow interpolation only on video at supported multipliers",()=>{
 let timeline=createTimeline("project","motion-interpolation","Motion interpolation",{numerator:24,denominator:1});
 timeline=addTrack(timeline,{id:"video",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});
 timeline=addClip(timeline,"video",{id:"clip",assetId:"asset",name:"Slow motion",sourceRange:{start:rational(0,24),duration:rational(48,24)},timelineStart:rational(0,24),duration:rational(48,24),enabled:true,metadata:{motionInterpolationMultiplier:2}});
 assert.equal(validateTimeline(timeline).valid,true);
 const invalidMultiplier={...timeline,tracks:timeline.tracks.map(track=>({...track,clips:track.clips.map(clip=>({...clip,metadata:{motionInterpolationMultiplier:3}}))}))};
 assert.equal(validateTimeline(invalidMultiplier).issues.some(issue=>issue.code==="invalid_motion_interpolation"),true);
 const invalidTrack={...timeline,tracks:timeline.tracks.map(track=>({...track,kind:"audio"}))};
 assert.equal(validateTimeline(invalidTrack).issues.some(issue=>issue.code==="invalid_motion_interpolation"),true);
});

test("variable-speed curves interpolate and integrate source time deterministically",()=>{
 const timeline=createTimeline("project","speed-curve","Speed curve",{numerator:24,denominator:1});
 const withTrack=addTrack(timeline,{id:"video",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});
 const curve=[{timeSeconds:0,speed:1},{timeSeconds:2,speed:2},{timeSeconds:4,speed:1}];
 const clip={id:"ramp",assetId:"source",name:"Ramp",sourceRange:{start:rational(0,24),duration:rational(144,24)},timelineStart:rational(0,24),duration:rational(96,24),enabled:true,speed:1,speedCurve:curve};
 const added=addClip(withTrack,"video",clip);
 assert.equal(validateTimeline(added).valid,true);
 assert.equal(evaluateTimelineAtFrame(added,24).activeClips[0].sourceTimeSeconds,1.25);
 assert.equal(evaluateTimelineAtFrame(added,48).activeClips[0].sourceTimeSeconds,3);
 assert.equal(evaluateTimelineAtFrame(added,72).activeClips[0].sourceTimeSeconds,4.75);
 assert.equal(evaluateTimelineAtFrame(added,72).activeClips[0].playbackSpeed,1.5);
});

test("variable-speed trim and split preserve integrated source intervals and rebase keyframes",()=>{
 const timeline=createTimeline("project","speed-curve-edit","Speed curve edit",{numerator:24,denominator:1});
 const withTrack=addTrack(timeline,{id:"video",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});
 const curve=[{timeSeconds:0,speed:1},{timeSeconds:2,speed:2},{timeSeconds:4,speed:1}];
 const clip={id:"ramp",assetId:"source",name:"Ramp",sourceRange:{start:rational(0,24),duration:rational(144,24)},timelineStart:rational(0,24),duration:rational(96,24),enabled:true,speed:1,speedCurve:curve};
 const added=addClip(withTrack,"video",clip);
 const trimmed=trimClip(added,"video","ramp",24,0).tracks[0].clips[0];
 assert.equal(seconds(trimmed.sourceRange.start),1.25);
 assert.equal(seconds(trimmed.sourceRange.duration),4.75);
 assert.equal(trimmed.speedCurve[0].timeSeconds,0);
 assert.equal(trimmed.speedCurve.at(-1).timeSeconds,3);
 const [first,second]=splitClip(added,"video","ramp",48,"ramp-b").tracks[0].clips;
 assert.equal(seconds(first.sourceRange.duration),3);
 assert.equal(seconds(second.sourceRange.start),3);
 assert.equal(seconds(second.sourceRange.duration),3);
 assert.equal(second.speedCurve[0].speed,2);
 assert.equal(second.speedCurve.at(-1).timeSeconds,2);
});

test("timeline validation rejects malformed variable-speed curves",()=>{
 const timeline=createTimeline("project","speed-curve-invalid","Invalid speed curve",{numerator:24,denominator:1});
 const withTrack=addTrack(timeline,{id:"video",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});
 const base={id:"bad-curve",assetId:"source",name:"Bad curve",sourceRange:{start:rational(0,24),duration:rational(48,24)},timelineStart:rational(0,24),duration:rational(48,24),enabled:true,speed:1};
 const invalidCurves=[
  [{timeSeconds:1,speed:1},{timeSeconds:2,speed:1}],
  [{timeSeconds:0,speed:1},{timeSeconds:1,speed:5}],
  [{timeSeconds:0,speed:1},{timeSeconds:0,speed:2}],
  [{timeSeconds:0,speed:1},{timeSeconds:3,speed:2}]
 ];
 for(const speedCurve of invalidCurves){
  const candidate={...withTrack,tracks:withTrack.tracks.map(track=>({...track,clips:[{...base,speedCurve}]}))};
  assert.equal(validateTimeline(candidate).issues.some(issue=>issue.code==="invalid_speed_curve"||issue.code==="timebase_mismatch"),true);
 }
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
