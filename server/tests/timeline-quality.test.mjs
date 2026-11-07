import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTimelineDelivery } from "../../src/core/timeline-quality.ts";

const timeline=(overrides={})=>({
 id:"sequence-1",projectId:"project-1",name:"Test",revision:1,
 frameRate:{numerator:30,denominator:1},width:1080,height:1920,pixelAspectRatio:1,
 tracks:[
  {id:"v1",name:"Picture",kind:"video",enabled:true,locked:false,clips:[{}]},
  {id:"a1",name:"Audio",kind:"audio",enabled:true,locked:false,clips:[{}]},
  {id:"c1",name:"Captions",kind:"caption",enabled:true,locked:false,clips:[{}]}
 ],markers:[],createdAt:"2026-11-07T00:00:00.000Z",updatedAt:"2026-11-07T00:00:00.000Z",
 ...overrides
});

test("accepts a matching vertical delivery profile without mutating the timeline",()=>{
 const value=timeline(),before=JSON.stringify(value);
 const findings=analyzeTimelineDelivery(value,{name:"Vertical social",aspectRatio:"9:16",width:1080,height:1920,frameRates:[30,60],requireAudio:true,requireCaptions:true});
 assert.deepEqual(findings.map(item=>item.code),["DELIVERY_PROFILE_PASSED"]);
 assert.equal(JSON.stringify(value),before);
});

test("blocks mismatched canvas, aspect ratio and frame rate",()=>{
 const findings=analyzeTimelineDelivery(timeline({width:1920,height:1080}),{name:"Vertical social",aspectRatio:"9:16",width:1080,height:1920,frameRates:[30]});
 const codes=new Set(findings.map(item=>item.code));
 assert.ok(codes.has("DELIVERY_DIMENSIONS_MISMATCH"));
 assert.ok(codes.has("DELIVERY_ASPECT_RATIO_MISMATCH"));
});

test("requires audio and captions only when the selected profile declares them",()=>{
 const value=timeline({tracks:[{id:"v1",name:"Picture",kind:"video",enabled:true,locked:false,clips:[{}]}]});
 const findings=analyzeTimelineDelivery(value,{name:"Accessible social",requireAudio:true,requireCaptions:true});
 const codes=new Set(findings.map(item=>item.code));
 assert.ok(codes.has("DELIVERY_AUDIO_REQUIRED"));
 assert.ok(codes.has("DELIVERY_CAPTIONS_REQUIRED"));
 assert.ok(!codes.has("DELIVERY_PROFILE_PASSED"));
 assert.deepEqual(analyzeTimelineDelivery(value,{name:"Silent visual",requireAudio:false,requireCaptions:false}),[
  {code:"DELIVERY_PROFILE_PASSED",severity:"info",title:"Delivery profile passed",detail:"The sequence matches the declared technical requirements for “Silent visual”. This check does not assess perceptual quality or provider encoding behavior."}
 ]);
});

test("rejects malformed profile dimensions, aspect ratios and frame rates",()=>{
 const findings=analyzeTimelineDelivery(timeline(),{name:"Bad profile",width:1080,aspectRatio:"portrait",frameRates:[]});
 assert.equal(findings.filter(item=>item.code==="INVALID_DELIVERY_PROFILE").length,3);
});

test("reports a missing sequence as a delivery error",()=>{
 assert.equal(analyzeTimelineDelivery(null,{name:"Social"} )[0].code,"NO_SEQUENCE");
});
