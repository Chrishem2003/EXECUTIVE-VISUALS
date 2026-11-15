import test from "node:test";
import assert from "node:assert/strict";
import {addClip,addTrack,createGeneratedVideoClip,createTimeline} from "../../src/core/timeline.ts";
import {analyzeTranscriptPauses,createTranscriptPaperEditTrack,parseTranscriptWebVtt} from "../../src/core/transcript-paper-edit.ts";

const vtt=`WEBVTT

intro
00:00:00.000 --> 00:00:02.000
The first selected idea.

00:00:04.000 --> 00:00:06.000
The second selected idea.
`;
function sourceTimeline(){
 let timeline=createTimeline("project-1","timeline-1","Interview",{numerator:24,denominator:1});
 timeline=addTrack(timeline,{id:"video-1",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});
 const clip=createGeneratedVideoClip({id:"source-clip",assetId:"video-asset",name:"Interview.mp4",durationSeconds:10,frameRate:timeline.frameRate});
 timeline=addClip(timeline,"video-1",clip);
 return timeline;
}

test("parses WebVTT cues with optional identifiers and millisecond timestamps",()=>{
 const cues=parseTranscriptWebVtt(vtt);
 assert.deepEqual(cues.map(cue=>({index:cue.index,start:cue.start,end:cue.end,text:cue.text})),[
  {index:0,start:0,end:2,text:"The first selected idea."},
  {index:1,start:4,end:6,text:"The second selected idea."}
 ]);
});

test("preserves WebVTT voice speaker labels while stripping voice markup from dialogue",()=>{
 const cues=parseTranscriptWebVtt("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<v Alex Morgan>Hello there.</v>\n\n00:00:02.000 --> 00:00:04.000\n<v Jamie>Welcome back.</v>\n\n00:00:04.000 --> 00:00:05.000\nNo speaker label.\n");
 assert.deepEqual(cues.map(cue=>({speaker:cue.speaker,text:cue.text})),[
  {speaker:"Alex Morgan",text:"Hello there."},
  {speaker:"Jamie",text:"Welcome back."},
  {speaker:undefined,text:"No speaker label."}
 ]);
});

test("detects only gaps at or above the requested pause threshold",()=>{
 const cues=parseTranscriptWebVtt("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFirst thought.\n\n00:00:01.500 --> 00:00:02.000\nQuick follow-up.\n\n00:00:04.000 --> 00:00:05.000\nNext topic.\n");
 assert.deepEqual(analyzeTranscriptPauses(cues,0.75),[
  {start:2,end:4,duration:2,afterCueIndex:1,beforeCueIndex:2}
 ]);
 assert.deepEqual(analyzeTranscriptPauses(cues,0.1).map(pause=>pause.duration),[0.5,2]);
});

test("pause analysis validates threshold and safely ignores overlapping cues",()=>{
 const cues=[
  {index:0,start:0,end:2,text:"First"},
  {index:1,start:1.5,end:3,text:"Overlap"},
  {index:2,start:4,end:5,text:"Last"}
 ];
 assert.deepEqual(analyzeTranscriptPauses(cues,0.75),[
  {start:3,end:4,duration:1,afterCueIndex:1,beforeCueIndex:2}
 ]);
 assert.throws(()=>analyzeTranscriptPauses(cues,0),/between 0.1 and 30/);
 assert.throws(()=>analyzeTranscriptPauses(cues,31),/between 0.1 and 30/);
});

test("rejects malformed, empty and oversized transcript inputs",()=>{
 assert.throws(()=>parseTranscriptWebVtt("not a transcript"),/valid WebVTT/);
 assert.throws(()=>parseTranscriptWebVtt("WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nBad timing"),/invalid timing/);
 assert.throws(()=>parseTranscriptWebVtt("WEBVTT\n\nNOTE no cues"),/no usable cues/);
 assert.throws(()=>parseTranscriptWebVtt("WEBVTT\n"+"x".repeat(2*1024*1024+10)),/2 MiB/);
});

test("builds a non-destructive paper edit track from selected transcript cues",()=>{
 const timeline=sourceTimeline(),cues=parseTranscriptWebVtt(vtt);
 const next=createTranscriptPaperEditTrack(timeline,{
  sourceTrackId:"video-1",sourceClipId:"source-clip",newTrackId:"paper-edit",
  clipIdPrefix:"paper",startFrame:240,selectedCueIndices:[0,1],cues
 });
 const original=next.tracks.find(track=>track.id==="video-1");
 const paper=next.tracks.find(track=>track.id==="paper-edit");
 assert.equal(original.clips.length,1);
 assert.equal(paper.kind,"video");
 assert.equal(paper.clips.length,2);
 assert.deepEqual(paper.clips.map(clip=>clip.timelineStart.value),[240,288]);
 assert.deepEqual(paper.clips.map(clip=>clip.sourceRange.start.value),[0,96]);
 assert.equal(paper.clips[0].assetId,"video-asset");
 assert.equal(paper.clips[1].metadata.transcriptText,"The second selected idea.");
});

test("only requested transcript cues are assembled and source-range violations are rejected",()=>{
 const timeline=sourceTimeline(),cues=parseTranscriptWebVtt(vtt);
 const next=createTranscriptPaperEditTrack(timeline,{
  sourceTrackId:"video-1",sourceClipId:"source-clip",newTrackId:"paper-only",
  clipIdPrefix:"only",startFrame:240,selectedCueIndices:[1],cues
 });
 assert.equal(next.tracks.find(track=>track.id==="paper-only").clips.length,1);
 assert.throws(()=>createTranscriptPaperEditTrack(timeline,{
  sourceTrackId:"video-1",sourceClipId:"source-clip",newTrackId:"paper-out",
  clipIdPrefix:"out",startFrame:240,cues:[{index:9,start:11,end:12,text:"Outside source"}]
 }),/outside the selected source clip/);
});

test("rejects variable-speed source clips until transcript time mapping is exact",()=>{
 const timeline=sourceTimeline();
 timeline.tracks[0].clips[0].speedCurve=[{timeSeconds:0,speed:1},{timeSeconds:10,speed:2}];
 assert.throws(()=>createTranscriptPaperEditTrack(timeline,{
  sourceTrackId:"video-1",sourceClipId:"source-clip",newTrackId:"paper-speed",
  clipIdPrefix:"speed",startFrame:240,cues:parseTranscriptWebVtt(vtt)
 }),/constant-speed/);
});
