import test from "node:test";
import assert from "node:assert/strict";
import {buildPublicSubscriptionCatalogue} from "../subscription-plan-catalogue.mjs";

const NOW=new Date("2026-11-22T08:00:00.000Z");
const plan=(overrides={})=>({
 id:"plan-professional-v2",plan_code:"professional",name:"Professional Creator",
 description:"For serious creators.",version:2,status:"active",is_public:true,billing_interval:"monthly",
 included_credits:0,credit_allowance_published:false,
 entitlements:{features:{videoGeneration:true,commercialUse:true},limits:{maxConcurrentJobs:3,maxProjects:10}},
 effective_from:"2026-11-01T00:00:00.000Z",effective_until:null,...overrides
});
const prices=[
 {plan_id:"plan-professional-v2",provider:"paddle",provider_price_id:"pri_01Professional",amount_minor:2900,currency:"USD",active:true},
 {plan_id:"plan-professional-v2",provider:"pesapal",provider_price_id:null,amount_minor:110000,currency:"UGX",active:true}
];
const build=(plans=[plan()],providerPrices=prices)=>buildPublicSubscriptionCatalogue({plans,providerPrices,now:()=>NOW});

test("publishes active public plans with validated provider prices but does not invent credit allowances",()=>{
 const [result]=build();
 assert.equal(result.planCode,"professional");
 assert.equal(result.version,2);
 assert.equal(result.prices.length,2);
 assert.deepEqual(result.checkoutProviders,["paddle","pesapal"]);
 assert.equal(result.includedCredits,null);
 assert.equal(result.creditAllowancePublished,false);
 assert.equal(Object.isFrozen(result.entitlements.features),true);
});

test("publishes included credits only when an explicit server-side approval flag is true",()=>{
 const [result]=build([plan({included_credits:1200,credit_allowance_published:true})]);
 assert.equal(result.includedCredits,1200);
 assert.equal(result.creditAllowancePublished,true);
});

test("filters inactive, private and not-yet-effective or expired plans",()=>{
 const results=build([
  plan(),
  plan({plan_code:"private",is_public:false}),
  plan({plan_code:"inactive",status:"inactive"}),
  plan({plan_code:"future",effective_from:"2026-12-01T00:00:00.000Z"}),
  plan({plan_code:"expired",effective_until:"2026-11-22T07:59:59.000Z"})
 ]);
 assert.deepEqual(results.map(row=>row.planCode),["professional"]);
});

test("a plan without active provider pricing remains visible but cannot offer checkout",()=>{
 const [result]=build([plan()],[{plan_id:"plan-professional-v2",provider:"paddle",provider_price_id:"pri_old",amount_minor:2900,currency:"USD",active:false}]);
 assert.deepEqual(result.checkoutProviders,[]);
 assert.deepEqual(result.prices,[]);
});

test("rejects duplicate versions, duplicate provider prices and malformed plans",()=>{
 assert.throws(()=>build([plan(),plan()]),{code:"SUBSCRIPTION_CATALOGUE_DUPLICATE"});
 assert.throws(()=>build([plan()],[...prices,prices[0]]),{code:"SUBSCRIPTION_CATALOGUE_DUPLICATE"});
 assert.throws(()=>build([plan({plan_code:"../../x"})]),{code:"SUBSCRIPTION_CATALOGUE_INVALID"});
 assert.throws(()=>build([plan({entitlements:[]})]),{code:"SUBSCRIPTION_CATALOGUE_INVALID"});
 assert.throws(()=>build([plan({included_credits:-1})]),{code:"SUBSCRIPTION_CATALOGUE_INVALID"});
});

test("validates provider price identifiers and currency contracts",()=>{
 assert.throws(()=>build([plan()],[{...prices[0],provider_price_id:"wrong"}]),{code:"SUBSCRIPTION_CATALOGUE_INVALID"});
 assert.throws(()=>build([plan()],[{...prices[1],currency:"USD"}]),{code:"SUBSCRIPTION_CATALOGUE_INVALID"});
 assert.throws(()=>build([plan()],[{...prices[0],amount_minor:0}]),{code:"SUBSCRIPTION_CATALOGUE_INVALID"});
});

test("ignores untrusted browser-shaped fields and keeps server records authoritative",()=>{
 const [result]=build([plan({included_credits:9000,credit_allowance_published:false,clientPrice:1,clientCredits:1,clientEntitlements:{features:{videoGeneration:false}}})]);
 assert.equal(result.includedCredits,null);
 assert.equal(result.entitlements.features.videoGeneration,true);
 assert.equal(result.prices[0].amountMinor,2900);
});

test("rejects malformed clock, missing references and unbounded catalogues",()=>{
 assert.throws(()=>buildPublicSubscriptionCatalogue({plans:[plan()],providerPrices:prices,now:()=>"not-a-date"}),{code:"SUBSCRIPTION_CATALOGUE_INVALID"});
 assert.throws(()=>build([plan({id:""})]),{code:"SUBSCRIPTION_CATALOGUE_INVALID"});
 assert.throws(()=>build([plan()],[{...prices[0],plan_id:""}]),{code:"SUBSCRIPTION_CATALOGUE_INVALID"});
 assert.throws(()=>build(new Array(1001).fill(plan()),[]),{code:"SUBSCRIPTION_CATALOGUE_INVALID"});
});
