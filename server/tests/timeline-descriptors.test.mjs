import test from "node:test";
import assert from "node:assert/strict";
import { rational, validateTimeline, toOpenTimelineIo } from "../../src/core/timeline.ts";
import { validateTimelineDescriptors } from "../../src/core/timeline-descriptors.ts";
import { validateTimelineClipDescriptors, assertTimelineDescriptorsSupported } from "../timeline-descriptors.mjs";
import { renderCloudTimeline } from "../cloud-ffmpeg-timeline-renderer.mjs";

const validClip=()=>({
 id:"clip-1",assetId:"asset-1",name:"Main shot",
 sourceRange:{start:rational(0,24),duration:rational(48,24)},
 timelineStart:rational(0,24),duration:rational(48,24),enabled:true,
 effects:[{schemaVersion:1,id:"color-1",type:"color",enabled:true,parameters:{brightness:0.05,contrast:1.1,saturation:1.2}}],
 keyframes:[
  {schemaVersion:1,id:"opacity-start",property:"opacity",frame:0,value:1,interpolation:"linear"},
  {schemaVersion:1,id:"opacity-end",property:"opacity",frame:48,value:0.7,interpolation:"linear"}
 ],
 transitionIn:{schemaVersion:1,id:"fade-in",type:"fade-to-black",edge:"in",durationFrames:12,curve:"linear"},
 transitionOut:{schemaVersion:1,id:"fade-out",type:"fade-to-black",edge:"out",durationFrames:12,curve:"linear"}
});
const timeline=(clip=validClip())=>({
 id:"timeline-1",projectId:"project-1",name:"Descriptor test",revision:1,
 frameRate:{numerator:24,denominator:1},width:1920,height:1080,pixelAspectRatio:1,
 tracks:[{id:"track-1",name:"Video",kind:"video",enabled:true,locked:false,clips:[clip]}],
 markers:[],createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"
});

test("valid versioned color, keyframe and fade descriptors pass timeline validation",()=>{
 const result=validateTimeline(timeline());
 assert.equal(result.valid,true,JSON.stringify(result.issues));
 assert.deepEqual(validateTimelineDescriptors(validClip(),{numerator:24,denominator:1}),[]);
 assert.deepEqual(validateTimelineClipDescriptors(validClip(),{numerator:24,denominator:1}),[]);
});

test("OTIO export preserves clip effects, keyframes and transition metadata",()=>{
 const otio=toOpenTimelineIo(timeline());
 const metadata=otio.tracks.children[0].children[0].metadata.executiveVisuals;
 assert.equal(metadata.effects[0].type,"color");
 assert.equal(metadata.keyframes.length,2);
 assert.equal(metadata.transitionIn.edge,"in");
 assert.equal(metadata.transitionOut.edge,"out");
});

test("invalid effect parameters fail closed in both client and server validators",()=>{
 const clip=validClip();clip.effects[0].parameters.brightness=2;
 assert.equal(validateTimeline(timeline(clip)).valid,false);
 assert.ok(validateTimelineClipDescriptors(clip,{numerator:24,denominator:1}).length>0);
 assert.ok(validateTimelineDescriptors(clip,{numerator:24,denominator:1}).length>0);
});

test("keyframes reject out-of-range frames and duplicate property-frame pairs",()=>{
 const outside=validClip();outside.keyframes[1].frame=49;
 assert.ok(validateTimelineDescriptors(outside,{numerator:24,denominator:1}).some(issue=>issue.code==="invalid_keyframe"));
 const duplicate=validClip();duplicate.keyframes[1]={...duplicate.keyframes[0],id:"duplicate-slot",value:0.5};
 assert.ok(validateTimelineDescriptors(duplicate,{numerator:24,denominator:1}).some(issue=>issue.code==="duplicate_keyframe"));
});

test("transition descriptors must match their edge and stay within clip duration",()=>{
 const clip=validClip();clip.transitionIn={...clip.transitionIn,edge:"out",durationFrames:60};
 const issues=validateTimelineDescriptors(clip,{numerator:24,denominator:1});
 assert.ok(issues.some(issue=>issue.code==="invalid_transition"));
});

test("descriptor IDs are unique across effects, keyframes and transitions",()=>{
 const clip=validClip();clip.transitionOut={...clip.transitionOut,id:clip.effects[0].id};
 assert.ok(validateTimelineDescriptors(clip,{numerator:24,denominator:1}).some(issue=>issue.code==="invalid_descriptor_id"));
});

test("master renderer refuses descriptors it cannot reproduce instead of silently dropping them",async()=>{
 await assert.rejects(()=>renderCloudTimeline({timeline:timeline(),assets:new Map(),workDir:"/tmp/ev-descriptor-test"}),/cannot yet reproduce/);
 assert.throws(()=>assertTimelineDescriptorsSupported(timeline()),{code:"UNSUPPORTED_TIMELINE_FEATURE"});
});

test("unannotated legacy clips remain valid and renderable by the descriptor guard",()=>{
 const clip=validClip();delete clip.effects;delete clip.keyframes;delete clip.transitionIn;delete clip.transitionOut;
 assert.deepEqual(validateTimelineDescriptors(clip,{numerator:24,denominator:1}),[]);
 assert.deepEqual(validateTimelineClipDescriptors(clip,{numerator:24,denominator:1}),[]);
 assert.doesNotThrow(()=>assertTimelineDescriptorsSupported(timeline(clip)));
});
