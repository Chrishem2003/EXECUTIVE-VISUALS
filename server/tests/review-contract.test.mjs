import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewCreate,normalizeReviewPatch } from "../review-contract.mjs";

const projectId="11111111-1111-4111-8111-111111111111";
const assetId="22222222-2222-4222-8222-222222222222";
const timelineId="33333333-3333-4333-8333-333333333333";
const base={projectId,assetId,timelineId,timelineRevision:4,frameNumber:240,durationFrames:24,body:"Please adjust the lower-third."};

test("normalizes a frame-accurate review with a rational frame anchor and annotation",()=>{
 const review=normalizeReviewCreate({...base,annotation:{version:1,shapes:[{type:"arrow",points:[{x:0.1,y:0.2},{x:0.8,y:0.7}],color:"#ffcc00",width:3}]}});
 assert.equal(review.frameNumber,240);assert.equal(review.timelineRevision,4);assert.equal(review.durationFrames,24);
 assert.equal(review.annotation.shapes[0].type,"arrow");assert.equal(review.visibility,"project");
});
test("supports timecode-only and global comments without inventing frame anchors",()=>{
 const timed=normalizeReviewCreate({projectId,assetId,timecodeSeconds:12.5,body:"Check the transition."});
 const global=normalizeReviewCreate({projectId,body:"Overall pacing is good."});
 assert.equal(timed.timecodeSeconds,12.5);assert.equal(timed.frameNumber,null);
 assert.equal(global.assetId,null);assert.equal(global.timecodeSeconds,null);
});
test("supports review decisions and internal-only visibility",()=>{
 const review=normalizeReviewCreate({...base,decision:"request_changes",visibility:"internal"});
 assert.equal(review.decision,"request_changes");assert.equal(review.visibility,"internal");
});
test("rejects frame anchors without an asset and revisions without a timeline",()=>{
 assert.throws(()=>normalizeReviewCreate({projectId,frameNumber:3,body:"x"}),error=>error.code==="REVIEW_INVALID");
 assert.throws(()=>normalizeReviewCreate({projectId,assetId,timelineRevision:2,body:"x"}),error=>error.code==="REVIEW_INVALID");
});
test("requires complete timeline anchors and a starting frame for ranges",()=>{
 assert.throws(()=>normalizeReviewCreate({projectId,assetId,timelineId,body:"x"}),error=>error.code==="REVIEW_INVALID");
 assert.throws(()=>normalizeReviewCreate({projectId,assetId,durationFrames:12,body:"x"}),error=>error.code==="REVIEW_INVALID");
 assert.throws(()=>normalizeReviewCreate({projectId,assetId,timelineId,timelineRevision:2,body:"x"}),error=>error.code==="REVIEW_INVALID");
});
test("rejects invalid frame ranges, timecodes and unsupported decision values",()=>{
 for(const input of [{frameNumber:-1},{durationFrames:90001},{timecodeSeconds:-1},{decision:"publish"}]){
  assert.throws(()=>normalizeReviewCreate({...base,...input}),error=>error.code==="REVIEW_INVALID");
 }
});
test("rejects malformed, excessive and non-normalized drawing geometry",()=>{
 const malformed=[
  {version:2,shapes:[]},
  {version:1,shapes:[{type:"circle",points:[{x:0,y:0},{x:1,y:1}]}]},
  {version:1,shapes:[{type:"arrow",points:[{x:-0.1,y:0},{x:1,y:1}]}]},
  {version:1,shapes:[{type:"line",points:[{x:0,y:0},{x:1,y:1}],url:"https://evil.test"}]}
 ];
 for(const annotation of malformed)assert.throws(()=>normalizeReviewCreate({...base,annotation}),error=>error.code==="REVIEW_ANNOTATION_INVALID");
 assert.throws(()=>normalizeReviewCreate({...base,annotation:{version:1,shapes:Array.from({length:33},()=>({type:"line",points:[{x:0,y:0},{x:1,y:1}]}))}}),error=>error.code==="REVIEW_ANNOTATION_INVALID");
});
test("requires annotations to be attached to a frame-anchored comment",()=>{
 assert.throws(()=>normalizeReviewCreate({projectId,assetId,body:"Look here",annotation:{version:1,shapes:[{type:"rectangle",points:[{x:0,y:0},{x:1,y:1}]}]}}),error=>error.code==="REVIEW_ANNOTATION_INVALID");
});
test("rejects unexpected ownership and privilege fields from request payloads",()=>{
 for(const key of ["ownerId","reviewerId","status","resolvedBy","createdAt"])assert.throws(()=>normalizeReviewCreate({...base,[key]:"forged"}),error=>error.code==="REVIEW_INVALID");
});
test("normalizes partial edits and refuses empty or privileged patches",()=>{
 assert.deepEqual(normalizeReviewPatch({body:"Revised note",status:"resolved"}),{body:"Revised note",status:"resolved"});
 for(const patch of [{},{ownerId:projectId},{projectId},{frameNumber:0},{status:"approved"}])assert.throws(()=>normalizeReviewPatch(patch),error=>error.code==="REVIEW_INVALID");
});
test("rejects malformed IDs and invalid comment lengths",()=>{
 assert.throws(()=>normalizeReviewCreate({...base,projectId:"bad"}),error=>error.code==="REVIEW_INVALID");
 assert.throws(()=>normalizeReviewCreate({...base,body:"   "}),error=>error.code==="REVIEW_INVALID");
});
