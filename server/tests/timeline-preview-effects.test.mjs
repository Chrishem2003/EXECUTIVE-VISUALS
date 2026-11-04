import test from "node:test";
import assert from "node:assert/strict";
import { rational } from "../../src/core/timeline.ts";
import { getTimelineClipPreviewStyle } from "../../src/core/timeline-preview-effects.ts";

const clip=()=>({
 id:"clip",assetId:"asset",name:"Shot",sourceRange:{start:rational(0,24),duration:rational(48,24)},
 timelineStart:rational(24,24),duration:rational(48,24),enabled:true,
 effects:[{schemaVersion:1,id:"color",type:"color",enabled:true,parameters:{brightness:1.1,contrast:1.2,saturation:1.3}}],
 transitionIn:{schemaVersion:1,id:"fade-in",type:"fade-to-black",edge:"in",durationFrames:12,curve:"linear"},
 transitionOut:{schemaVersion:1,id:"fade-out",type:"fade-to-black",edge:"out",durationFrames:12,curve:"linear"}
});

test("preview color filters match descriptor multipliers",()=>{
 const style=getTimelineClipPreviewStyle(clip(),1.5,{numerator:24,denominator:1});
 assert.equal(style.filter,"brightness(1.1000) contrast(1.2000) saturate(1.3000)");
});

test("fade-in and fade-out opacity are evaluated in timeline frame time",()=>{
 const source=clip();
 assert.equal(getTimelineClipPreviewStyle(source,1,{numerator:24,denominator:1}).opacity,0);
 assert.equal(getTimelineClipPreviewStyle(source,1.25,{numerator:24,denominator:1}).opacity,0.5);
 assert.equal(getTimelineClipPreviewStyle(source,1.5,{numerator:24,denominator:1}).opacity,1);
 assert.equal(getTimelineClipPreviewStyle(source,2.5,{numerator:24,denominator:1}).opacity,1);
 assert.equal(getTimelineClipPreviewStyle(source,2.75,{numerator:24,denominator:1}).opacity,0.5);
});

test("disabled color effects do not change preview filters",()=>{
 const source=clip();source.effects[0].enabled=false;
 assert.equal(getTimelineClipPreviewStyle(source,1.5,{numerator:24,denominator:1}).filter,"");
});
