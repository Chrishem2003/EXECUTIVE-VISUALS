import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";

const migration = await readFile(new URL("../../supabase/migrations/20261118100000_customer_lifetime_acquisition_economics_batch_45.sql", import.meta.url), "utf8");
const appSource = await readFile(new URL("../../src/platform/app.ts", import.meta.url), "utf8");
const owner = "11111111-1111-4111-8111-111111111111";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",billingEnabled:true,fetchImpl});}

test("customer lifetime economics is restricted to finance administrators",async()=>{
 const service=api(async url=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized request reached the LTV report RPC.");
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/customer-lifetime-acquisition-economics",ownerId:owner});
 assert.equal(result.status,403);
});

test("customer lifetime economics validates reporting month and model bounds before querying",async()=>{
 let rpcCalls=0;
 const service=api(async url=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/customer_lifetime_acquisition_economics_report")){rpcCalls++;return json({customers:[]});}
  throw new Error("Unexpected request: "+target);
 });
 const invalidMonth=await service.handle({method:"GET",path:"/api/admin/finance/customer-lifetime-acquisition-economics",ownerId:owner,query:{periodMonth:"2026-11-02"}});
 const invalidDiscount=await service.handle({method:"GET",path:"/api/admin/finance/customer-lifetime-acquisition-economics",ownerId:owner,query:{periodMonth:"2026-11-01",discountRateBps:"5001"}});
 const invalidHorizon=await service.handle({method:"GET",path:"/api/admin/finance/customer-lifetime-acquisition-economics",ownerId:owner,query:{periodMonth:"2026-11-01",horizonMonths:"61"}});
 assert.equal(invalidMonth.status,400);
 assert.equal(invalidDiscount.status,400);
 assert.equal(invalidHorizon.status,400);
 assert.equal(rpcCalls,0);
});

test("customer lifetime economics binds actor, month, discount and horizon to the report RPC",async()=>{
 let rpc;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.endsWith("/rpc/customer_lifetime_acquisition_economics_report")){
   rpc=JSON.parse(options.body);
   return json({periodMonth:"2026-11-01",discountRateBps:125,projectionHorizonMonths:24,
    byCurrency:[{currency:"UGX",realizedContributionToDateMinor:180000,predictedLifetimeContributionMinor:240000}],
    campaigns:[{channel:"search_ads",campaign:"launch-q4",cacMinor:50000}],
    limitations:["Retention is measured from consecutive monthly snapshots."]});
  }
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/customer-lifetime-acquisition-economics",ownerId:owner,
  query:{periodMonth:"2026-11-01",discountRateBps:"125",horizonMonths:"24"}});
 assert.equal(result.status,200);
 assert.equal(rpc.p_actor_id,owner);
 assert.equal(rpc.p_period_month,"2026-11-01");
 assert.equal(rpc.p_discount_rate_bps,125);
 assert.equal(rpc.p_horizon_months,24);
 assert.equal(result.body.economics.campaigns[0].cacMinor,50000);
 assert.match(result.body.economics.limitations[0],/consecutive monthly snapshots/);
});

test("Batch 45 SQL uses observed contribution, exact campaign attribution and discounted retention",()=>{
 assert.match(migration,/from subscription_revenue_snapshots/);
 assert.match(migration,/from financial_service_cost_events/);
 assert.match(migration,/from customer_acquisition_spend_events/);
 assert.match(migration,/from customer_acquisition_attributions/);
 assert.match(migration,/following\.snapshot_month=\(prior\.snapshot_month\+interval '1 month'\)::date/);
 assert.match(migration,/power\(b\.retention_rate::numeric,g\.n::numeric\)/);
 assert.match(migration,/discountRateBps/);
 assert.match(migration,/attributionCoverage/);
 assert.match(migration,/actualPaybackMonth/);
 assert.match(migration,/growthQuality/);
 assert.match(migration,/revoke all on function executive_visuals\.customer_lifetime_acquisition_economics_report/);
 assert.match(migration,/grant execute on function executive_visuals\.customer_lifetime_acquisition_economics_report/);
 const report=migration.slice(migration.indexOf("create or replace function executive_visuals.customer_lifetime_acquisition_economics_report"));
 assert.doesNotMatch(report,/\binsert into\b|\bupdate\b|\bdelete from\b/i);
});

test("Financial Command Centre exposes working Batch 45 model controls and evidence states",()=>{
 assert.match(appSource,/CUSTOMER LIFETIME & ACQUISITION ECONOMICS · BATCH 45/);
 assert.match(appSource,/finance-lifetime-discount/);
 assert.match(appSource,/finance-lifetime-horizon/);
 assert.match(appSource,/data-finance-lifetime-refresh/);
 assert.match(appSource,/customer-lifetime-acquisition-economics\?periodMonth=/);
 assert.match(appSource,/predictedLifetimeContributionMinor/);
 assert.match(appSource,/actualPaybackMonth/);
 assert.match(appSource,/growthQuality/);
 assert.match(appSource,/forecastConfidence/);
});
