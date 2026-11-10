import test from "node:test";
import assert from "node:assert/strict";
import {buildVideoGenerationApproval} from "../video-generation-approval.mjs";
const shots=[{id:"shot-1",prompt:"A sunrise",durationSeconds:5,provider:"runway",model:"seedance2_5"}];
const preflight={status:"ready_for_approval",readyForApproval:true,requestsSubmitted:false,pricing:{status:"verified_estimate",quote:{available:true,estimated:true,currency:"USD",amount:1.25,shots:[]}}};
test("creates a deterministic immutable approval snapshot under the budget ceiling",()=>{
 const result=buildVideoGenerationApproval({shots,preflight,budget:{currency:"USD",amount:2},confirmed:true});
 assert.equal(result.status,"approved_pending_submission");
 assert.equal(result.requestsSubmitted,false);
 assert.equal(result.quotedAmountMicros,1250000);
 assert.equal(result.budgetCeilingMicros,2000000);
 assert.match(result.requestHash,/^[a-f0-9]{64}$/);
 assert.equal(result.requestHash,buildVideoGenerationApproval({shots:[{...shots[0]}],preflight,budget:{currency:"USD",amount:2},confirmed:true}).requestHash);
});
test("requires an explicit confirmation and a fresh passing dry run",()=>{
 assert.throws(()=>buildVideoGenerationApproval({shots,preflight,budget:{currency:"USD",amount:2}}),e=>e.code==="VIDEO_APPROVAL_CONFIRMATION_REQUIRED");
 assert.throws(()=>buildVideoGenerationApproval({shots,preflight:{...preflight,status:"blocked"},budget:{currency:"USD",amount:2},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_PREFLIGHT_REQUIRED");
});
test("rejects unverified pricing, currency mismatch and budget overrun",()=>{
 const noPrice={...preflight,pricing:{status:"unavailable"}};
 assert.throws(()=>buildVideoGenerationApproval({shots,preflight:noPrice,budget:{currency:"USD",amount:2},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_PRICE_UNVERIFIED");
 assert.throws(()=>buildVideoGenerationApproval({shots,preflight,budget:{currency:"EUR",amount:2},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_INVALID_BUDGET");
 assert.throws(()=>buildVideoGenerationApproval({shots,preflight,budget:{currency:"USD",amount:1},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_BUDGET_EXCEEDED");
});
test("rejects amounts that cannot be represented safely in integer micro-units",()=>{
 assert.throws(()=>buildVideoGenerationApproval({shots,preflight,budget:{currency:"USD",amount:Number.MAX_VALUE},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_INVALID_BUDGET");
 const hugeQuote={...preflight,pricing:{status:"verified_estimate",quote:{available:true,estimated:true,currency:"USD",amount:Number.MAX_VALUE}}};
 assert.throws(()=>buildVideoGenerationApproval({shots,preflight:hugeQuote,budget:{currency:"USD",amount:Number.MAX_VALUE},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_INVALID_BUDGET");
});
test("rejects oversized or empty approval plans",()=>{
 assert.throws(()=>buildVideoGenerationApproval({shots:[],preflight,budget:{currency:"USD",amount:2},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_INVALID_SHOTS");
 assert.throws(()=>buildVideoGenerationApproval({shots:Array(13).fill(shots[0]),preflight,budget:{currency:"USD",amount:2},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_INVALID_SHOTS");
});
