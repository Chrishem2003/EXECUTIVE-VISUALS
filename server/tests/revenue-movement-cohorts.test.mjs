import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const migration=await readFile(new URL("../../supabase/migrations/20261113120000_revenue_movement_cohort_intelligence_batch_39.sql",import.meta.url),"utf8");

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({
 supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
 flutterwaveClientId:"client-test",flutterwaveClientSecret:"client-secret-test",
 webhookSecretHash:"webhook-secret",billingEnabled:true,refundsEnabled:true,fetchImpl
});}

test("revenue movement intelligence requires a financial administrator",async()=>{
 let rpcCalled=false;
 const service=api(async url=>{
  if(String(url).includes("/platform_admins?"))return json([]);
  if(String(url).endsWith("/rpc/financial_revenue_movement_overview"))rpcCalled=true;
  throw new Error("Unexpected request: "+String(url));
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/revenue-movement",ownerId:owner});
 assert.equal(result.status,403);
 assert.equal(rpcCalled,false);
});

test("revenue movement endpoint returns the authorized currency-separated bridge and cohort curves",async()=>{
 const calls=[];
 const payload={
  comparison:{priorMonth:"2026-10-01",currentMonth:"2026-11-01",available:true},
  movement:[{currency:"UGX",openingMrrMinor:110000,newMrrMinor:40000,expansionMrrMinor:20000,contractionMrrMinor:0,churnMrrMinor:30000,closingMrrMinor:100000,reconciliationDeltaMinor:0}],
  cohorts:[{snapshotMonth:"2026-11-01",cohortMonth:"2026-10-01",currency:"UGX",baselineCustomers:2,activeCustomers:2,logoRetentionPct:100,baselineMrrMinor:110000,currentMrrMinor:100000,revenueRetentionPct:90.91}],
  limitations:["Missing snapshots are not interpolated."]
 };
 const service=api(async(url,options={})=>{
  const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/financial_revenue_movement_overview"))return json(payload);
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/revenue-movement",ownerId:owner});
 assert.equal(result.status,200);
 assert.deepEqual(result.body.movementIntelligence,payload);
 const rpc=calls.find(x=>x.target.endsWith("/rpc/financial_revenue_movement_overview"));
 assert.equal(rpc.body.p_actor_id,owner);
});

test("Batch 39 SQL reconciles MRR movements and labels observed cohort baselines",()=>{
 assert.match(migration,/financial_revenue_movement_overview/);
 assert.match(migration,/new_mrr_minor/);
 assert.match(migration,/expansion_mrr_minor/);
 assert.match(migration,/contraction_mrr_minor/);
 assert.match(migration,/churn_mrr_minor/);
 assert.match(migration,/reconciliationDeltaMinor/);
 assert.match(migration,/first observed snapshot/);
 assert.match(migration,/logoRetentionPct/);
 assert.match(migration,/revenueRetentionPct/);
 assert.match(migration,/snapshot_month desc limit 12/);
 assert.match(migration,/two latest consecutive, actually captured monthly snapshots/);
 assert.match(migration,/revoke all on function executive_visuals\.financial_revenue_movement_overview/);
 assert.match(migration,/grant execute on function executive_visuals\.financial_revenue_movement_overview/);
 const fn=migration.slice(migration.indexOf("create or replace function executive_visuals.financial_revenue_movement_overview"));
 assert.doesNotMatch(fn,/\binsert into\b|\bupdate\s+subscription_revenue_snapshots\b|\bdelete from\b/i);
});
