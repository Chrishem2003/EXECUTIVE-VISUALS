import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline, addTrack, addClip, rational } from "../../src/core/timeline.ts";
import { clampTimelineFrame, frameToTimelineSeconds, getTimelinePlaybackFrame, timelineClipMediaTimeSeconds, timelineDurationSeconds, timelineSecondsToFrame } from "../../src/core/timeline-playback.ts";

function fixture(){
 let timeline=createTimeline("project-1","timeline-1","Playback",{numerator:30000,denominator:1001});
 timeline=addTrack(timeline,{id:"v1",name:"Picture 1",kind:"video",enabled:true,locked:false,clips:[]});
 timeline=addTrack(timeline,{id:"v2",name:"Picture 2",kind:"video",enabled:true,locked:false,clips:[]});
 timeline=addTrack(timeline,{id:"a1",name:"Music",kind:"audio",enabled:true,locked:false,clips:[]});
 timeline=addTrack(timeline,{id:"o1",name:"Graphics",kind:"overlay",enabled:true,locked:false,clips:[]});
 timeline=addTrack(timeline,{id:"c1",name:"Captions",kind:"caption",enabled:true,locked:false,clips:[]});
 const add=(trackId,id,start,duration,kindRate=30,sourceIn=0,speed=1)=>{timeline=addClip(timeline,trackId,{id,assetId:"asset-"+id,name:id,sourceRange:{start:rational(sourceIn,kindRate),duration:rational(duration,30)},timelineStart:rational(start,30),duration:rational(duration,30),enabled:true,speed});};
 add("v1","v1-a",0,90,30,30);
 add("v2","v2-a",30,60);
 add("a1","audio-a",0,120);
 add("o1","overlay-a",45,30);
 add("c1","caption-a",0,60);
 return timeline;
}

test("playback frame selects all overlapping enabled picture, audio and overlay clips in track order",()=>{
 const frame=getTimelinePlaybackFrame(fixture(),2);
 assert.deepEqual(frame.active.map(item=>item.clipId),["v1-a","v2-a","audio-a","overlay-a"]);
 assert.equal(frame.activeVideo.length,2);
 assert.equal(frame.activeAudio.length,1);
 assert.equal(frame.activeImages.length,1);
 assert.equal(frame.active.some(item=>item.clipId==="caption-a"),false);
 assert.equal(frame.activeVideo[0].mediaTimeSeconds,3);
 assert.equal(frame.activeVideo[1].mediaTimeSeconds,1);
});

test("playback honors clip source in-points and half-open clip boundaries",()=>{
 const timeline=fixture();
 const atOne=getTimelinePlaybackFrame(timeline,0.9);
 assert.equal(atOne.active.find(item=>item.clipId==="v1-a").mediaTimeSeconds,1.9);
 assert.equal(atOne.active.find(item=>item.clipId==="v2-a"),undefined);
 const atTwo=getTimelinePlaybackFrame(timeline,2);
 assert.equal(atTwo.active.find(item=>item.clipId==="v2-a").mediaTimeSeconds,1);
 const atThree=getTimelinePlaybackFrame(timeline,3);
 assert.equal(atThree.active.some(item=>item.clipId==="v2-a"),false);
 assert.equal(timelineClipMediaTimeSeconds(timeline.tracks[1].clips[0],2),1);
});

test("disabled tracks and clips are excluded from playback",()=>{
 const timeline=fixture();
 timeline.tracks[0].enabled=false;
 timeline.tracks[2].clips[0].enabled=false;
 const frame=getTimelinePlaybackFrame(timeline,1);
 assert.equal(frame.active.some(item=>item.trackId==="v1"),false);
 assert.equal(frame.active.some(item=>item.trackId==="a1"),false);
});

test("rational frame conversion uses sequence frame rate and clamps the playhead",()=>{
 const timeline=fixture();
 assert.ok(Math.abs(frameToTimelineSeconds(30,timeline)-1.001)<1e-12);
 assert.equal(timelineSecondsToFrame(1.001,timeline),30);
 assert.equal(clampTimelineFrame(-5,timeline),0);
 assert.equal(clampTimelineFrame(10000,timeline),120);
 assert.equal(timelineDurationSeconds(timeline),4);
});

test("playback at an empty timeline position yields no active media without negative time",()=>{
 const frame=getTimelinePlaybackFrame(fixture(),-2);
 assert.equal(frame.playheadSeconds,0);
 assert.deepEqual(frame.active.map(item=>item.clipId),["v1-a","audio-a"]);
});
