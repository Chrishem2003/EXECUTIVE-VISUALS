import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClipSpeed, sourceDurationForTimeline, buildAtempoFilter } from "../time-remap.mjs";

test("clip speed is bounded and source duration follows timeline duration",()=>{
 assert.equal(normalizeClipSpeed(1),1);
 assert.equal(sourceDurationForTimeline(1.5,2),3);
 assert.equal(sourceDurationForTimeline(2,0.5),1);
 for(const value of [0,0.1,4.01,Number.NaN,Infinity])assert.throws(()=>normalizeClipSpeed(value),error=>error.code==="INVALID_CLIP_SPEED");
});

test("audio time stretching chains atempo stages within FFmpeg's portable range",()=>{
 assert.equal(buildAtempoFilter(1),"");
 assert.equal(buildAtempoFilter(0.5),"atempo=0.5");
 assert.equal(buildAtempoFilter(2),"atempo=2");
 assert.equal(buildAtempoFilter(4),"atempo=2,atempo=2");
 assert.equal(buildAtempoFilter(0.25),"atempo=0.5,atempo=0.5");
 assert.equal(buildAtempoFilter(3),"atempo=2,atempo=1.5");
});
