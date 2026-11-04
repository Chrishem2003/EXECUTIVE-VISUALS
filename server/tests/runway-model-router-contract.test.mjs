import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRunwayVideoRouterConfig,
  buildRunwayVideoRouterDryRun,
  readRunwayVideoRouterDryRun
} from "../runway-model-router-contract.mjs";

test("router policy uses a closed allowlist, hard credit ceiling and no capacity fallback",()=>{
  const policy=buildRunwayVideoRouterConfig({
    slug:"executive-visuals-preview",
    name:"Executive Visuals Preview",
    modelIds:["gen4.5"],
    maxCreditsPerGeneration:120,
    optimizeFor:"cost"
  });
  assert.equal(policy.slug,"executive-visuals-preview");
  assert.deepEqual(policy.settings.models,{mode:"allowlist_only",ids:["gen4.5"]});
  assert.deepEqual(policy.settings.maxCreditsPerGeneration,{video:120});
  assert.equal(policy.settings.schemaVersion,1);
  assert.equal(policy.settings.fallback.onCapacity,false);
  assert.ok(Object.isFrozen(policy.settings.models.ids));
});

test("router policy rejects open-ended, malformed or unbudgeted configurations",()=>{
  for(const input of [
    {slug:"Bad Slug",name:"x",modelIds:["gen4.5"],maxCreditsPerGeneration:100},
    {slug:"preview",name:"",modelIds:["gen4.5"],maxCreditsPerGeneration:100},
    {slug:"preview",name:"Preview",modelIds:[],maxCreditsPerGeneration:100},
    {slug:"preview",name:"Preview",modelIds:["gen4.5","gen4.5"],maxCreditsPerGeneration:100},
    {slug:"preview",name:"Preview",modelIds:["gen4.5"],maxCreditsPerGeneration:0},
    {slug:"preview",name:"Preview",modelIds:["gen4.5"],maxCreditsPerGeneration:100,optimizeFor:"magic"}
  ]) assert.throws(()=>buildRunwayVideoRouterConfig(input));
});

test("video dry-run payload is model-agnostic and explicitly non-billable",()=>{
  const payload=buildRunwayVideoRouterDryRun({
    configId:"executive-visuals-preview",
    input:{promptText:"A cinematic sunrise",aspectRatio:"16:9",duration:5,resolution:"720p",audio:false,seed:42}
  });
  assert.deepEqual(payload,{
    configId:"executive-visuals-preview",
    dryRun:true,
    input:{promptText:"A cinematic sunrise",aspectRatio:"16:9",duration:5,resolution:"720p",audio:false,seed:42}
  });
});

test("dry-run rejects browser-supplied asset URLs and unsupported input fields",()=>{
  assert.throws(()=>buildRunwayVideoRouterDryRun({
    configId:"preview",
    input:{promptText:"test",referenceImages:[{uri:"https://attacker.invalid/image.png"}]}
  }),error=>error.code==="RUNWAY_ROUTER_INVALID_INPUT");
  assert.throws(()=>buildRunwayVideoRouterDryRun({
    configId:"preview",
    input:{promptText:"test",model:"gen4.5"}
  }),error=>error.code==="RUNWAY_ROUTER_INVALID_INPUT");
  assert.throws(()=>buildRunwayVideoRouterDryRun({
    configId:"preview",
    input:{promptText:"test",duration:60}
  }));
});

test("dry-run response exposes estimated cost but never settlement-eligible actual cost",()=>{
  const preview=readRunwayVideoRouterDryRun({
    routing:{
      model:"gen4.5",provider:"runway",configId:"preview",
      resolvedSettings:{optimizeFor:"cost",priceCeiling:120},
      estimatedCost:{credits:60}
    }
  },{configId:"preview",maxApprovedCredits:100});
  assert.equal(preview.estimatedCredits,60);
  assert.equal(preview.evidenceType,"preflight_estimate");
  assert.equal(preview.billable,false);
  assert.equal(preview.settlementEligible,false);
});

test("dry-run rejects cost overrun, wrong router and incomplete metadata",()=>{
  const payload={routing:{model:"gen4.5",provider:"runway",configId:"preview",resolvedSettings:{optimizeFor:"cost"},estimatedCost:{credits:101}}};
  assert.throws(()=>readRunwayVideoRouterDryRun(payload,{configId:"preview",maxApprovedCredits:100}),
    error=>error.code==="RUNWAY_ROUTER_BUDGET_EXCEEDED");
  assert.throws(()=>readRunwayVideoRouterDryRun(payload,{configId:"other",maxApprovedCredits:100}),
    error=>error.code==="RUNWAY_ROUTER_INVALID_RESPONSE");
  assert.throws(()=>readRunwayVideoRouterDryRun({routing:{...payload.routing,estimatedCost:undefined}},
    {configId:"preview",maxApprovedCredits:100}),error=>error.code==="RUNWAY_ROUTER_INVALID_RESPONSE");
});
