import test from "node:test";
import assert from "node:assert/strict";
import { createGeneratedVideoClip, validateTimeline, createTimeline, addTrack, addClip } from "../../src/core/timeline.ts";

test("workflow-generated video clip preserves source duration, frame rate and provenance",()=>{
 const timeline=createTimeline("project-1","timeline-1","Generated sequence",{numerator:24,denominator:1});
 const withTrack=addTrack(timeline,{id:"video-track",name:"Video 1",kind:"video",enabled:true,locked:false,clips:[]});
 const clip=createGeneratedVideoClip({
  id:"clip-1",assetId:"cloud-asset-1",name:"Generated scene.mp4",durationSeconds:5,
  frameRate:withTrack.frameRate,startFrame:48,
  metadata:{workflowRunId:"run-1",provider:"runway",model:"model-router",cloudAssetId:"cloud-asset-1"}
 });
 const next=addClip(withTrack,"video-track",clip);
 assert.equal(next.tracks[0].clips[0].timelineStart.value,48);
 assert.equal(next.tracks[0].clips[0].duration.value,120);
 assert.equal(next.tracks[0].clips[0].sourceRange.duration.value,120);
 assert.equal(next.tracks[0].clips[0].metadata.workflowRunId,"run-1");
 assert.equal(validateTimeline(next).valid,true);
});

test("workflow-generated video clip rejects invalid identity, duration and frame rate",()=>{
 const base={id:"clip",assetId:"asset",name:"clip.mp4",durationSeconds:5,frameRate:{numerator:24,denominator:1}};
 assert.throws(()=>createGeneratedVideoClip({...base,id:""}),/requires an ID/);
 assert.throws(()=>createGeneratedVideoClip({...base,durationSeconds:0}),/duration must be/);
 assert.throws(()=>createGeneratedVideoClip({...base,durationSeconds:3601}),/duration must be/);
 assert.throws(()=>createGeneratedVideoClip({...base,frameRate:{numerator:0,denominator:1}}),/valid timeline frame rate/);
});

test("workflow-generated video clip clamps its insertion frame to zero",()=>{
 const clip=createGeneratedVideoClip({id:"clip",assetId:"asset",name:"clip.mp4",durationSeconds:5,frameRate:{numerator:30,denominator:1},startFrame:-10});
 assert.equal(clip.timelineStart.value,0);
 assert.equal(clip.duration.value,150);
});
