import test from "node:test";
import assert from "node:assert/strict";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const billingAdmin="223e4567-e89b-42d3-a456-426614174000";
const requestId="323e4567-e89b-42d3-a456-426614174000";
function setup(role="owner"){
 const calls=[];
 const api=createFinancialIntelligenceApi({
  supabaseUrl:"https://finance-test.supabase.co",
  serviceRoleKey:"sb_secret_test_only",
  billingEnabled:true,
  fetchImpl:async(url,options={})=>{
   const target=new URL(url),method=options.method||"GET";
   calls.push({path:target.pathname,method,body:options.body?JSON.parse(options.body):null});
   if(target.pathname.endsWith("/platform_admins"))return new Response(JSON.stringify([{role}]),{status:200});
   if(target.pathname.endsWith("/subscription_financial_reconciliation_runs"))return new Response(JSON.stringify([{id:"423e4567-e89b-42d3-a456-426614174000",finding_count:1}]),{status:200});
   if(target.pathname.endsWith("/subscription_financial_remediation_requests"))return new Response(JSON.stringify([{id:requestId,status:"pending_approval"}]),{status:200});
   if(target.pathname.endsWith("/subscription_financial_remediation_events"))return new Response(JSON.stringify([]),{status:200});
   if(target.pathname.endsWith("/rpc/run_subscription_financial_reconciliation"))return new Response(JSON.stringify({runId:"423e4567-e89b-42d3-a456-426614174000",findingCount:0,mutationsApplied:false}),{status:200});
   if(target.pathname.endsWith("/rpc/get_subscription_financial_liability_summary"))return new Response(JSON.stringify({byCurrency:[{currency:"UGX",active_subscriptions:2,mrr_minor:29000}],creditUnits:{available:100,reserved:10,monetaryLiabilityCalculated:false}}),{status:200});
   if(target.pathname.endsWith("/rpc/request_subscription_financial_remediation"))return new Response(JSON.stringify({requestId,status:"pending_approval",replayed:false}),{status:200});
   if(target.pathname.endsWith("/rpc/decide_subscription_financial_remediation"))return new Response(JSON.stringify({requestId,status:"approved_for_manual_review",mutationsApplied:false}),{status:200});
   return new Response(JSON.stringify({}),{status:200});
  }
 });
 return {api,calls};
}
test("owner finance API returns durable reconciliation history and liability summaries",async()=>{
 const f=setup();
 const history=await f.api.handle({method:"GET",path:"/api/admin/finance/subscription-reconciliation",ownerId:owner});
 assert.equal(history.status,200);assert.equal(history.body.runs.length,1);
 const liabilities=await f.api.handle({method:"GET",path:"/api/admin/finance/subscription-liabilities",ownerId:owner});
 assert.equal(liabilities.status,200);assert.equal(liabilities.body.summary.byCurrency[0].currency,"UGX");
 assert.equal(liabilities.body.summary.creditUnits.monetaryLiabilityCalculated,false);
});
test("manual reconciliation enforces bounded limits and remains read-only",async()=>{
 const f=setup();
 const invalid=await f.api.handle({method:"POST",path:"/api/admin/finance/subscription-reconciliation/run",ownerId:owner,body:{limit:501}});
 assert.equal(invalid.status,400);
 const valid=await f.api.handle({method:"POST",path:"/api/admin/finance/subscription-reconciliation/run",ownerId:owner,body:{limit:100}});
 assert.equal(valid.status,200);assert.equal(valid.body.run.mutationsApplied,false);
 assert.ok(f.calls.some(x=>x.path.endsWith("/rpc/run_subscription_financial_reconciliation")));
});
test("billing administrators can view reports but cannot create owner remediation requests",async()=>{
 const f=setup("billing_admin");
 const result=await f.api.handle({method:"POST",path:"/api/admin/finance/subscription-remediations",ownerId:billingAdmin,body:{
  runId:"423e4567-e89b-42d3-a456-426614174000",findingIndex:0,
  proposedAction:"review_credit_grant",reason:"Review the missing subscription credit grant.",
  idempotencyKey:"batch147-test-request"
 }});
 assert.equal(result.status,403);
 assert.equal(f.calls.some(x=>x.path.endsWith("/rpc/request_subscription_financial_remediation")),false);
});
test("platform owner can request review and a different owner decision endpoint is exposed",async()=>{
 const f=setup();
 const created=await f.api.handle({method:"POST",path:"/api/admin/finance/subscription-remediations",ownerId:owner,body:{
  runId:"423e4567-e89b-42d3-a456-426614174000",findingIndex:0,
  proposedAction:"review_credit_grant",reason:"Review the missing subscription credit grant.",
  idempotencyKey:"batch147-test-request"
 }});
 assert.equal(created.status,201);assert.equal(created.body.automaticExecution,false);
 const decision=await f.api.handle({method:"POST",path:"/api/admin/finance/subscription-remediations/"+requestId+"/decision",ownerId:owner,body:{
  decision:"approve",reason:"Approve only an independent manual review of this finding."
 }});
 assert.equal(decision.status,200);assert.equal(decision.body.automaticExecution,false);
 assert.equal(decision.body.mutationsApplied,false);
});
