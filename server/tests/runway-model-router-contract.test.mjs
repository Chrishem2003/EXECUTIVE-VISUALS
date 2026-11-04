import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRunwayVideoRouterConfig,
  buildRunwayVideoRouterDryRun,
  readRunwayVideoRouterDryRun,
  readRunwayRouterRequestHistoryPage,
  matchRunwayRouterRequestToTask
} from "../runway-model-router-contract.mjs";

test("router policy uses a closed allowlist, hard credit ceiling and no capacity fallback",()=>{
  const policy=buildRunwayVideoRouterConfig({slug:"executive-visuals-preview",name:"Executive Visuals Preview",modelIds:["gen4.5"],maxCreditsPerGeneration:120,optimizeFor:"cost"});
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

test("video dry-run emits documented model-agnostic fields",()=>{
  const payload=buildRunwayVideoRouterDryRun({configId:"executive-visuals-preview",input:{
    promptText:"A cinematic sunrise",aspectRatio:"16:9",duration:5,resolution:"720p",audio:false
  }});
  assert.deepEqual(payload,{configId:"executive-visuals-preview",dryRun:true,input:{
    promptText:"A cinematic sunrise",aspectRatio:"16:9",duration:5,resolution:"720p",audio:false
  }});
});

test("video dry-run accepts only server-uploaded Runway reference images",()=>{
  const payload=buildRunwayVideoRouterDryRun({configId:"preview",input:{
    promptText:"A cinematic sunrise",
    referenceImages:[{uri:"runway://upload/abc123",role:"first"}]
  }});
  assert.deepEqual(payload.input.referenceImages,[{uri:"runway://upload/abc123",role:"first"}]);
  for(const referenceImages of [
    [{uri:"https://attacker.invalid/image.png"}],
    [{uri:"data:image/png;base64,AAAA"}],
    [{uri:"runway://upload/abc"}],
    [{uri:"runway://upload/abc",role:"middle"}],
    [{uri:"runway://upload/abc",role:"first",view:"front"}],
    [{uri:"runway://upload/abc",role:"extra"}],
    [{uri:"runway://upload/abc",extra:"no"}],
    []
  ]) assert.throws(()=>buildRunwayVideoRouterDryRun({configId:"preview",input:{promptText:"test",referenceImages}}));
});

test("video dry-run rejects unsupported fields, resolution and duration precision",()=>{
  for(const input of [
    {promptText:"test",model:"gen4.5"},
    {promptText:"test",resolution:"360p"},
    {promptText:"test",duration:5.5},
    {promptText:"test",duration:1},
    {promptText:"test",duration:31},
    {promptText:"test",seed:4294967296},
    {promptText:"test",contentModeration:{publicFigureThreshold:"strict"}},
    {promptText:"test",referenceVideos:[{uri:"runway://video/source",role:"source"}]},
    {promptText:"test",referenceAudio:[{uri:"runway://audio/ref"}]},
    {promptText:"test",keyframes:[{uri:"runway://image/keyframe",at:0.5}]}
  ]) assert.throws(()=>buildRunwayVideoRouterDryRun({configId:"preview",input}));
});

test("dry-run response exposes estimates but never settlement-eligible actual cost",()=>{
  const preview=readRunwayVideoRouterDryRun({routing:{
    model:"gen4.5",configId:"preview",resolvedSettings:{optimizeFor:"cost"},estimatedCost:{credits:60}
  }},{configId:"preview",maxApprovedCredits:100});
  assert.equal(preview.estimatedCredits,60);
  assert.equal(preview.evidenceType,"preflight_estimate");
  assert.equal(preview.billable,false);
  assert.equal(preview.settlementEligible,false);
});

test("dry-run rejects cost overrun, wrong router and incomplete metadata",()=>{
  const payload={routing:{model:"gen4.5",configId:"preview",resolvedSettings:{optimizeFor:"cost"},estimatedCost:{credits:101}}};
  assert.throws(()=>readRunwayVideoRouterDryRun(payload,{configId:"preview",maxApprovedCredits:100}),error=>error.code==="RUNWAY_ROUTER_BUDGET_EXCEEDED");
  assert.throws(()=>readRunwayVideoRouterDryRun(payload,{configId:"other",maxApprovedCredits:100}),error=>error.code==="RUNWAY_ROUTER_INVALID_RESPONSE");
  assert.throws(()=>readRunwayVideoRouterDryRun({routing:{...payload.routing,estimatedCost:undefined}},{configId:"preview",maxApprovedCredits:100}),error=>error.code==="RUNWAY_ROUTER_INVALID_RESPONSE");
});

test("router request history is task-correlatable but never settlement evidence",()=>{
  const page=readRunwayRouterRequestHistoryPage({
    data:[{
      id:"history-row",requestId:"request-123",status:"routed",model:"gen4.5",provider:"runway",
      estimatedCredits:60,taskId:"17f20503-6c24-4c16-946b-35dbbce2af2f",createdAt:"2026-11-04T12:00:00.000Z"
    }],
    hasMore:false,nextCursor:null
  });
  const match=matchRunwayRouterRequestToTask(page,{taskId:"17f20503-6c24-4c16-946b-35dbbce2af2f",requestId:"request-123"});
  assert.equal(match.model,"gen4.5");
  assert.equal(match.estimatedCredits,60);
  assert.equal(match.evidenceType,"router_request_history");
  assert.equal(match.billable,false);
  assert.equal(match.settlementEligible,false);
});

test("router history rejects malformed rows and ambiguous or missing task correlations",()=>{
  assert.throws(()=>readRunwayRouterRequestHistoryPage({data:[{requestId:"x"}],hasMore:false}),
    error=>error.code==="RUNWAY_ROUTER_INVALID_RESPONSE");
  const page=readRunwayRouterRequestHistoryPage({
    data:[
      {requestId:"a",status:"routed",model:"gen4.5",provider:"runway",estimatedCredits:60,taskId:"17f20503-6c24-4c16-946b-35dbbce2af2f",createdAt:"2026-11-04T12:00:00Z"},
      {requestId:"b",status:"routed",model:"gen4.5",provider:"runway",estimatedCredits:60,taskId:"17f20503-6c24-4c16-946b-35dbbce2af2f",createdAt:"2026-11-04T12:00:01Z"}
    ],hasMore:false
  });
  assert.throws(()=>matchRunwayRouterRequestToTask(page,{taskId:"17f20503-6c24-4c16-946b-35dbbce2af2f"}),
    error=>error.code==="RUNWAY_ROUTER_HISTORY_AMBIGUOUS");
  assert.throws(()=>matchRunwayRouterRequestToTask(page,{taskId:"27f20503-6c24-4c16-946b-35dbbce2af2f"}),
    error=>error.code==="RUNWAY_ROUTER_HISTORY_NOT_FOUND");
});

test("router rejects direct-model pixel ratio field and accepts model-agnostic aspect ratio",()=>{
  assert.throws(()=>buildRunwayVideoRouterDryRun({configId:"preview",input:{promptText:"test",ratio:"1280:720"}}),
    error=>error.code==="RUNWAY_ROUTER_INVALID_INPUT");
  assert.deepEqual(buildRunwayVideoRouterDryRun({configId:"preview",input:{promptText:"test",aspectRatio:"9:16"}}).input,
    {promptText:"test",aspectRatio:"9:16"});
});

test("router accepts the current duration, resolution, seed and moderation contract",()=>{
  for(const duration of [2,30]) {
    assert.equal(buildRunwayVideoRouterDryRun({configId:"preview",input:{promptText:"test",duration}}).input.duration,duration);
  }
  for(const resolution of ["480p","720p","1080p","4k"]) {
    assert.equal(buildRunwayVideoRouterDryRun({configId:"preview",input:{promptText:"test",resolution}}).input.resolution,resolution);
  }
  const payload=buildRunwayVideoRouterDryRun({configId:"preview",input:{promptText:"test",seed:4294967295,contentModeration:{publicFigureThreshold:"low"}}});
  assert.equal(payload.input.seed,4294967295);
  assert.deepEqual(payload.input.contentModeration,{publicFigureThreshold:"low"});
});

test("router reference images support first, last and reference roles with unique frame endpoints",()=>{
  const payload=buildRunwayVideoRouterDryRun({configId:"preview",input:{
    promptText:"test",referenceImages:[
      {uri:"runway://upload/first",role:"first"},
      {uri:"runway://upload/last",role:"last"},
      {uri:"runway://upload/ref1",role:"reference"},
      {uri:"runway://upload/ref2",role:"reference"}
    ]
  }});
  assert.equal(payload.input.referenceImages.length,4);
  assert.throws(()=>buildRunwayVideoRouterDryRun({configId:"preview",input:{promptText:"test",referenceImages:[
    {uri:"runway://upload/first1",role:"first"},{uri:"runway://upload/first2",role:"first"}
  ]}}),error=>error.code==="RUNWAY_ROUTER_INVALID_INPUT");
  assert.throws(()=>buildRunwayVideoRouterDryRun({configId:"preview",input:{promptText:"test",referenceImages:[
    {uri:"runway://upload/last1",role:"last"},{uri:"runway://upload/last2",role:"last"}
  ]}}),error=>error.code==="RUNWAY_ROUTER_INVALID_INPUT");
});