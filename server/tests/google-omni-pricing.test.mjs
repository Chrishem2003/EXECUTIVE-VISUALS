import test from "node:test";
import assert from "node:assert/strict";
import { estimateGoogleOmniVideoCost, resolveGoogleOmniActualCost } from "../google-omni-pricing.mjs";

test("Gemini Omni preflight reserves bounded USD and internal customer credits",()=>{
 const estimate=estimateGoogleOmniVideoCost({durationSeconds:5,resolution:"720p"});
 assert.equal(estimate.amount,2.586464);
 assert.equal(estimate.estimatedCredits,259);
 assert.equal(estimate.customerCreditsPerUsd,100);
 assert.equal(estimate.maxOutputSeconds,10);
 assert.equal(estimate.billable,false);
});
test("Gemini Omni actual modality usage reconciles to customer credits",()=>{
 const actual=resolveGoogleOmniActualCost({
  providerTaskId:"v1_abcdef123456",
  task:{rawInteraction:{usage:{
   total_input_tokens:100000,total_output_tokens:10000,
   output_tokens_by_modality:[{modality:"text",tokens:1000},{modality:"video",tokens:9000}]
  }}}
 });
 assert.equal(actual.currency,"USD");
 assert.equal(actual.actualCredits,Math.ceil(actual.amount*100));
 assert.ok(actual.evidenceReference.includes("video=9000"));
});
test("Gemini Omni usage rejects unpriced audio modality instead of silently undercharging",()=>{
 assert.throws(()=>resolveGoogleOmniActualCost({
  providerTaskId:"v1_abcdef123456",
  task:{rawInteraction:{usage:{
   total_input_tokens:100,total_output_tokens:10,
   output_tokens_by_modality:[{modality:"audio",tokens:10}]
  }}}
 }),error=>error.code==="GOOGLE_OMNI_USAGE_EVIDENCE_MISSING");
});
