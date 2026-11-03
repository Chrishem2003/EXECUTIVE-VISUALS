import test from "node:test";
import assert from "node:assert/strict";
import { rational } from "../../src/core/timeline.ts";
import { clipSourceSecondsAtTimelineFrame, clampPreviewSeconds, frameToSeconds, previewSecondsAtScrubFrame, secondsToFrame, stepPreviewSeconds } from "../../src/core/timeline-preview.ts";

const rate={numerator:30000,denominator:1001};
const clip={id:"c",assetId:"a",name:"clip",sourceRange:{start:rational(90,30),duration:rational(150,30)},timelineStart:rational(30,24),duration:rational(120,24),enabled:true};

test("rational frame conversion preserves fractional frame rates",()=>{
 assert.equal(frameToSeconds(30000,rate),1001);
 assert.equal(secondsToFrame(1001,rate),30000);
 assert.equal(frameToSeconds(1,{numerator:24,denominator:1}),1/24);
});

test("clip preview maps timeline frames to source time and respects source trims",()=>{
 assert.equal(clipSourceSecondsAtTimelineFrame(clip,30,{numerator:24,denominator:1}),3);
 assert.equal(clipSourceSecondsAtTimelineFrame(clip,54,{numerator:24,denominator:1}),4);
 assert.equal(clipSourceSecondsAtTimelineFrame(clip,500,{numerator:24,denominator:1}),8);
});

test("preview seek clamps to source in/out and frame steps use source rate",()=>{
 assert.equal(clampPreviewSeconds(-1,3,8),3);
 assert.equal(clampPreviewSeconds(12,3,8),8);
 assert.equal(stepPreviewSeconds(4,1,25,3,8),4.04);
 assert.equal(stepPreviewSeconds(3,-1,25,3,8),3);
});

test("invalid frame and playback inputs fail closed",()=>{
 assert.throws(()=>frameToSeconds(-1,rate));
 assert.throws(()=>secondsToFrame(Number.NaN,rate));
 assert.throws(()=>stepPreviewSeconds(4,1,0,3,8));
 assert.throws(()=>clampPreviewSeconds(2,4,3));
});

test("scrubber frame offsets map to bounded source timestamps",()=>{
 assert.equal(previewSecondsAtScrubFrame(25,2,25,8),3);
 assert.equal(previewSecondsAtScrubFrame(500,2,25,8),8);
 assert.throws(()=>previewSecondsAtScrubFrame(-1,2,25,8));
 assert.throws(()=>previewSecondsAtScrubFrame(1,2,0,8));
});
