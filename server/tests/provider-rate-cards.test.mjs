import test from "node:test";
import assert from "node:assert/strict";
import {createFinancialIntelligenceApi} from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({
 supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
 flutterwaveClientId:"client-test",flutterwaveClientSecret:"client-secret-test",
 webhookSecretHash:"webhook-secret",billingEnabled:true,refundsEnabled:true,fetchImpl
});}
const rateCard={
 provider:"runway",model:"seedance-2.5",currency:"USD",rateCardVersion:"2026-11-10.1",
 billingUnit:"video_second",videoSecondMinor:30,effectiveFrom:"2026-11-10T00:00:00Z",
 sourceType:"provider_pricing",sourceReference:"official-pricing-page",
 sourceUrl:"https://dev.runway.com/pricing",sourceCheckedAt:"2026-11-10T10:00:00Z",
 sourceFingerprint:"a".repeat(64),verificationStatus:"source_linked",
 pricingDimensions:{referenceVideoSecondMinor:15,minGenerationMinor:80}
};
test("provider rate-card catalogue is admin-only and supports bounded filters",async()=>{
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized rate-card reads must not reach the catalogue RPC.");
 });
 const blocked=await denied.handle({method:"GET",path:"/api/admin/finance/model-rate-cards",ownerId:owner,query:{}});
 assert.equal(blocked.status,403);
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/ai_model_price_rate_card_catalog"))return json({rateCards:[{provider:"runway",model:"seedance-2.5"}],count:1,limitations:[]});
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/model-rate-cards",ownerId:owner,query:{provider:"Runway",model:"seedance-2.5",currency:"usd",limit:"25"}});
 assert.equal(result.status,200);
 assert.equal(result.body.catalog.count,1);
 assert.equal(calls.at(-1).body.p_provider,"runway");
 assert.equal(calls.at(-1).body.p_currency,"USD");
 assert.equal(calls.at(-1).body.p_limit,25);
});
test("provider rate-card creation validates source evidence and persists only through the admin RPC",async()=>{
 let rpcBody;
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized rate-card writes must not reach the database.");
 });
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/model-rate-cards",ownerId:owner,body:{rateCard}});
 assert.equal(blocked.status,403);
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/add_ai_model_price_rate_card")){
   rpcBody=JSON.parse(options.body);
   return json({id:"rate-card-id",provider:"runway",rateCardVersion:"2026-11-10.1"});
  }
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"POST",path:"/api/admin/finance/model-rate-cards",ownerId:owner,body:{rateCard:{...rateCard,sourceUrl:"http://insecure.example/pricing"}}});
 assert.equal(invalid.status,400);
 const result=await service.handle({method:"POST",path:"/api/admin/finance/model-rate-cards",ownerId:owner,body:{rateCard}});
 assert.equal(result.status,201);
 assert.equal(rpcBody.p_actor_id,owner);
 assert.equal(rpcBody.p_rate_card.provider,"runway");
 assert.equal(rpcBody.p_rate_card.verificationStatus,"source_linked");
 assert.equal(rpcBody.p_rate_card.pricingDimensions.referenceVideoSecondMinor,15);
});
test("provider rate-card endpoint rejects invalid filters, unlinked sources and invalid versions",async()=>{
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);
  throw new Error("Invalid inputs must be rejected before database writes.");
 });
 const invalidFilter=await service.handle({method:"GET",path:"/api/admin/finance/model-rate-cards",ownerId:owner,query:{limit:"900"}});
 assert.equal(invalidFilter.status,400);
 const missingEvidence=await service.handle({method:"POST",path:"/api/admin/finance/model-rate-cards",ownerId:owner,body:{rateCard:{...rateCard,sourceUrl:"",sourceCheckedAt:null}}});
 assert.equal(missingEvidence.status,400);
 const invalidVersion=await service.handle({method:"POST",path:"/api/admin/finance/model-rate-cards",ownerId:owner,body:{rateCard:{...rateCard,rateCardVersion:"bad version"}}});
 assert.equal(invalidVersion.status,400);
});
