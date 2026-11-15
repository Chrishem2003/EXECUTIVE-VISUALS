import test from "node:test";
import assert from "node:assert/strict";
import { mapSceneChangesToTimelineFrames } from "../../src/core/scene-detection.ts";

const base={sourceStartSeconds:2,sourceDurationSeconds:8,timelineStartFrame:48,timelineDurationFrames:192,timelineFps:24};

test("maps source scene cuts into clip-relative timeline marker frames",()=>{
 assert.deepEqual(mapSceneChangesToTimelineFrames({...base,sceneChanges:[1,2,3,5,9,10,11]}),[72,120,216]);
});

test("ignores cuts outside the selected source range and at clip boundaries",()=>{
 assert.deepEqual(mapSceneChangesToTimelineFrames({...base,sceneChanges:[0,2,2.02,9.98,10,12]}),[]);
});

test("deduplicates detected cuts and existing timeline markers within one frame",()=>{
 assert.deepEqual(mapSceneChangesToTimelineFrames({...base,sceneChanges:[3,3.01,4,5],existingMarkerFrames:[72]}),[96,120]);
});

test("rejects malformed timing and non-array detector output without creating markers",()=>{
 assert.deepEqual(mapSceneChangesToTimelineFrames({...base,sceneChanges:null}),[]);
 assert.deepEqual(mapSceneChangesToTimelineFrames({...base,timelineFps:0,sceneChanges:[3]}),[]);
 assert.deepEqual(mapSceneChangesToTimelineFrames({...base,sourceDurationSeconds:-1,sceneChanges:[3]}),[]);
});
