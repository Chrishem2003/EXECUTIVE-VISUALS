import test from "node:test";
import assert from "node:assert/strict";
import {
 resolveSubscriptionEntitlements,evaluateSubscriptionEntitlement,evaluateSubscriptionLimit,
 assertSubscriptionEntitlement,assertSubscriptionLimit,createSubscriptionEntitlementReader
} from "../subscription-entitlements.mjs";

const NOW=new Date("2026-11-22T08:00:00.000Z");
const active=overrides=>({
 status:"active",plan_code:"professional",plan_version:2,
 current_period_end:"2026-12-22T00:00:00.000Z",cancel_at_period_end:false,
 entitlements_snapshot:{
  features:{videoGeneration:true,commercialUse:false,collaboration:true},
  limits:{maxConcurrentJobs:3,maxProjects:10,storageBytes:1073741824},
  providers:["runway","google"],models:["gen-4.5","gemini-omni-1.2"]
 },...overrides
});
const resolve=row=>resolveSubscriptionEntitlements(row,{now:()=>NOW});

test("resolves a valid active versioned subscription and freezes its server snapshot",()=>{
 const result=resolve(active({cancel_at_period_end:true}));
 assert.equal(result.active,true);
 assert.equal(result.planCode,"professional");
 assert.equal(result.planVersion,2);
 assert.equal(result.cancelAtPeriodEnd,true);
 assert.equal(result.expiresAt,"2026-12-22T00:00:00.000Z");
 assert.equal(Object.isFrozen(result.entitlements.features),true);
});

test("expired, pending, disputed, refunded and unknown subscriptions fail closed",()=>{
 for(const status of ["pending","past_due","canceled","expired","disputed","refunded","unknown",""]){
  assert.equal(resolve(active({status})).active,false,status);
 }
 assert.equal(resolve(active({current_period_end:"2026-11-22T08:00:00.000Z"})).active,false);
 assert.equal(resolve(active({current_period_end:null})).active,false);
});

test("missing, malformed, oversized or unversioned plan snapshots fail closed",()=>{
 assert.equal(resolve(active({plan_version:0})).active,false);
 assert.equal(resolve(active({plan_code:"../../bad"})).active,false);
 assert.equal(resolve(active({entitlements_snapshot:null})).active,false);
 assert.equal(resolve(active({entitlements_snapshot:[]})).active,false);
 assert.equal(resolve(active({entitlements_snapshot:{value:"x".repeat(17000)}})).active,false);
});

test("feature, provider, model and numeric entitlements are evaluated from the server snapshot",()=>{
 const result=resolve(active());
 assert.equal(evaluateSubscriptionEntitlement(result,{path:"features.videoGeneration"}).allowed,true);
 assert.equal(evaluateSubscriptionEntitlement(result,{path:"features.commercialUse"}).allowed,false);
 assert.equal(evaluateSubscriptionEntitlement(result,{path:"providers",requested:"google"}).allowed,true);
 assert.equal(evaluateSubscriptionEntitlement(result,{path:"models",requested:"unknown-model"}).allowed,false);
 assert.equal(evaluateSubscriptionEntitlement(result,{path:"limits.maxProjects",requested:10}).allowed,true);
 assert.equal(evaluateSubscriptionEntitlement(result,{path:"limits.maxProjects",requested:11}).allowed,false);
});

test("unknown paths and prototype traversal fail closed",()=>{
 const result=resolve(active());
 for(const path of ["features.unknown","__proto__","features.__proto__","constructor","features.constructor","limits.maxProjects.extra"]){
  assert.equal(evaluateSubscriptionEntitlement(result,{path}).allowed,false,path);
 }
});

