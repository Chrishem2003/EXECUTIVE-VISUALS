import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline, addTrack, addClip, trimClip, splitClip, validateTimeline, rational, seconds } from "../../src/core/timeline.ts";

function fixture(){
 let timeline=createTimeline("project","timeline","Speed edit",{numerator:24,denominator:1});
 timeline=addTrack(timeline,{id:"video",name:"Picture",kind:"video",enabled:true,locked:false,clips:[]});
 return timeline;
}
function clip(speed=2){
 return {id:"clip",assetId:"asset",name:"Source",sourceRange:{start:rational(48,24),duration:rational(96,24)},timelineStart:rational(0,24),duration:rational(48,24),enabled:true,speed};
}

test("speed-aware clips validate against source duration multiplied by speed",()=>{
 const timeline=addClip(fixture(),"video",clip(2));
 assert.equal(validateTimeline(timeline).valid,true);
 assert.equal(seconds(timeline.tracks[0].clips[0].sourceRange.duration),4);
 assert.throws(()=>addClip(fixture(),"video",{...clip(2),sourceRange:{start:rational(0,24),duration:rational(48,24)}}),/Source duration must equal/);
 assert.equal(validateTimeline({...timeline,tracks:[{...timeline.tracks[0],clips:[{...clip(5)}]}]}).valid,false);
});

test("trim preserves playback speed and advances source in-points at source-frame rate",()=>{
 const trimmed=trimClip(addClip(fixture(),"video",clip(2)),"video","clip",12,12);
 const result=trimmed.tracks[0].clips[0];
 assert.equal(result.speed,2);
 assert.equal(seconds(result.timelineStart),0.5);
 assert.equal(seconds(result.duration),1);
 assert.equal(seconds(result.sourceRange.start),3);
 assert.equal(seconds(result.sourceRange.duration),2);
});

test("split preserves playback speed and partitions the source range at the matching source time",()=>{
 const split=splitClip(addClip(fixture(),"video",clip(2)),"video","clip",24,"clip-b");
 const [first,second]=split.tracks[0].clips;
 assert.equal(first.speed,2);
 assert.equal(second.speed,2);
 assert.equal(seconds(first.duration),1);
 assert.equal(seconds(first.sourceRange.duration),2);
 assert.equal(seconds(second.timelineStart),1);
 assert.equal(seconds(second.sourceRange.start),4);
 assert.equal(seconds(second.sourceRange.duration),2);
});
