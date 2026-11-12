import test from "node:test";
import assert from "node:assert/strict";
import { timelineClipPreviewFilter } from "../../src/core/timeline-playback.ts";

test("default clip effects leave the live preview unchanged",()=>{
 assert.equal(timelineClipPreviewFilter({metadata:{}}),"none");
 assert.equal(timelineClipPreviewFilter({metadata:{timelineEffects:{brightness:0,contrast:1,saturation:1}}}),"none");
});

test("bounded clip color effects compile to deterministic CSS filters",()=>{
 assert.equal(timelineClipPreviewFilter({metadata:{timelineEffects:{brightness:0.12,contrast:1.2,saturation:0.8}}}),"brightness(112.0%) contrast(120.0%) saturate(80.0%)");
});

test("unsafe values are clamped and non-numeric effect values use safe defaults",()=>{
 assert.equal(timelineClipPreviewFilter({metadata:{timelineEffects:{brightness:99,contrast:-2,saturation:"not-a-number"}}}),"brightness(150.0%) contrast(50.0%) saturate(100.0%)");
});
