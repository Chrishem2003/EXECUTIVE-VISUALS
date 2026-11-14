import assert from "node:assert/strict";
import { createStoryboardTimeline, reflowStoryboardTimelinePlan } from "../src/core/storyboard-timeline.ts";
import { rational, validateTimeline } from "../src/core/timeline.ts";
import { applyTimelineHistoryOperation, createTimelineHistory, createTimelineHistoryOperation, recordTimelineHistory, redoTimelineHistory, undoTimelineHistory } from "../src/core/timeline-history-operations.ts";

const shot=(id,durationSeconds,number=1)=>({
 id,number,durationSeconds,shotType:"Detail",framing:"Close-up",angle:"Eye level",movement:"Slow push",lens:"50mm",
 action:"Show the process clearly.",dialogue:"",narration:"",visualPrompt:"A provider-neutral still prompt.",motionPrompt:"A provider-neutral motion prompt.",
 negativePrompt:"No invented claims.",lighting:"Soft daylight",soundCue:"Workshop ambience",continuityIn:"Match previous frame.",
 continuityOut:"Hold on the result.",proofReference:"Verify demonstration before publishing.",transitionOut:"cut",
 characterRefs:[{name:"Ada",characterId:"character-ada",role:"Engineer",action:"Demonstrates the process",continuityNotes:"Same wardrobe"}]
});
const storyboard={
 id:"storyboard-001",schemaVersion:1,source:"model",model:"local-model",generatedAt:"2026-11-05T00:00:00.000Z",
 inputHash:"a".repeat(64),title:"Community energy workshop",logline:"A verifiable process story.",
 targetDurationSeconds:30,durationSeconds:30,aspectRatio:"9:16",frameRate:30,
 globalContinuityRules:["Keep workshop layout consistent","Preserve product geometry","Maintain screen direction"],
 characterSuggestions:[],
 scenes:[
  {id:"scene-1",number:1,title:"The problem",slugline:"INT. WORKSHOP - DAY",purpose:"Establish the challenge.",storyBeat:"Problem",location:"Workshop",timeOfDay:"Day",durationSeconds:15,shots:[shot("shot-1",10,1),shot("shot-2",5,2)]},
  {id:"scene-2",number:2,title:"The proof",slugline:"INT. WORKSHOP - LATER",purpose:"Show a verifiable result.",storyBeat:"Proof",location:"Inspection bench",timeOfDay:"Day",durationSeconds:15,shots:[shot("shot-3",15,1)]}
 ]
};

const timeline=createStoryboardTimeline("cloud-project-1","timeline-1",storyboard);
assert.equal(timeline.projectId,"cloud-project-1");
assert.equal(timeline.frameRate.numerator,30);
assert.equal(timeline.width,1080);
assert.equal(timeline.height,1920);
assert.equal(timeline.tracks.length,3);
assert.deepEqual(timeline.tracks.map(track=>track.kind),["video","audio","caption"]);
assert.ok(timeline.tracks.every(track=>track.clips.length===0),"planned storyboard segments must not masquerade as media clips");
assert.equal(timeline.markers.length,2);
assert.deepEqual(timeline.markers.map(marker=>marker.start.value),[0,450]);
assert.equal(validateTimeline(timeline).valid,true);

const plan=timeline.metadata.storyboardPlan;
assert.equal(plan.sourceStoryboardId,storyboard.id);
assert.equal(plan.sourceInputHash,storyboard.inputHash);
assert.equal(plan.totalFrames,900);
assert.deepEqual(plan.scenes.flatMap(scene=>scene.shots).map(shot=>shot.startFrame),[0,300,450]);
assert.equal(plan.scenes[0].shots[0].visualPrompt,"A provider-neutral still prompt.");
assert.equal(plan.scenes[0].shots[0].assetId,null);
assert.equal(plan.scenes[0].shots[0].status,"planned");

