import test from "node:test";
import assert from "node:assert/strict";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl,options={}){return createFinancialIntelligenceApi({
 supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
 billingEnabled:true,fetchImpl,...options
});}
test("subscription customer economics is restricted to financial administrators",async()=>{
 const service=api(async url=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Non-admin request reached economics report RPC.");
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/subscription-economics",ownerId:owner});
 assert.equal(result.status,403);
});
test("subscription economics validates month boundaries and row limits before querying",async()=>{
 let calls=0;
 const service=api(async url=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/subscription_customer_economics_report")){calls++;return json({periodMonth:"2026-11-01",customers:[],byCurrency:[]});}
  throw new Error("Unexpected request: "+target);
 });
 const invalidMonth=await service.handle({method:"GET",path:"/api/admin/finance/subscription-economics",ownerId:owner,query:{periodMonth:"2026-11-02"}});
 const invalidLimit=await service.handle({method:"GET",path:"/api/admin/finance/subscription-economics",ownerId:owner,query:{periodMonth:"2026-11-01",limit:"1001"}});
 const invalidDate=await service.handle({method:"GET",path:"/api/admin/finance/subscription-economics",ownerId:owner,query:{periodMonth:"2026-99-01"}});
 assert.equal(invalidMonth.status,400);
 assert.equal(invalidLimit.status,400);
 assert.equal(invalidDate.status,400);
 assert.equal(calls,0);
});
test("subscription economics calls the period-scoped report and returns its evidence limitations",async()=>{
 let rpc;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.endsWith("/rpc/subscription_customer_economics_report")){
   rpc=JSON.parse(options.body);
   return json({periodMonth:"2026-11-01",customers:[{ownerId:owner,mrrMinor:12000,directCostMinor:5000,contributionMinor:7000,grossMarginPct:58.33,cashCollectedMinor:12000,refundedMinor:2000,netCashCollectedMinor:10000,creditsConsumed:300}],byCurrency:[{currency:"UGX",paidCustomers:1}],limitations:["MRR is not cash collected."]});
  }
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/subscription-economics",ownerId:owner,query:{periodMonth:"2026-11-01",limit:"50"}});
 assert.equal(result.status,200);
 assert.equal(rpc.p_actor_id,owner);
 assert.equal(rpc.p_period_month,"2026-11-01");
 assert.equal(rpc.p_limit,50);
 assert.equal(result.body.economics.customers[0].grossMarginPct,58.33);
 assert.equal(result.body.economics.customers[0].netCashCollectedMinor,10000);
 assert.equal(result.body.economics.limitations[0],"MRR is not cash collected.");
});