test("concurrent usage limits enforce used plus requested without trusting the client",()=>{
 const result=resolve(active());
 assert.deepEqual(evaluateSubscriptionLimit(result,{name:"maxConcurrentJobs",used:1,requested:2}),{
  allowed:true,value:{limit:3,used:1,requested:2,remaining:0}
 });
 assert.equal(evaluateSubscriptionLimit(result,{name:"maxConcurrentJobs",used:2,requested:2}).allowed,false);
 assert.equal(evaluateSubscriptionLimit(result,{name:"unconfigured",used:0,requested:1}).allowed,false);
 assert.equal(evaluateSubscriptionLimit(result,{name:"maxProjects",used:-1,requested:1}).allowed,false);
});

test("assert helpers return validated values and expose stable denial codes",()=>{
 const result=resolve(active());
 assert.equal(assertSubscriptionEntitlement(result,{path:"features.videoGeneration"}),true);
 assert.equal(assertSubscriptionLimit(result,{name:"maxConcurrentJobs",used:0,requested:1}).limit,3);
 assert.throws(()=>assertSubscriptionEntitlement(result,{path:"features.commercialUse"}),{code:"SUBSCRIPTION_ENTITLEMENT_REQUIRED",status:403});
 assert.throws(()=>assertSubscriptionLimit(result,{name:"maxConcurrentJobs",used:3,requested:1}),{code:"SUBSCRIPTION_LIMIT_EXCEEDED",status:403});
});


const ownerId="123e4567-e89b-42d3-a456-426614174000";
const readerOptions={
 supabaseUrl:"https://project.supabase.co",serviceRoleKey:"server-role-secret",now:()=>NOW
};
const jsonResponse=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});

test("trusted entitlement reader scopes active subscription lookup to the authenticated owner",async()=>{
 let requestUrl="",requestHeaders;
 const reader=createSubscriptionEntitlementReader({...readerOptions,fetchImpl:async(url,options)=>{
  requestUrl=String(url);requestHeaders=options.headers;
  return jsonResponse([active()]);
 }});
 const result=await reader({ownerId});
 assert.equal(result.active,true);
 assert.ok(requestUrl.includes("owner_id=eq."+ownerId));
 assert.ok(requestUrl.includes("status=eq.active"));
 assert.ok(requestUrl.includes("limit=2"));
 assert.equal(requestHeaders.apikey,"server-role-secret");
 assert.equal(requestHeaders["accept-profile"],"executive_visuals");
 assert.equal(requestUrl.includes("server-role-secret"),false);
});

test("trusted entitlement reader denies missing and ambiguous active subscriptions",async()=>{
 const missing=createSubscriptionEntitlementReader({...readerOptions,fetchImpl:async()=>jsonResponse([])});
 assert.equal((await missing({ownerId})).active,false);
 const ambiguous=createSubscriptionEntitlementReader({...readerOptions,fetchImpl:async()=>jsonResponse([active(),active()])});
 await assert.rejects(()=>ambiguous({ownerId}),{code:"SUBSCRIPTION_RECORD_AMBIGUOUS",status:409});
});

test("trusted entitlement reader fails closed on database errors, invalid payloads and invalid owners",async()=>{
 const unavailable=createSubscriptionEntitlementReader({...readerOptions,fetchImpl:async()=>jsonResponse({message:"unavailable"},503)});
 await assert.rejects(()=>unavailable({ownerId}),{code:"SUBSCRIPTION_ENTITLEMENT_LOOKUP_UNAVAILABLE",status:503});
 const malformed=createSubscriptionEntitlementReader({...readerOptions,fetchImpl:async()=>jsonResponse({not:"an array"})});
 await assert.rejects(()=>malformed({ownerId}),{code:"SUBSCRIPTION_RECORD_AMBIGUOUS",status:409});
 let calls=0;
 const invalidOwner=createSubscriptionEntitlementReader({...readerOptions,fetchImpl:async()=>{calls++;return jsonResponse([]);}});
 await assert.rejects(()=>invalidOwner({ownerId:"not-a-uuid"}),{code:"SUBSCRIPTION_OWNER_INVALID",status:400});
 assert.equal(calls,0);
});
