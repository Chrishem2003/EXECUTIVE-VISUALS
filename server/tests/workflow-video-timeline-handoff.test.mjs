import test from "node:test";
import assert from "node:assert/strict";
import { createGeneratedVideoClip, validateTimeline, createTimeline, addTrack, addClip, insertWorkflowCaptionAsset } from "../../src/core/timeline.ts";

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

test("workflow WebVTT caption asset inserts into an available caption lane at the requested playhead",()=>{
 const base=createTimeline("project-1","timeline-1","Caption edit",{numerator:24,denominator:1});
 const withVideo=addTrack(base,{id:"video",name:"Video 1",kind:"video",enabled:true,locked:false,clips:[]});
 const withCaptions=addTrack(withVideo,{id:"captions",name:"Captions",kind:"caption",enabled:true,locked:false,clips:[]});
 const next=insertWorkflowCaptionAsset(withCaptions,{id:"caption-clip",trackId:"captions",assetId:"vtt-asset",name:"captions-en.vtt",mediaType:"text/vtt",durationSeconds:12.1,startSeconds:4,newTrackId:"unused"});
 const track=next.tracks.find(item=>item.id==="captions");
 assert.equal(track.clips.length,1);
 assert.equal(track.clips[0].timelineStart.value,96);
 assert.equal(track.clips[0].duration.value,291);
 assert.equal(track.clips[0].assetId,"vtt-asset");
 assert.equal(track.clips[0].metadata.captionFormat,"webvtt");
 assert.equal(validateTimeline(next).valid,true);
});

test("workflow WebVTT caption insertion creates a separate lane when existing caption lanes are locked or overlap",()=>{
 const base=createTimeline("project-1","timeline-1","Caption edit",{numerator:30,denominator:1});
 const withTrack=addTrack(base,{id:"locked-captions",name:"Captions",kind:"caption",enabled:true,locked:true,clips:[]});
 const occupied=addTrack(withTrack,{id:"occupied",name:"Captions 2",kind:"caption",enabled:true,locked:false,clips:[]});
 const first=addClip(occupied,"occupied",{id:"existing",assetId:"existing-vtt",name:"existing.vtt",sourceRange:{start:{value:0,rate:30},duration:{value:300,rate:30}},timelineStart:{value:0,rate:30},duration:{value:300,rate:30},enabled:true});
 const next=insertWorkflowCaptionAsset(first,{id:"new-caption",trackId:"",assetId:"new-vtt",name:"new.vtt",mediaType:"text/vtt",durationSeconds:10,startSeconds:0,newTrackId:"new-track"});
 assert.equal(next.tracks.length,4);
 assert.equal(next.tracks[3].name,"Captions 3");
 assert.equal(next.tracks[3].clips[0].assetId,"new-vtt");
 assert.equal(validateTimeline(next).valid,true);
});

test("workflow WebVTT caption insertion rejects unsafe formats, missing identity and invalid duration",()=>{
 const base=createTimeline("project-1","timeline-1","Caption edit");
 const common={id:"clip",trackId:"",assetId:"asset",name:"captions.vtt",mediaType:"text/vtt",durationSeconds:5,newTrackId:"track"};
 assert.throws(()=>insertWorkflowCaptionAsset(base,{...common,mediaType:"text/plain"}),/WebVTT/i);
 assert.throws(()=>insertWorkflowCaptionAsset(base,{...common,name:"captions.mp4"}),/WebVTT/i);
 assert.throws(()=>insertWorkflowCaptionAsset(base,{...common,id:""}),/clip ID/i);
 assert.throws(()=>insertWorkflowCaptionAsset(base,{...common,durationSeconds:0}),/duration/i);
 assert.throws(()=>insertWorkflowCaptionAsset(base,{...common,startSeconds:-1}),/timeline start/i);
});
