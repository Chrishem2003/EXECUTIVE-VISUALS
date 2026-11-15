import test from "node:test";
import assert from "node:assert/strict";
import { buildTimelineMotionExpression, buildTimelineMotionFilters, evaluateTimelineMotion, normalizeTimelineMotion } from "../timeline-motion.mjs";
const keys=[{timeSeconds:0,x:20,y:30,width:100,height:80,opacity:0,rotation:0},{timeSeconds:2,x:220,y:130,width:300,height:180,opacity:1,rotation:90}];
test("FFmpeg motion expressions are bounded numeric expressions with frame-time interpolation",()=>{
 const expression=buildTimelineMotionExpression(keys,"x",0,2);
 assert.match(expression,/if\(lt\(t\\,2\)/);
 assert.match(expression,/100/);
 assert.doesNotMatch(expression,/[;\[\]{}]/);
});
test("motion evaluator matches the editor's linear transform interpolation",()=>{
 assert.deepEqual(evaluateTimelineMotion(keys,1,{x:0,y:0,width:16,height:16,opacity:1,rotation:0},2),{x:120,y:80,width:200,height:130,opacity:0.5,rotation:45});
});
test("renderer emits animated scale, alpha, rotation and position filters",()=>{
 const result=buildTimelineMotionFilters({x:20,y:30,width:100,height:80,opacity:1,rotation:0,motionKeyframes:keys},2);
 assert.ok(result.filters.some(filter=>filter.startsWith("scale=w=")&&filter.includes("eval=frame")));
 assert.ok(result.filters.some(filter=>filter.startsWith("rotate=angle=")));
 assert.ok(result.filters.some(filter=>filter.startsWith("geq=a=")));
 assert.match(result.overlay,/eval=frame/);
 assert.deepEqual(result.animated,{x:true,y:true,width:true,height:true,opacity:true,rotation:true});
});
test("static metadata remains unchanged when no motion keyframes are present",()=>{
 assert.equal(buildTimelineMotionFilters({x:20,y:30,width:100,height:80,opacity:0.5},2),null);
 const rotated=buildTimelineMotionFilters({x:20,y:30,width:100,height:80,opacity:0.5,rotation:25},2);
 assert.ok(rotated.filters.some(filter=>filter.includes("rotw(PI/4)")));
 assert.match(rotated.overlay,/overlay_w/);
});
test("renderer rejects invalid or unsafe keyframe values",()=>{
 assert.throws(()=>normalizeTimelineMotion([{timeSeconds:0,x:1},{timeSeconds:0,x:2}],2),/unique/);
 assert.throws(()=>buildTimelineMotionFilters({motionKeyframes:[{timeSeconds:0,x:1},{timeSeconds:3,x:2}]},2),/inside its clip/);
 assert.throws(()=>buildTimelineMotionFilters({motionKeyframes:[{timeSeconds:0,x:1},{timeSeconds:1,opacity:NaN}]},2),/finite/);
});

test("FFmpeg compiler emits supported easing expressions for motion curves",()=>{
 const ease=[{timeSeconds:0,x:0},{timeSeconds:2,x:100,interpolation:"ease-in-out"}];
 const expression=buildTimelineMotionExpression(ease,"x",0,2);
 assert.match(expression,/pow\(/);
 assert.match(expression,/0\.5/);
 const step=[{timeSeconds:0,x:10},{timeSeconds:1,x:50,interpolation:"step"}];
 assert.match(buildTimelineMotionExpression(step,"x",0,1),/10/);
});

test("renderer interpolates from the clip's base transform before the first keyframe",()=>{
 const keys=[{timeSeconds:1,x:100},{timeSeconds:2,x:200}];
 const expression=buildTimelineMotionExpression(keys,"x",20,2);
 assert.match(expression,/20\+\(80\)/);
 assert.equal(evaluateTimelineMotion(keys,0.5,"x",20,2),60);
});
test("rotated overlays keep their visual center anchored while using a safe diagonal canvas",()=>{
 const result=buildTimelineMotionFilters({x:20,y:30,width:100,height:80,rotation:0,motionKeyframes:[{timeSeconds:0,rotation:0},{timeSeconds:2,rotation:90}]},2);
 assert.ok(result.filters.some(filter=>filter.includes("rotw(PI/4)")));
 assert.match(result.overlay,/overlay_w/);
 assert.match(result.overlay,/overlay_h/);
});