const changed={...plan,scenes:plan.scenes.map((scene,index)=>index===0?{...scene,shots:scene.shots.map((item,shotIndex)=>shotIndex===0?{...item,durationFrames:240}:item)}:scene)};
const reflowed=reflowStoryboardTimelinePlan(changed);
assert.deepEqual(reflowed.scenes.flatMap(scene=>scene.shots).map(shot=>shot.startFrame),[0,240,390]);
assert.equal(reflowed.totalFrames,840);
assert.equal(reflowed.scenes[0].durationFrames,390);
assert.equal(reflowed.scenes[0].shots[0].durationSeconds,8);
assert.equal(reflowed.durationSeconds,28);
const afterTimeline={
  ...timeline,
  metadata:{...timeline.metadata,storyboardPlan:reflowed},
  markers:timeline.markers.map(marker=>{
    const scene=reflowed.scenes.find(item=>marker.id==="storyboard-scene-"+item.id);
    return scene?{...marker,start:rational(scene.startFrame,reflowed.frameRate)}:marker;
  })
};
const operation=createTimelineHistoryOperation(timeline,afterTimeline,{label:"Edit planned storyboard shot",origin:"local"});
assert.ok(operation);
const history=recordTimelineHistory(createTimelineHistory(),operation);
const applied=applyTimelineHistoryOperation(timeline,operation,"forward");
assert.equal(applied.metadata.storyboardPlan.totalFrames,840);
assert.deepEqual(applied.markers.map(marker=>marker.start.value),[0,390]);
const undone=undoTimelineHistory(history,applied);
assert.ok(undone);
assert.equal(undone.timeline.metadata.storyboardPlan.totalFrames,900);
assert.deepEqual(undone.timeline.markers.map(marker=>marker.start.value),[0,450]);
const redone=redoTimelineHistory(undone.history,undone.timeline);
assert.ok(redone);
assert.equal(redone.timeline.metadata.storyboardPlan.totalFrames,840);

assert.throws(()=>createStoryboardTimeline("","timeline-2",storyboard),/cloud project/);
assert.throws(()=>createStoryboardTimeline("project","timeline-3",{...storyboard,frameRate:29}),/frame rate/);
assert.throws(()=>createStoryboardTimeline("project","timeline-4",{...storyboard,aspectRatio:"2:1"}),/aspect ratio/);
assert.throws(()=>createStoryboardTimeline("project","timeline-5",{...storyboard,scenes:[storyboard.scenes[0],{...storyboard.scenes[1],shots:[storyboard.scenes[0].shots[0]]}]}),/duplicate shot/);
assert.throws(()=>createStoryboardTimeline("project","timeline-6",{...storyboard,scenes:storyboard.scenes.map((scene,index)=>index===0?{...scene,durationSeconds:14}:scene)}),/scene duration/);
assert.throws(()=>createStoryboardTimeline("project","timeline-7",{...storyboard,scenes:storyboard.scenes.map((scene,index)=>index===1?{...scene,number:1}:scene)}),/out-of-order scene/);
assert.throws(()=>createStoryboardTimeline("project","timeline-8",{...storyboard,durationSeconds:29}),/total runtime/);
const optionalNotes={...storyboard,scenes:storyboard.scenes.map(scene=>({...scene,location:"",timeOfDay:"",shots:scene.shots.map(item=>({...item,characterRefs:[{name:"Ada",characterId:"character-ada",role:"",action:"",continuityNotes:""}]}))}))};
assert.equal(createStoryboardTimeline("project","timeline-9",optionalNotes).metadata.storyboardPlan.scenes.length,2,"optional location and character notes remain valid");
assert.throws(()=>reflowStoryboardTimelinePlan({...plan,trackIds:{...plan.trackIds,picture:""}}),/track lineage/);
assert.throws(()=>reflowStoryboardTimelinePlan({...plan,scenes:plan.scenes.map((scene,index)=>index===1?{...scene,shots:[{...scene.shots[0],id:plan.scenes[0].shots[0].id,sourceShotId:plan.scenes[0].shots[0].id}]}:scene)}),/lineage/);
assert.throws(()=>reflowStoryboardTimelinePlan({...plan,scenes:plan.scenes.map((scene,index)=>index===0?{...scene,shots:scene.shots.map(item=>({...item,assetId:"asset-123"}))}:scene)}),/lineage/);
assert.throws(()=>reflowStoryboardTimelinePlan({...plan,scenes:plan.scenes.map(scene=>({...scene,shots:scene.shots.map(item=>({...item,durationFrames:30*60+1}))}))}),/duration/);


console.log("Storyboard-to-timeline verification passed.");
