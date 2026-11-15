import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTimelineMotionExpression, buildTimelineMotionFilters, evaluateTimelineMotion, normalizeTimelineMotion } from "../timeline-motion.mjs";
const keys=[{timeSeconds:0,x:20,y:30,width:100,height:80,opacity:0,rotation:0},{timeSeconds:2,x:220,y:130,width:300,height:180,opacity:1,rotation:90}];
test("FFmpeg motion expressions are bounded numeric expressions with frame-time interpolation",()=>{
 const expression=buildTimelineMotionExpression(keys,"x",0,2);
 assert.match(expression,/clip\(/);
 assert.match(expression,/200/);
 assert.doesNotMatch(expression,/[;\[\]{}]/);
});
test("motion evaluator matches the editor's linear transform interpolation",()=>{
 assert.deepEqual({x:evaluateTimelineMotion(keys,1,"x",0,2),y:evaluateTimelineMotion(keys,1,"y",0,2),width:evaluateTimelineMotion(keys,1,"width",16,2),height:evaluateTimelineMotion(keys,1,"height",16,2),opacity:evaluateTimelineMotion(keys,1,"opacity",1,2),rotation:evaluateTimelineMotion(keys,1,"rotation",0,2)},{x:120,y:80,width:200,height:130,opacity:0.5,rotation:45});
});
test("renderer emits animated scale, alpha, rotation and position filters",()=>{
 const result=buildTimelineMotionFilters({x:20,y:30,width:100,height:80,opacity:1,rotation:0,motionKeyframes:keys},2);
 assert.ok(result.filters.some(filter=>filter.startsWith("scale=w=")&&filter.includes("eval=frame")));
 assert.ok(result.filters.some(filter=>filter.startsWith("rotate=angle=")));
 assert.ok(result.filters.some(filter=>filter.startsWith("geq=r=")));
 assert.match(result.overlay,/eval=frame/);
 assert.deepEqual(result.animated,{x:true,y:true,width:true,height:true,opacity:true,rotation:true});
});
test("static transform metadata compiles without requiring animation keyframes",()=>{
 const positioned=buildTimelineMotionFilters({x:20,y:30,width:100,height:80,opacity:0.5},2);
 assert.ok(positioned.filters.some(filter=>filter==="scale=100:80:force_original_aspect_ratio=decrease"));
 assert.ok(positioned.filters.some(filter=>filter==="colorchannelmixer=aa=0.5"));
 assert.match(positioned.overlay,/overlay=x=/);
 const rotated=buildTimelineMotionFilters({x:20,y:30,width:100,height:80,opacity:0.5,rotation:25},2);
 assert.ok(rotated.filters.some(filter=>filter.startsWith("rotate=angle=")&&filter.includes("ow=129:oh=129")));
 assert.ok(rotated.filters.some(filter=>filter==="colorchannelmixer=aa=0.5"));
 assert.ok(rotated.overlay.includes("20"));
 assert.match(rotated.overlay,/overlay=x=/);
});
test("renderer rejects invalid or unsafe keyframe values",()=>{
 assert.throws(()=>normalizeTimelineMotion([{timeSeconds:0,x:1},{timeSeconds:0,x:2}],2),/unique/);
 assert.throws(()=>buildTimelineMotionFilters({motionKeyframes:[{timeSeconds:0,x:1},{timeSeconds:3,x:2}]},2),/inside its clip/);
 assert.throws(()=>buildTimelineMotionFilters({motionKeyframes:[{timeSeconds:0,x:1},{timeSeconds:1,opacity:NaN}]},2),/finite/);
});

test("FFmpeg compiler emits supported easing expressions for motion curves",()=>{
 const ease=[{timeSeconds:0,x:0},{timeSeconds:2,x:100,interpolation:"ease-in-out"}];
 const expression=buildTimelineMotionExpression(ease,"x",0,2);
 assert.match(expression,/clip\(/);
 assert.match(expression,/3-2/);
 const step=[{timeSeconds:0,x:10},{timeSeconds:1,x:50,interpolation:"step"}];
 assert.match(buildTimelineMotionExpression(step,"x",0,1),/10/);
});

test("renderer interpolates from the clip's base transform before the first keyframe",()=>{
 const keys=[{timeSeconds:1,x:100},{timeSeconds:2,x:200}];
 const expression=buildTimelineMotionExpression(keys,"x",20,2);
 assert.match(expression,/20\+\(80\)/);
 assert.equal(evaluateTimelineMotion(keys,0.5,"x",20,2),60);
});
test("rotated overlays preserve their center with fixed rotation output dimensions",()=>{
 const result=buildTimelineMotionFilters({x:20,y:30,width:100,height:80,rotation:0,motionKeyframes:[{timeSeconds:0,rotation:0},{timeSeconds:2,rotation:90}]},2);
 assert.ok(result.filters.some(filter=>filter.startsWith("scale=100:80")));
 assert.ok(result.filters.some(filter=>filter.startsWith("rotate=angle=")&&filter.includes("ow=129:oh=129")));
 assert.ok(result.filters.some(filter=>filter.startsWith("scale=w=")&&filter.includes("eval=frame")));
 assert.match(result.overlay,/eval=frame/);
});

test("animated overlay transform filter graph renders successfully with FFmpeg",async t=>{
 const binary=process.env.FFMPEG_PATH||"ffmpeg",version=spawnSync(binary,["-version"],{stdio:"ignore"});
 if(version.status!==0){t.skip("FFmpeg is unavailable in this test environment");return;}
 const duration=2,metadata={x:20,y:30,width:80,height:60,opacity:0,rotation:0,motionKeyframes:[{timeSeconds:0,x:20,y:30,width:80,height:60,opacity:0,rotation:0},{timeSeconds:2,x:80,y:50,width:120,height:90,opacity:1,rotation:90,interpolation:"ease-in-out"}]},motion=buildTimelineMotionFilters(metadata,duration,320,240);
 const graph="[1:v]"+motion.filters.join(",")+"[over];[0:v][over]"+motion.overlay+":enable='between(t,0,2)'[out]";
 const dir=await mkdtemp(join(tmpdir(),"ev-motion-render-")),output=join(dir,"motion.mp4");
 try{
  const result=spawnSync(binary,["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=320x240:r=24:d=2","-f","lavfi","-i","color=c=red@0.5:s=80x60:r=24:d=2","-filter_complex",graph,"-map","[out]","-t","2","-c:v","libx264","-pix_fmt","yuv420p","-y",output],{encoding:"utf8",timeout:60000});
  assert.equal(result.status,0,result.stderr||"FFmpeg failed to render animated transform graph");
  assert.ok((await stat(output)).size>0,"FFmpeg must produce a non-empty video");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("primary video transform graph composites onto the sequence canvas and renders",async t=>{
 const binary=process.env.FFMPEG_PATH||"ffmpeg",version=spawnSync(binary,["-version"],{stdio:"ignore"});
 if(version.status!==0){t.skip("FFmpeg is unavailable in this test environment");return;}
 const duration=2,metadata={x:0,y:0,width:160,height:90,opacity:1,rotation:0,motionKeyframes:[{timeSeconds:0,x:0,y:0,width:160,height:90,rotation:0},{timeSeconds:2,x:80,y:40,width:120,height:68,rotation:25,interpolation:"ease-in-out"}]},motion=buildTimelineMotionFilters(metadata,duration,320,240);
 const graph="[1:v]"+motion.filters.join(",")+"[transformed];[0:v][transformed]"+motion.overlay+"[out]";
 const dir=await mkdtemp(join(tmpdir(),"ev-primary-motion-")),output=join(dir,"primary-motion.mp4");
 try{
  const result=spawnSync(binary,["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=black:s=320x240:r=24:d=2","-f","lavfi","-i","testsrc2=s=160x90:r=24:d=2","-filter_complex",graph,"-map","[out]","-t","2","-c:v","libx264","-pix_fmt","yuv420p","-y",output],{encoding:"utf8",timeout:60000});
  assert.equal(result.status,0,result.stderr||"FFmpeg failed to render primary-video transforms");
  assert.ok((await stat(output)).size>0,"FFmpeg must produce a non-empty primary-video master");
 }finally{await rm(dir,{recursive:true,force:true});}
});
