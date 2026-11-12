import test from "node:test";
import assert from "node:assert/strict";
import { timelineClipPreviewEffectValues, timelineClipPreviewFilter } from "../../src/core/timeline-playback.ts";

test("default clip effects leave the live preview unchanged",()=>{
 assert.equal(timelineClipPreviewFilter({metadata:{}}),"none");
 assert.deepEqual(timelineClipPreviewEffectValues({metadata:{}}),{brightness:0,contrast:1,saturation:1,intercept:0});
});

test("clip preview uses the same brightness, contrast and saturation bounds as FFmpeg",()=>{
 const clip={metadata:{timelineEffects:{brightness:0.12,contrast:1.2,saturation:0.8}}};
 assert.equal(timelineClipPreviewFilter(clip),"url(#ev-timeline-clip-effects)");
 assert.deepEqual(timelineClipPreviewEffectValues(clip),{brightness:0.12,contrast:1.2,saturation:0.8,intercept:0.020000000000000018});
});

test("invalid and out-of-range effect values are clamped before preview",()=>{
 const values=timelineClipPreviewEffectValues({metadata:{timelineEffects:{brightness:99,contrast:-2,saturation:"bad"}}});
 assert.equal(values.brightness,0.5);
 assert.equal(values.contrast,0.5);
 assert.equal(values.saturation,1);
 assert.equal(values.intercept,0.75);
});
