import test from "node:test";
import assert from "node:assert/strict";
import { addClip, addTrack, createTimeline, rational, removeClip, seconds, snapTimelineFrame } from "../../src/core/timeline.ts";

function fixture(locked=false){
 let timeline=createTimeline("project","sequence","Edit test",{numerator:24,denominator:1});
 timeline=addTrack(timeline,{id:"v1",name:"Video 1",kind:"video",enabled:true,locked,clips:[]});
 const make=(id,start,duration)=>({id,assetId:"asset-"+id,name:id,sourceRange:{start:rational(0,24),duration:rational(duration,24)},timelineStart:rational(start,24),duration:rational(duration,24),enabled:true});
 timeline=addClip(timeline,"v1",make("a",0,24));
 timeline=addClip(timeline,"v1",make("b",36,24));
 timeline=addClip(timeline,"v1",make("c",72,24));
 return timeline;
}

test("ripple delete removes selected clip and closes only its following gap",()=>{
 const before=fixture();
 const after=removeClip(before,"v1","b",true);
 const clips=after.tracks[0].clips;
 assert.deepEqual(clips.map(c=>c.id),["a","c"]);
 assert.equal(seconds(clips[1].timelineStart),48/24);
 assert.equal(after.revision,before.revision+1);
 assert.equal(seconds(before.tracks[0].clips[2].timelineStart),72/24,"input timeline remains immutable");
});

test("ordinary delete preserves following clip positions",()=>{
 const after=removeClip(fixture(),"v1","b",false);
 assert.equal(seconds(after.tracks[0].clips[1].timelineStart),72/24);
});

test("ripple delete never shifts clips on another track",()=>{
 let timeline=fixture();
 timeline=addTrack(timeline,{id:"a1",name:"Audio",kind:"audio",enabled:true,locked:false,clips:[]});
 timeline=addClip(timeline,"a1",{id:"music",assetId:"music",name:"Music",sourceRange:{start:rational(0,24),duration:rational(120,24)},timelineStart:rational(72,24),duration:rational(120,24),enabled:true});
 const after=removeClip(timeline,"v1","b",true);
 assert.equal(seconds(after.tracks[1].clips[0].timelineStart),72/24);
});

test("ripple delete rejects locked tracks and unknown clips",()=>{
 assert.throws(()=>removeClip(fixture(true),"v1","b",true),/locked/i);
 assert.throws(()=>removeClip(fixture(),"v1","missing",true),/not found/i);
});

test("snaps clip placement to nearby edit boundaries but not distant ones",()=>{
 const timeline=fixture();
 assert.deepEqual(snapTimelineFrame(29,timeline,"v1",6),{frame:24,snappedTo:24});
 assert.deepEqual(snapTimelineFrame(55,timeline,"v1",6),{frame:60,snappedTo:60});
 assert.deepEqual(snapTimelineFrame(55,timeline,"v1",4),{frame:55,snappedTo:null});
});
test("snaps across tracks and ignores the clip being repositioned",()=>{
 const timeline=fixture();
 assert.deepEqual(snapTimelineFrame(31,timeline,"a1",6,"a"),{frame:36,snappedTo:36});
});
test("rejects invalid snap parameters",()=>{
 assert.throws(()=>snapTimelineFrame(-1,fixture(),"v1"),/non-negative/);
 assert.throws(()=>snapTimelineFrame(10,fixture(),"v1",-1),/non-negative/);
});
