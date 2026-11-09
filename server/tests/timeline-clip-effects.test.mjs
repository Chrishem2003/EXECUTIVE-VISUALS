import test from "node:test";
import assert from "node:assert/strict";
import { buildTimelineClipEffects } from "../timeline-clip-effects.mjs";

test("timeline clip effects compile an empty layer to no filters",()=>{
 assert.deepEqual(buildTimelineClipEffects({}),{preScale:[],postScale:[],enabled:false});
});

test("timeline clip effects compile bounded deterministic color, denoise and sharpen filters",()=>{
 const result=buildTimelineClipEffects({timelineEffects:{brightness:0.12,contrast:1.2,saturation:0.8,denoise:2,sharpen:0.6}});
 assert.equal(result.enabled,true);
 assert.deepEqual(result.preScale,["eq=brightness=0.120:contrast=1.200:saturation=0.800","hqdn3d=2.00:2.00:8.00:8.00"]);
 assert.deepEqual(result.postScale,["unsharp=5:5:0.60:3:3:0"]);
});

test("timeline clip effects clamp unsafe numeric values and never accept filter text",()=>{
 const result=buildTimelineClipEffects({timelineEffects:{brightness:"0.5,drawtext=text=INJECT",contrast:99,saturation:-5,denoise:999,sharpen:99}});
 assert.deepEqual(result.preScale,["eq=brightness=0.000:contrast=2.000:saturation=0.000","hqdn3d=10.00:10.00:40.00:40.00"]);
 assert.deepEqual(result.postScale,["unsharp=5:5:1.00:3:3:0"]);
});
