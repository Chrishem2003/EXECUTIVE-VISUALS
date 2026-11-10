import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";

const migration = await readFile(new URL("../../supabase/migrations/20261119100000_financial_scenario_snapshots_batch_46.sql", import.meta.url), "utf8");
const integration = await readFile(new URL("../../scripts/financial-scenario-snapshots-postgres-integration-batch-46.sql", import.meta.url), "utf8");
const appSource = await readFile(new URL("../../src/platform/app.ts", import.meta.url), "utf8");
const owner = "11111111-1111-4111-8111-111111111111";
const input = {
  currency: "UGX", periodMonth: "2026-11-01", openingCashMinor: 5000000,
  monthlyRevenueMinor: 10000000, monthlyVariableCostMinor: 4000000,
  monthlyFixedCostMinor: 3000000, monthlyCapexMinor: 100000,
  assumptions: { revenueGrowthBps: 200, monthlyChurnBps: 100, collectionRateBps: 9500,
    discountRateBps: 100, horizonMonths: 12, evidenceMonths: 12,
    sourceCoverageBps: 9500, dataAgeDays: 12 }
};
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",billingEnabled:true,fetchImpl});}

test("verified scenario baseline is finance-admin protected and period validated",async()=>{
 let rpc=null;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/financial_scenario_baseline")){rpc=JSON.parse(options.body);return json({periodMonth:"2026-11-01",byCurrency:[{currency:"UGX",openingCashMinor:5000000,monthlyMrrMinor:10000000,monthlyDirectServiceCostMinor:400000,evidenceReferences:[{kind:"cash_position_snapshot",id:"cash-1"}]}],limitations:["MRR is not cash collected."]});}
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"GET",path:"/api/admin/finance/scenario-baseline",ownerId:owner,query:{periodMonth:"2026-11-10"}});
 assert.equal(invalid.status,400);assert.equal(rpc,null);
 const result=await service.handle({method:"GET",path:"/api/admin/finance/scenario-baseline",ownerId:owner,query:{periodMonth:"2026-11-01"}});
 assert.equal(result.status,200);assert.equal(rpc.p_actor_id,owner);assert.equal(rpc.p_period_month,"2026-11-01");
 assert.equal(result.body.baseline.byCurrency[0].monthlyMrrMinor,10000000);
 assert.match(result.body.baseline.limitations[0],/not cash collected/);
});

test("scenario snapshot read endpoint is finance-admin protected",async()=>{
 const service=api(async url=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized scenario request reached an RPC.");
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/scenarios",ownerId:owner});
 assert.equal(result.status,403);
});

test("scenario snapshot write endpoint is finance-admin protected",async()=>{
 const service=api(async url=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized scenario write reached an RPC.");
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/scenarios",ownerId:owner,body:{scenarioName:"November plan",input,idempotencyKey:"ev-scenario:unauthorized"}});
 assert.equal(result.status,403);
});

test("scenario snapshot input validation rejects malformed requests before persistence",async()=>{
 let rpcCalls=0;
 const service=api(async(url)=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.includes("/rpc/"))rpcCalls++;
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/scenarios",ownerId:owner,body:{scenarioName:"Bad currency",input:{...input,currency:"US"},idempotencyKey:"ev-scenario:bad0001"}});
 assert.equal(result.status,400);
 assert.equal(result.body.error.code,"FINANCIAL_SCENARIO_INPUT_INVALID");
 assert.equal(rpcCalls,0);
});

test("scenario snapshot write calculates server-side, binds authenticated actor and hashes stable content",async()=>{
 let persisted=null,audit=null;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.endsWith("/rpc/create_financial_scenario_snapshot")){
   persisted=JSON.parse(options.body);
   return json({snapshot:{id:"22222222-2222-4222-8222-222222222222",scenarioName:"November plan"},idempotentReplay:false});
  }
  if(target.endsWith("/rpc/write_financial_admin_audit")){audit=JSON.parse(options.body);return json(null);}
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/scenarios",ownerId:owner,body:{
  scenarioName:"November plan",input,idempotencyKey:"ev-scenario:unit-test-0001",
  evidenceReferences:["approved-budget-2026-11","cash-snapshot-001"]
 }});
 assert.equal(result.status,201);
 assert.equal(persisted.p_actor_id,owner);
 assert.equal(persisted.p_period_month,"2026-11-01");
 assert.equal(persisted.p_currency,"UGX");
 assert.equal(persisted.p_model_version,"deterministic_monthly_scenario_v1");
 assert.equal(persisted.p_evidence_references.length,2);
 assert.match(persisted.p_input_sha256,/^[0-9a-f]{64}$/);
 assert.equal(persisted.p_input_sha256,createHash("sha256").update(JSON.stringify({scenarioName:"November plan",input,evidenceReferences:["approved-budget-2026-11","cash-snapshot-001"]})).digest("hex"));
 assert.match(persisted.p_result_sha256,/^[0-9a-f]{64}$/);
 assert.equal(persisted.p_result_payload.base.rows.length,12);
 assert.equal(audit.p_action,"finance.scenario.snapshot.create");
 assert.equal(audit.p_actor_id,owner);
});

test("scenario snapshot list validates limits and binds actor to protected RPC",async()=>{
 let rpc=null;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/list_financial_scenario_snapshots")){rpc=JSON.parse(options.body);return json({snapshots:[],count:0,immutable:true});}
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"GET",path:"/api/admin/finance/scenarios",ownerId:owner,query:{limit:"101"}});
 assert.equal(invalid.status,400);
 assert.equal(rpc,null);
 const result=await service.handle({method:"GET",path:"/api/admin/finance/scenarios",ownerId:owner,query:{limit:"20"}});
 assert.equal(result.status,200);
 assert.equal(rpc.p_actor_id,owner);
 assert.equal(rpc.p_limit,20);
 assert.equal(result.body.immutable,true);
});

test("Batch 46 persistence migration enforces immutable, idempotent and finance-admin-only snapshots",()=>{
 assert.match(migration,/financial_scenario_snapshots/);
 assert.match(migration,/financial_scenario_baseline/);
 assert.match(migration,/subscription_revenue_snapshots/);
 assert.match(migration,/financial_cash_position_snapshots/);
 assert.match(migration,/financial_service_cost_events/);
 assert.match(migration,/enable row level security/i);
 assert.match(migration,/reject_financial_scenario_snapshot_mutation/);
 assert.match(migration,/unique\(actor_id,idempotency_key\)/);
 assert.match(migration,/input_sha256/);
 assert.match(migration,/result_sha256/);
 assert.match(migration,/grant execute on function executive_visuals\.create_financial_scenario_snapshot/);
 assert.match(migration,/grant execute on function executive_visuals\.list_financial_scenario_snapshots/);
 assert.match(integration,/idempotentReplay/);
 assert.match(integration,/different content/);
 assert.match(integration,/immutable/);
});

test("Financial Command Centre exposes real scenario controls and immutable evidence list",()=>{
 assert.match(appSource,/SCENARIO INTELLIGENCE · BATCH 46/);
 assert.match(appSource,/data-finance-scenario-save/);
 assert.match(appSource,/data-finance-scenario-refresh/);
 assert.match(appSource,/data-finance-scenario-baseline/);
 assert.match(appSource,/scenario-baseline\?periodMonth=/);
 assert.match(appSource,/\/api\/admin\/finance\/scenarios/);
 assert.match(appSource,/evidenceReferences/);
 assert.match(appSource,/scenarioSnapshots/);
});
