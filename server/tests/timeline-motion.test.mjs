import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMotionKeyframes, evaluateMotionProperty, normalizeMotionKeyframes } from "../../src/core/timeline-motion.ts";
import { createTimeline, addTrack, addClip, rational, validateTimeline } from "../../src/core/timeline.ts";
const base={x:100,y:40,width:320,height:180,opacity:1,rotation:0};
test("motion keyframes interpolate every supported transform property",()=>{
 const keys=[{timeSeconds:0,x:0,y:10,width:100,height:50,opacity:0,rotation:0},{timeSeconds:2,x:200,y:110,width:300,height:150,opacity:1,rotation:90}];
 assert.deepEqual(evaluateMotionKeyframes(keys,1,base,2),{x:100,y:60,width:200,height:100,opacity:0.5,rotation:45});
});
test("step interpolation holds the previous transform value until the next keyframe",()=>{
 const keys=[{timeSeconds:0,x:10},{timeSeconds:1,x:50,interpolation:"step"}];
 assert.equal(evaluateMotionProperty(keys,0.999,"x",0,2),10);
 assert.equal(evaluateMotionProperty(keys,1,"x",0,2),50);
});
test("motion keyframes clamp supported ranges and return a sorted immutable copy",()=>{
 const input=[{timeSeconds:1,x:20000,opacity:2},{timeSeconds:0,x:-20000,opacity:-1}];
 const result=normalizeMotionKeyframes(input,2);
 assert.deepEqual(result,[{timeSeconds:0,interpolation:"linear",x:-16384,opacity:0},{timeSeconds:1,interpolation:"linear",x:16384,opacity:1}]);
 assert.equal(input[0].x,20000);
});
test("motion keyframes reject duplicate times, empty points, excessive count and out-of-range times",()=>{
 assert.throws(()=>normalizeMotionKeyframes([{timeSeconds:0,x:1},{timeSeconds:0,y:2}],2),/unique/);
 assert.throws(()=>normalizeMotionKeyframes([{timeSeconds:0}],2),/at least one/);
 assert.throws(()=>normalizeMotionKeyframes([{timeSeconds:3,x:1}],2),/inside its clip/);
 assert.throws(()=>normalizeMotionKeyframes(Array.from({length:257},(_,i)=>({timeSeconds:i/300,x:i})),2),/256/);
});
test("timeline rejects transform animation on non-overlay tracks and accepts valid overlay animation",()=>{
 let timeline=createTimeline("project","timeline-motion","Motion test");
 timeline=addTrack(timeline,{id:"overlay",name:"Overlay",kind:"overlay",enabled:true,locked:false,clips:[]});
 timeline=addClip(timeline,"overlay",{id:"image",assetId:"asset-image",name:"Logo",sourceRange:{start:rational(0,24),duration:rational(48,24)},timelineStart:rational(0,24),duration:rational(48,24),enabled:true,metadata:{motionKeyframes:[{timeSeconds:0,x:0},{timeSeconds:1,x:200}]}});
 assert.equal(validateTimeline(timeline).valid,true);
 timeline.tracks[0].clips[0].metadata={motionKeyframes:[{timeSeconds:0,x:0},{timeSeconds:3,x:200}]};
 assert.equal(validateTimeline(timeline).issues[0].code,"invalid_motion_keyframes");
});

test("ease-in, ease-out and ease-in-out transform interpolation are deterministic",()=>{
 const easeIn=[{timeSeconds:0,x:0},{timeSeconds:1,x:100,interpolation:"ease-in"}];
 const easeOut=[{timeSeconds:0,x:0},{timeSeconds:1,x:100,interpolation:"ease-out"}];
 const easeBoth=[{timeSeconds:0,x:0},{timeSeconds:1,x:100,interpolation:"ease-in-out"}];
 assert.equal(evaluateMotionProperty(easeIn,0.5,"x",0,1),12.5);
 assert.equal(evaluateMotionProperty(easeOut,0.5,"x",0,1),87.5);
 assert.equal(evaluateMotionProperty(easeBoth,0.25,"x",0,1),15.625);
 assert.equal(evaluateMotionProperty(easeBoth,0.75,"x",0,1),84.375);
});

test("motion loop and ping-pong playback wrap deterministically",()=>{
 const keys=[{timeSeconds:0,x:0},{timeSeconds:1,x:100}],base={x:0,y:0,width:100,height:100,opacity:1,rotation:0};
 assert.equal(evaluateMotionKeyframes(keys,1.25,base,2,"loop").x,25);
 assert.equal(evaluateMotionKeyframes(keys,1.25,base,2,"ping-pong").x,75);
 assert.equal(evaluateMotionKeyframes(keys,2,base,2,"loop").x,0);
 assert.equal(evaluateMotionKeyframes(keys,2,base,2,"ping-pong").x,0);
});

test("custom cubic Bezier interpolation is deterministic and matches the expected ease curve",()=>{
 const keys=[{timeSeconds:0,x:0},{timeSeconds:1,x:100,interpolation:"bezier",bezier:{x1:0.25,y1:0.1,x2:0.25,y2:1}}];
 assert.ok(Math.abs(evaluateMotionProperty(keys,0.5,"x",0,1)-80.2403)<0.01);
 const custom=[{timeSeconds:0,x:0},{timeSeconds:1,x:100,interpolation:"bezier",bezier:{x1:0.42,y1:0,x2:0.58,y2:1}}];
 assert.ok(Math.abs(evaluateMotionProperty(custom,0.25,"x",0,1)-12.9)<0.3);
});
test("custom cubic Bezier handles are bounded, ordered and normalized",()=>{
 const normalized=normalizeMotionKeyframes([{timeSeconds:0,x:0},{timeSeconds:1,x:100,interpolation:"bezier",bezier:{x1:0.2,y1:-0.5,x2:0.8,y2:1.5}}],1);
 assert.deepEqual(normalized[1].bezier,{x1:0.2,y1:-0.5,x2:0.8,y2:1.5});
 assert.throws(()=>normalizeMotionKeyframes([{timeSeconds:0,x:0,interpolation:"bezier",bezier:{x1:0.8,y1:0,x2:0.2,y2:1}}],1),/Bezier handles/);
 assert.throws(()=>normalizeMotionKeyframes([{timeSeconds:0,x:0,interpolation:"bezier",bezier:{x1:0.2,y1:3,x2:0.8,y2:1}}],1),/Bezier handles/);
});
