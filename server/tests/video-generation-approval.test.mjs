import test from "node:test";
import assert from "node:assert/strict";
import {buildVideoGenerationApproval} from "../video-generation-approval.mjs";
const shots=[{id:"shot-1",prompt:"A sunrise",durationSeconds:5,provider:"runway",model:"seedance2_5"}];
const preflight={status:"ready_for_approval",readyForApproval:true,requestsSubmitted:false,pricing:{status:"verified_estimate",quote:{available:true,estimated:true,currency:"USD",amount:1.25,shots:[{shotId:"shot-1",provider:"runway",model:"seedance2_5",currency:"USD",amount:1.25,pricing:{sourceUrl:"https://pricing.example/rates",observedAt:"2026-11-01T00:00:00.000Z",expiresAt:"2027-01-01T00:00:00.000Z"}}]}}};
test("creates a deterministic immutable approval snapshot under the budget ceiling",()=>{
 const result=buildVideoGenerationApproval({shots,preflight,budget:{currency:"USD",amount:2},confirmed:true});
 assert.equal(result.status,"approved_pending_submission");
 assert.equal(result.requestsSubmitted,false);
 assert.equal(result.quotedAmountMicros,1250000);
 assert.equal(result.budgetCeilingMicros,2000000);
 const snapshot=JSON.parse(result.snapshotJson);assert.equal(snapshot.shots[0].estimatedCostMicros,1250000);assert.equal(snapshot.shots[0].estimatedCost.currency,"USD");
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
 const hugeQuote={...preflight,pricing:{status:"verified_estimate",quote:{available:true,estimated:true,currency:"USD",amount:Number.MAX_VALUE,shots:[{shotId:"shot-1",provider:"runway",model:"seedance2_5",currency:"USD",amount:Number.MAX_VALUE,pricing:{}}]}}};
 assert.throws(()=>buildVideoGenerationApproval({shots,preflight:hugeQuote,budget:{currency:"USD",amount:Number.MAX_VALUE},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_INVALID_BUDGET");
});
test("rejects oversized or empty approval plans",()=>{
 assert.throws(()=>buildVideoGenerationApproval({shots:[],preflight,budget:{currency:"USD",amount:2},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_INVALID_SHOTS");
 assert.throws(()=>buildVideoGenerationApproval({shots:Array(13).fill(shots[0]),preflight,budget:{currency:"USD",amount:2},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_INVALID_SHOTS");
});

test("rejects aggregate quotes that do not equal the independently priced shot sum",()=>{
 const mismatch={...preflight,pricing:{...preflight.pricing,quote:{...preflight.pricing.quote,amount:2}}};
 assert.throws(()=>buildVideoGenerationApproval({shots,preflight:mismatch,budget:{currency:"USD",amount:3},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_SHOT_TOTAL_MISMATCH");
});
test("rejects shot quote records for a different provider or model",()=>{
 const mismatch={...preflight,pricing:{...preflight.pricing,quote:{...preflight.pricing.quote,shots:[{...preflight.pricing.quote.shots[0],model:"different-model"}]}}};
 assert.throws(()=>buildVideoGenerationApproval({shots,preflight:mismatch,budget:{currency:"USD",amount:2},confirmed:true}),e=>e.code==="VIDEO_APPROVAL_SHOT_PRICING_MISMATCH");
});
