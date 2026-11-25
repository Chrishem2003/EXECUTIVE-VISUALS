import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";

const owner="77777777-7777-4777-8777-777777777777";
const job="11111111-1111-4111-8111-111111111111";
const usageId="22222222-2222-4222-8222-222222222222";
const invoiceId="33333333-3333-4333-8333-333333333333";
const lineId="44444444-4444-4444-8444-444444444444";
const reconId="55555555-5555-4555-8555-555555555555";
const costId="66666666-6666-4666-8666-666666666666";
const project="88888888-8888-4888-8888-888888888888";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({
  supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
  billingEnabled:true,flutterwaveClientId:"client-test",
  flutterwaveClientSecret:"client-secret-test",fetchImpl
});}
function sourceRows(){
 return {
  usages:[{id:usageId,job_id:job,owner_id:owner,project_id:project,provider:"runway",
   requested_model:"seedance-2.5",response_model:"seedance-2.5",operation:"video",status:"failed",
   currency:"USD",cost_minor:340,cost_basis:"provider_reported",invoice_line_reference:"line-001",
   period_month:"2026-11-01",occurred_at:"2026-11-20T12:00:00.000Z"}],
  links:[{id:"99999999-9999-4999-8999-999999999999",reconciliation_event_id:reconId,
   usage_event_id:usageId,service_cost_event_id:costId,owner_id:owner,project_id:project,
   job_id:job,provider:"runway",model:"seedance-2.5",operation:"video",currency:"USD",
   amount_minor:340,invoice_import_id:invoiceId,invoice_line_id:lineId}],
  imports:[{id:invoiceId,provider:"runway",invoice_reference:"inv-001",currency:"USD",
   total_minor:340,imported_line_count:1,matched_line_count:1,reconciliation_status:"matched",
   source_fingerprint:"a".repeat(64),imported_at:"2026-11-24T12:00:00.000Z"}],
  lines:[{id:lineId,import_id:invoiceId,provider_line_reference:"line-001",provider:"runway",
   model:"seedance-2.5",operation:"video",currency:"USD",amount_minor:340,
   matched_usage_event_id:usageId,match_status:"matched"}],
  reconciliations:[{id:reconId,invoice_import_id:invoiceId,invoice_line_id:lineId,
   usage_event_id:usageId,match_status:"matched",candidate_count:1,
   expected_amount_minor:340,observed_amount_minor:340,currency:"USD"}],
  costs:[{id:costId,period_month:"2026-11-01",owner_id:owner,cost_category:"video_generation",
   source_type:"provider_invoice",currency:"USD",amount_minor:340,entry_type:"expense",
   source_reference:"runway:inv-001:line-001",created_at:"2026-11-24T12:05:00.000Z"}]
 };
}

test("job-level cost evidence API is finance-admin-only",async()=>{
 const calls=[];
 const service=api(async(url)=>{calls.push(String(url));if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);throw new Error("Unauthorized financial source read.");});
 const result=await service.handle({method:"GET",path:"/api/admin/finance/job-cost-evidence-readiness",ownerId:owner,query:{jobId:job}});
 assert.equal(result.status,403);
 assert.equal(result.body.error.code,"FINANCIAL_ADMIN_REQUIRED");
 assert.equal(calls.length,1);
});

test("job-level cost evidence API validates a persisted job UUID before source queries",async()=>{
 const calls=[];
 const service=api(async(url)=>{calls.push(String(url));if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);throw new Error("Invalid job must not read financial sources.");});
 const result=await service.handle({method:"GET",path:"/api/admin/finance/job-cost-evidence-readiness",ownerId:owner,query:{jobId:"not-a-uuid"}});
 assert.equal(result.status,400);
 assert.equal(result.body.error.code,"JOB_COST_EVIDENCE_JOB_ID_INVALID");
 assert.equal(calls.length,1);
});

test("job-level evidence API loads exact invoice source chain and returns historical-only readiness",async()=>{
 const rows=sourceRows(),calls=[];
 const service=api(async(url)=>{
  const target=new URL(String(url));calls.push(target.pathname+target.search);
  const path=target.pathname;
  if(path.endsWith("/platform_admins"))return json([{role:"owner"}]);
  if(path.endsWith("/ai_usage_cost_events"))return json(rows.usages);
  if(path.endsWith("/financial_cost_attribution_links"))return json(rows.links);
  if(path.endsWith("/ai_provider_invoice_imports"))return json(rows.imports);
  if(path.endsWith("/ai_provider_invoice_lines"))return json(rows.lines);
  if(path.endsWith("/ai_provider_invoice_reconciliation_events"))return json(rows.reconciliations);
  if(path.endsWith("/financial_service_cost_events"))return json(rows.costs);
  throw new Error("Unexpected financial source request: "+target);
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/job-cost-evidence-readiness",ownerId:owner,query:{jobId:job}});
 assert.equal(result.status,200);
 assert.equal(result.body.readiness.providerCompute.status,"verified_historical_actual");
 assert.equal(result.body.readiness.providerCompute.amountMinor,340);
 assert.equal(result.body.readiness.fullyLoadedReady,false);
 assert.equal(result.body.readiness.dispatchEvidenceEligible,false);
 assert.equal(calls.length,7);
});

test("job-level evidence API is read-only and never invokes a posting or payment RPC",async()=>{
 const app=await readFile(new URL("../../server/financial-intelligence-api.mjs",import.meta.url),"utf8");
 const start=app.indexOf('path==="/api/admin/finance/job-cost-evidence-readiness"');
 const end=app.indexOf('path==="/api/admin/finance/job-cost-coverage"',start);
 const route=app.slice(start,end);
 assert.match(route,/method==="GET"/);
 assert.doesNotMatch(route,/method:"POST"|rpc\(|payment|credit_ledger|insert|PATCH/);
});
