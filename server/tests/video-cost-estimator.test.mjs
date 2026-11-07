import test from "node:test";
import assert from "node:assert/strict";
import { estimateVideoGenerationCost, parseVideoPricingCatalog } from "../video-cost-estimator.mjs";

const now=()=>new Date("2026-11-07T12:00:00.000Z");
const pricing=[{
 provider:"fal",model:"fal-ai/example-video",currency:"USD",
 sourceUrl:"https://fal.ai/pricing",observedAt:"2026-11-01T00:00:00.000Z",expiresAt:"2026-11-08T00:00:00.000Z",
 ratesPerSecond:{"720p":0.12,provider_default:0.1},minimumCharge:0.5,
 audioSurchargePerSecond:0.02,referenceImageFee:0.03,billingIncrementSeconds:2
}];
const request={provider:"fal",model:"fal-ai/example-video",durationSeconds:5,resolution:"720p",audioMode:"generated",referenceImageCount:2};

test("estimates exact model pricing with billing increments, audio, references and minimums",()=>{
 const quote=estimateVideoGenerationCost(request,pricing,{now});
 assert.equal(quote.available,true);
 assert.equal(quote.amount,0.9);
 assert.equal(quote.billableSeconds,6);
 assert.deepEqual(quote.breakdown,{video:0.72,audio:0.12,references:0.06,minimumApplied:0});
 assert.equal(quote.pricing.sourceUrl,"https://fal.ai/pricing");
 assert.equal(quote.estimated,true);
});

test("uses minimum charge when the computed amount is lower",()=>{
 const quote=estimateVideoGenerationCost({...request,durationSeconds:1,audioMode:"none",referenceImageCount:0},pricing,{now});
 assert.equal(quote.amount,0.5);
 assert.equal(quote.breakdown.minimumApplied,0.38);
});

test("never guesses pricing for an unknown provider/model or missing resolution rate",()=>{
 assert.equal(estimateVideoGenerationCost({...request,model:"another-model"},pricing,{now}).available,false);
 assert.equal(estimateVideoGenerationCost({...request,resolution:"1080p"},pricing,{now}).available,false);
 assert.equal(estimateVideoGenerationCost(request,[],{now}).available,false);
});

test("rejects expired or future-dated pricing schedules",()=>{
 const expired=[{...pricing[0],expiresAt:"2026-11-07T11:59:59.000Z"}];
 const future=[{...pricing[0],observedAt:"2026-11-07T12:00:01.000Z"}];
 assert.match(estimateVideoGenerationCost(request,expired,{now}).reason,/expired/);
 assert.match(estimateVideoGenerationCost(request,future,{now}).reason,/expired/);
});

test("rejects invalid requests and malformed pricing metadata",()=>{
 assert.equal(estimateVideoGenerationCost({...request,durationSeconds:181},pricing,{now}).available,false);
 assert.equal(estimateVideoGenerationCost({...request,referenceImageCount:13},pricing,{now}).available,false);
 const invalid=parseVideoPricingCatalog(JSON.stringify([{...pricing[0],sourceUrl:"http://insecure.test"}]));
 assert.equal(invalid.configured,false);
 assert.equal(invalid.rejectedCount,1);
});

test("parses only unique, bounded, source-attributed pricing records",()=>{
 const parsed=parseVideoPricingCatalog(JSON.stringify([...pricing,pricing[0]]));
 assert.equal(parsed.records.length,1);
 assert.equal(parsed.rejectedCount,1);
 assert.equal(parsed.configured,true);
 assert.equal(parseVideoPricingCatalog("not-json").configured,false);
 assert.equal(parseVideoPricingCatalog(JSON.stringify({})).configured,false);
});
