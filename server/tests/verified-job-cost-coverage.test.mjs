import {readFile} from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import {createFinancialIntelligenceApi} from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({
  supabaseUrl:"https://project.supabase.co",
  serviceRoleKey:"service-role-test",
  flutterwaveClientId:"client-test",
  flutterwaveClientSecret:"client-secret-test",
  fetchImpl
});}

test("verified job cost coverage is finance-admin-only",async()=>{
  const calls=[];
  const service=api(async(url)=>{calls.push(String(url));if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);throw new Error("Unauthorized caller must not read financial coverage.");});
  const result=await service.handle({method:"GET",path:"/api/admin/finance/job-cost-coverage",ownerId:owner,query:{periodMonth:"2026-11-01"}});
  assert.equal(result.status,403);
  assert.equal(result.body.error.code,"FINANCIAL_ADMIN_REQUIRED");
  assert.equal(calls.length,1);
});

test("verified job cost coverage validates month and bounded page size before calling the report RPC",async()=>{
  let rpcCalled=false;
  const service=api(async(url)=>{if(String(url).includes("/platform_admins?"))return json([{role:"billing_admin"}]);if(String(url).endsWith("/rpc/get_verified_job_cost_coverage"))rpcCalled=true;throw new Error("Unexpected request: "+String(url));});
  const badMonth=await service.handle({method:"GET",path:"/api/admin/finance/job-cost-coverage",ownerId:owner,query:{periodMonth:"2026-11-02"}});
  assert.equal(badMonth.status,400);
  assert.equal(badMonth.body.error.code,"JOB_COST_COVERAGE_PERIOD_INVALID");
  const badLimit=await service.handle({method:"GET",path:"/api/admin/finance/job-cost-coverage",ownerId:owner,query:{periodMonth:"2026-11-01",limit:"101"}});
  assert.equal(badLimit.status,400);
  assert.equal(badLimit.body.error.code,"JOB_COST_COVERAGE_LIMIT_INVALID");
  assert.equal(rpcCalled,false);
});

test("verified job cost coverage calls the read-only report with authenticated actor and returns revenue gate",async()=>{
  const calls=[];
  const payload={periodMonth:"2026-11-01",totalJobs:1,returnedJobs:1,rows:[{
    job_id:"22222222-2222-4222-8222-222222222222",currency:"USD",
    actual_provider_cost_minor:680,credits_debited:120,
    evidence_status:"cost_and_credit_evidence_available",
    profitability_status:"revenue_allocation_required",
    recognized_revenue_minor:null,gross_margin_pct:null
  }],revenueAllocationAvailable:false,profitabilityAvailable:false,blockedReason:"verified_revenue_allocation_not_available"};
  const service=api(async(url,options={})=>{
    const target=String(url);calls.push({target,method:options.method||"GET",body:options.body?JSON.parse(options.body):null});
    if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
    if(target.endsWith("/rpc/get_verified_job_cost_coverage"))return json(payload);
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handle({method:"GET",path:"/api/admin/finance/job-cost-coverage",ownerId:owner,query:{periodMonth:"2026-11-01",limit:"25"}});
  assert.equal(result.status,200);
  assert.equal(result.body.coverage.profitabilityAvailable,false);
  assert.equal(result.body.coverage.rows[0].recognized_revenue_minor,null);
  assert.equal(calls.length,2);
  assert.equal(calls[1].method,"POST");
  assert.equal(calls[1].body.p_actor_id,owner);
  assert.equal(calls[1].body.p_period_month,"2026-11-01");
  assert.equal(calls[1].body.p_limit,25);
});

test("coverage migration requires invoice-backed matches and never converts credits into revenue",async()=>{
  const sql=await readFile(new URL("../../supabase/migrations/20261122170000_verified_job_cost_coverage_batch_70.sql",import.meta.url),"utf8");
  assert.match(sql,/ai_provider_invoice_reconciliation_events/);
  assert.match(sql,/e\.match_status='matched'/);
  assert.match(sql,/having count\(r\.id\)=i\.imported_line_count/);
  assert.match(sql,/count\(\*\) filter\(where r\.match_status<>'matched'\)=0/);
  assert.match(sql,/billing_credit_reservations/);
  assert.match(sql,/state='settled'/);
  assert.match(sql,/negative_invoice_line_count/);
  assert.match(sql,/negative_invoice_adjustment_review/);
  assert.match(sql,/recognized_revenue_minor/);
  assert.match(sql,/revenue_allocation_required/);
  assert.match(sql,/profitabilityAvailable',false/);
  assert.match(sql,/revoke all on function executive_visuals\.get_verified_job_cost_coverage/);
  assert.match(sql,/grant execute on function executive_visuals\.get_verified_job_cost_coverage/);
});
