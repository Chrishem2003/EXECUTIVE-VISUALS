import assert from "node:assert/strict";
import { createStoryboardTimeline, reflowStoryboardTimelinePlan, getStoryboardShotAssetAttachments, attachStoryboardShotAsset } from "../src/core/storyboard-timeline.ts";
import { addClip, createGeneratedVideoClip, rational, validateTimeline } from "../src/core/timeline.ts";
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

const pendingAttachments=getStoryboardShotAssetAttachments(timeline,plan,[]);
assert.equal(pendingAttachments.get("shot-1").status,"pending");
const manuallyAttached=attachStoryboardShotAsset(timeline,plan,"shot-1",{
 clipId:"manual-shot-1",assetId:"private-library-video-1",name:"Workshop take 01.mp4",
 mediaType:"video/mp4",sourceDurationSeconds:12
});
const manualClip=manuallyAttached.tracks.find(track=>track.id===plan.trackIds.picture).clips[0];
assert.equal(manualClip.timelineStart.value,0);
assert.equal(manualClip.duration.value,300);
assert.equal(manualClip.metadata.storyboardShotId,"shot-1");
assert.equal(manualClip.metadata.source,"storyboard-asset-attachment");
assert.equal(getStoryboardShotAssetAttachments(manuallyAttached,plan,["private-library-video-1"]).get("shot-1").status,"attached");
assert.throws(()=>attachStoryboardShotAsset(timeline,plan,"shot-1",{
 clipId:"short-source",assetId:"short-video",name:"Short.mp4",mediaType:"video/mp4",sourceDurationSeconds:2
}),/shorter than the planned shot/);
assert.throws(()=>attachStoryboardShotAsset(timeline,plan,"shot-1",{
 clipId:"wrong-media",assetId:"image-1",name:"Still.png",mediaType:"image/png",sourceDurationSeconds:20
}),/video assets only/);
assert.throws(()=>attachStoryboardShotAsset(manuallyAttached,plan,"shot-1",{
 clipId:"duplicate-attachment",assetId:"another-video",name:"Another.mp4",mediaType:"video/mp4",sourceDurationSeconds:20
}),/already has a linked clip/);
const lockedPicture={...timeline,tracks:timeline.tracks.map(track=>track.id===plan.trackIds.picture?{...track,locked:true}:track)};
assert.throws(()=>attachStoryboardShotAsset(lockedPicture,plan,"shot-1",{
 clipId:"locked-attachment",assetId:"video-2",name:"Video.mp4",mediaType:"video/mp4",sourceDurationSeconds:20
}),/Unlock and enable/);
const stalePlan={...plan,sourceInputHash:"b".repeat(64)};
assert.throws(()=>attachStoryboardShotAsset(timeline,stalePlan,"shot-1",{
 clipId:"stale-attachment",assetId:"video-3",name:"Video.mp4",mediaType:"video/mp4",sourceDurationSeconds:20
}),/does not belong to the current timeline/);
const approvedClip=createGeneratedVideoClip({
 id:"approved-shot-1",assetId:"private-asset-1",name:"Approved shot one.mp4",durationSeconds:10,
 frameRate:timeline.frameRate,startFrame:plan.scenes[0].shots[0].startFrame,
 metadata:{storyboardShotId:"shot-1",approvalId:"approval-1",source:"model-storyboard"}
});
const attachedTimeline=addClip(timeline,plan.trackIds.picture,approvedClip);
const attached=getStoryboardShotAssetAttachments(attachedTimeline,plan,["private-asset-1"]);
assert.deepEqual(attached.get("shot-1"),{status:"attached",clipId:"approved-shot-1",assetId:"private-asset-1",clipName:"Approved shot one.mp4"});
assert.equal(attached.get("shot-2").status,"pending");
assert.equal(getStoryboardShotAssetAttachments(attachedTimeline,plan,[]).get("shot-1").status,"unavailable");
const pictureIndex=attachedTimeline.tracks.findIndex(track=>track.id===plan.trackIds.picture);
const duplicateClip={...approvedClip,id:"duplicate-shot-1",assetId:"private-asset-2",name:"Duplicate take.mp4"};
const duplicateTimeline={...attachedTimeline,tracks:attachedTimeline.tracks.map((track,index)=>index===pictureIndex?{...track,clips:[...track.clips,duplicateClip]}:track)};
assert.equal(getStoryboardShotAssetAttachments(duplicateTimeline,plan,["private-asset-1","private-asset-2"]).get("shot-1").status,"ambiguous");
const wrongTrackTimeline={...attachedTimeline,tracks:attachedTimeline.tracks.map(track=>track.id===plan.trackIds.picture?{...track,clips:[]}:track)};
assert.equal(getStoryboardShotAssetAttachments(wrongTrackTimeline,plan,["private-asset-1"]).get("shot-1").status,"pending");


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
