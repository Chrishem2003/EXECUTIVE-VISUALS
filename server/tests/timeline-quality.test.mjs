import test from "node:test";
import assert from "node:assert/strict";
import { assessTimelineRenderPreflight, analyzeTimelineQuality } from "../../src/core/timeline-quality.ts";

const clip=(speed)=>({id:"clip-1",assetId:"asset-1",name:"Opening shot",timelineStart:{value:0,rate:24},duration:{value:48,rate:24},sourceRange:{start:{value:0,rate:24},duration:{value:48,rate:24}},enabled:true,...(speed===undefined?{}:{speed})});
const timeline=(speed)=>({id:"sequence",projectId:"project",name:"Preflight",revision:1,frameRate:{numerator:24,denominator:1},width:1920,height:1080,pixelAspectRatio:1,tracks:[{id:"video-1",name:"Video 1",kind:"video",enabled:true,locked:false,clips:[clip(speed)]}],markers:[],createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"});
const assets=[{id:"asset-1",name:"Opening shot",mediaType:"video/mp4",sha256:"a".repeat(64)}];

test("1x and omitted speed remain render-preflight compatible",()=>{
 for(const speed of [undefined,1]){
  const result=assessTimelineRenderPreflight(timeline(speed),assets);
  assert.equal(result.blockers.some(item=>item.code==="UNSUPPORTED_TIME_REMAP"),false);
  assert.equal(result.blockers.some(item=>item.code==="INVALID_CLIP_SPEED"),false);
 }
});

test("non-1x speed is a clip-specific hard blocker before render submission",()=>{
 const result=assessTimelineRenderPreflight(timeline(1.5),assets);
 const finding=result.blockers.find(item=>item.code==="UNSUPPORTED_TIME_REMAP");
 assert.equal(result.ready,false);
 assert.equal(finding?.trackId,"video-1");
 assert.equal(finding?.clipId,"clip-1");
 assert.match(finding?.detail||"",/reset speed to 1×/);
});

test("non-positive and non-finite speed values are hard blockers",()=>{
 for(const speed of [0,-1,Number.NaN,Number.POSITIVE_INFINITY]){
  const findings=analyzeTimelineQuality(timeline(speed),assets);
  assert.ok(findings.some(item=>item.code==="INVALID_CLIP_SPEED"));
 }
});
