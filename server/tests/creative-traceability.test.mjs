import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCreativeTraceability, readCreativeTrace } from "../../src/core/creative-traceability.ts";
import { createTimeline, addTrack, addClip, rational } from "../../src/core/timeline.ts";

function fixture(){
 let timeline=createTimeline("project-1","timeline-1");
 timeline=addTrack(timeline,{id:"video-1",name:"Picture",kind:"video",enabled:true,locked:false,clips:[]});
 timeline=addClip(timeline,"video-1",{id:"clip-1",assetId:"asset-1",name:"Opening shot",sourceRange:{start:rational(0,24),duration:rational(48,24)},timelineStart:rational(0,24),duration:rational(48,24),enabled:true});
 return timeline;
}
test("unlinked clips are visible and cannot count as intent coverage",()=>{
 const report=analyzeCreativeTraceability(fixture());
 assert.equal(report.totalClips,1);assert.equal(report.linkedClips,0);assert.equal(report.coveragePercent,0);
 assert.equal(report.readyForDirectorReview,false);assert.equal(report.findings[0].code,"TRACE_MISSING");
});
test("a clip with beat and purpose is anchored to creative intent",()=>{
 const timeline=fixture();timeline.tracks[0].clips[0].metadata={creativeTrace:{storyBeat:"Opening hook",purpose:"Show the problem before explaining it",audiencePromise:"Reveal a practical solution"}};
 const report=analyzeCreativeTraceability(timeline);
 assert.equal(report.linkedClips,1);assert.equal(report.anchoredClips,1);assert.equal(report.coveragePercent,100);
 assert.equal(report.readyForDirectorReview,true);assert.equal(report.findings.length,0);
});
test("partial trace reports exactly which link is missing",()=>{
 const timeline=fixture();timeline.tracks[0].clips[0].metadata={creativeTrace:{storyBeat:"Proof",purpose:"",decisionNote:"Use approved take"}};
 const report=analyzeCreativeTraceability(timeline);
 assert.equal(report.linkedClips,1);assert.equal(report.anchoredClips,0);
 assert.deepEqual(report.findings.map(x=>x.code),["PURPOSE_MISSING"]);
});
test("trace fields are bounded and blank metadata is not treated as a link",()=>{
 const timeline=fixture();timeline.tracks[0].clips[0].metadata={creativeTrace:{storyBeat:"  ",purpose:"",audiencePromise:"",proofReference:"",decisionNote:""}};
 assert.equal(readCreativeTrace(timeline.tracks[0].clips[0]),null);
 timeline.tracks[0].clips[0].metadata={creativeTrace:{storyBeat:"B".repeat(200),purpose:"P".repeat(700)}};
 const trace=readCreativeTrace(timeline.tracks[0].clips[0]);
 assert.equal(trace.storyBeat.length,120);assert.equal(trace.purpose.length,500);
});
test("disabled clips do not inflate or reduce active coverage",()=>{
 const timeline=fixture();timeline.tracks[0].clips[0].enabled=false;
 const report=analyzeCreativeTraceability(timeline);
 assert.equal(report.totalClips,0);assert.equal(report.coveragePercent,0);assert.equal(report.readyForDirectorReview,false);
});
