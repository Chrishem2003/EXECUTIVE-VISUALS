import test from "node:test";
import assert from "node:assert/strict";
import {buildMotionExpression,normalizeOverlayKeyframes} from "../timeline-motion-keyframes.mjs";
test("normalizes ordered overlay motion keyframes and bounds their values",()=>{
 const frames=normalizeOverlayKeyframes([{frame:24,x:500,y:200,scale:1.5},{frame:0,x:10,y:20,scale:1}],{durationFrames:48,width:1280,height:720});
 assert.deepEqual(frames,[{frame:0,x:10,y:20,scale:1},{frame:24,x:500,y:200,scale:1.5}]);
});
test("rejects duplicate frames, out-of-range positions, invalid scale and oversized keyframe sets",()=>{
 assert.throws(()=>normalizeOverlayKeyframes([{frame:0,x:0,y:0},{frame:0,x:2,y:2}]),/unique/);
 assert.throws(()=>normalizeOverlayKeyframes([{frame:3,x:-1,y:0}],{durationFrames:10}),/bounded/);
 assert.throws(()=>normalizeOverlayKeyframes([{frame:3,x:0,y:0,scale:5}],{durationFrames:10}),/bounded/);
 assert.throws(()=>normalizeOverlayKeyframes(Array.from({length:51},(_,frame)=>({frame,x:0,y:0})),{durationFrames:60}),/50/);
});
test("builds escaped FFmpeg expressions for piecewise linear motion",()=>{
 const frames=[{frame:0,x:0,y:10,scale:1},{frame:24,x:240,y:130,scale:2},{frame:48,x:480,y:250,scale:1}];
 const expression=buildMotionExpression(frames,"x",{startSeconds:2,fps:24});
 assert.match(expression,/if\(lt\(t\\,3\.000000\)/);
 assert.match(expression,/240\.0000/);assert.match(expression,/480\.0000/);
});
