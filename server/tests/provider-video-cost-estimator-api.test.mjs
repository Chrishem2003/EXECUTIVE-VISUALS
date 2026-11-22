import test from "node:test";
import assert from "node:assert/strict";
import {createFinancialIntelligenceApi} from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({
 supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
 flutterwaveClientId:"client-test",flutterwaveClientSecret:"client-secret-test",
 webhookSecretHash:"webhook-secret",billingEnabled:true,fetchImpl
 });}
const row={
 provider:"runway",model:"seedance-2.5",currency:"USD",video_second_minor:68,
 effective_from:"2026-11-01T00:00:00Z",effective_to:null,
 rate_card_version:"2026-11-v1",billing_unit:"video_second",
 source_url:"https://dev.runway.com/pricing",source_checked_at:"2026-11-20T10:00:00Z",
 source_fingerprint:"a".repeat(64),verification_status:"source_linked",
 pricing_dimensions:{referenceVideoSecondMinor:34,minimumGenerationMinor:80}
};
const request={provider:"runway",model:"seedance-2.5",currency:"USD",rateCardVersion:"2026-11-v1",
 request:{outputSeconds:5,referenceVideoSeconds:2,resolution:"1080p"}};

test("model-specific estimates are admin-only and use the exact persisted rate-card version",async()=>{
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized estimate must not read provider rates.");
 });
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/model-rate-card-estimates",ownerId:owner,body:request});
 assert.equal(blocked.status,403);

 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url);calls.push(target);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.includes("/ai_model_price_catalog?"))return json([row]);
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/model-rate-card-estimates",ownerId:owner,
  body:{...request,videoSecondMinor:1,request:{...request.request,videoSecondMinor:1}}});
 assert.equal(result.status,200);
 assert.equal(result.body.estimate.estimatedProviderCostMinor,408);
 assert.equal(result.body.estimate.rateCardVersion,"2026-11-v1");
 assert.ok(calls.some(url=>url.includes("rate_card_version=eq.2026-11-v1")));
 assert.equal(calls.length,2);
});

test("model-specific estimates reject missing, ambiguous and unverified rate cards",async()=>{
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);
  if(String(url).includes("/ai_model_price_catalog?"))return json([]);
  throw new Error("Unexpected request: "+String(url));
 });
 const missing=await service.handle({method:"POST",path:"/api/admin/finance/model-rate-card-estimates",ownerId:owner,body:request});
 assert.equal(missing.status,404);
 const invalid=await service.handle({method:"POST",path:"/api/admin/finance/model-rate-card-estimates",ownerId:owner,body:{...request,rateCardVersion:"bad version"}});
 assert.equal(invalid.status,400);
 const ambiguous=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);
  if(String(url).includes("/ai_model_price_catalog?"))return json([row,{...row,rate_card_version:"2026-11-v2"}]);
  throw new Error("Unexpected request: "+String(url));
 });
 const duplicate=await ambiguous.handle({method:"POST",path:"/api/admin/finance/model-rate-card-estimates",ownerId:owner,body:request});
 assert.equal(duplicate.status,404);

});
