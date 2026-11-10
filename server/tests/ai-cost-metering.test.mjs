import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGenAiUsage, parseProviderInvoiceCsv } from "../ai-cost-metering.mjs";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const importId="22222222-2222-4222-8222-222222222222";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",billingEnabled:true,fetchImpl});}

test("normalizes OpenTelemetry GenAI identity and billable token usage without retaining content",()=>{
 const event=normalizeGenAiUsage({
  attributes:{"gen_ai.provider.name":"openai","gen_ai.request.model":"gpt-test","gen_ai.response.model":"gpt-test-2026","gen_ai.operation.name":"chat"},
  usage:{billable_input_tokens:120,input_tokens:100,billable_output_tokens:40,output_tokens:35,currency:"USD",cost_minor:17},
  operationId:"op-123",idempotencyKey:"usage-key-0001"
 });
 assert.equal(event.provider,"openai");
 assert.equal(event.requestedModel,"gpt-test");
 assert.equal(event.responseModel,"gpt-test-2026");
 assert.equal(event.operation,"text");
 assert.equal(event.inputTokens,120);
 assert.equal(event.outputTokens,40);
 assert.equal(event.providerCostMinor,17);
 assert.equal(event.currency,"USD");
 assert.equal(Object.hasOwn(event,"prompt"),false);
});

test("usage normalization rejects negative and unsafe token counts",()=>{
 assert.throws(()=>normalizeGenAiUsage({provider:"openai",model:"m1",operation:"text",usage:{input_tokens:-1}}),{code:"AI_USAGE_VALUE_INVALID"});
 assert.throws(()=>normalizeGenAiUsage({provider:"openai",model:"m1",operation:"text",usage:{input_tokens:Number.MAX_SAFE_INTEGER+1}}),{code:"AI_USAGE_VALUE_INVALID"});
});

test("invoice CSV parser handles quoted commas, escaped quotes and embedded newlines",()=>{
 const csv='line_reference,model,operation,amount_minor,usage_period,usage_quantity,usage_unit\r\n"line,1","model ""A""",video,125,2026-11-01,2,seconds\r\nline-2,model-b,image,-25,2026-11-02,1,image';
 const lines=parseProviderInvoiceCsv(csv,{provider:"runway",currency:"USD"});
 assert.equal(lines.length,2);
 assert.equal(lines[0].lineReference,"line,1");
 assert.equal(lines[0].model,'model "A"');
 assert.equal(lines[0].amountMinor,125);
 assert.equal(lines[1].amountMinor,-25);
});

test("invoice CSV parser rejects missing columns, malformed quotes and excess lines",()=>{
 assert.throws(()=>parseProviderInvoiceCsv("id,amount\n1,2",{provider:"p",currency:"USD"}),{code:"AI_INVOICE_CSV_COLUMNS_INVALID"});
 assert.throws(()=>parseProviderInvoiceCsv('line_reference,model,operation,amount_minor,usage_period\n"x,m,video,1,2026-11-01',{provider:"p",currency:"USD"}),{code:"AI_INVOICE_CSV_INVALID"});
});

test("provider invoice import requires admin role and sends fingerprinted normalized lines",async()=>{
 const requests=[];
 const service=api(async(url,options={})=>{
  const target=String(url);requests.push({target,body:options.body?JSON.parse(options.body):null});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/import_ai_provider_invoice"))return json({importId,duplicate:false,lineCount:1,reconciliationStatus:"pending"});
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/ai-invoices/import",ownerId:owner,body:{
  provider:"runway",invoiceReference:"INV-2026-11",currency:"USD",periodStart:"2026-11-01",periodEnd:"2026-11-30",totalMinor:125,
  lines:[{lineReference:"line-1",model:"gen-4",operation:"video",amountMinor:125,usagePeriod:"2026-11-10"}]
 }});
 assert.equal(result.status,200);
 assert.equal(result.body.invoice.importId,importId);
 const rpc=requests.find(x=>x.target.endsWith("/rpc/import_ai_provider_invoice"));
 assert.equal(rpc.body.p_actor_id,owner);
 assert.equal(rpc.body.p_lines[0].provider,"runway");
 assert.match(rpc.body.p_source_fingerprint,/^[a-f0-9]{64}$/);
});

test("provider invoice reconciliation and anomaly routes are admin protected",async()=>{
 let rpcCalls=0;
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Admin RPC must not run");
 });
 const deniedResult=await denied.handle({method:"POST",path:"/api/admin/finance/ai-invoices/reconcile",ownerId:owner,body:{importId}});
 assert.equal(deniedResult.status,403);
 const allowed=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.endsWith("/rpc/reconcile_ai_provider_invoice")){rpcCalls++;return json({matched:1,unmatched:0});}
  if(target.endsWith("/rpc/ai_cost_anomaly_report")){rpcCalls++;return json({spendAnomalies:[],unpricedUsage:[],invoiceExceptions:[]});}
  throw new Error("Unexpected request: "+target);
 });
 const reconciled=await allowed.handle({method:"POST",path:"/api/admin/finance/ai-invoices/reconcile",ownerId:owner,body:{importId}});
 assert.equal(reconciled.status,200);
 const anomalies=await allowed.handle({method:"GET",path:"/api/admin/finance/ai-cost-anomalies",ownerId:owner});
 assert.equal(anomalies.status,200);
 assert.equal(rpcCalls,2);
});

test("AI cost intelligence reporting accepts a valid month and rejects malformed months",async()=>{
 let called=false;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/ai_cost_intelligence_overview")){called=true;return json({byProviderModel:[],byCustomer:[],unpricedEvents:0});}
  throw new Error("Unexpected request: "+target);
 });
 const bad=await service.handle({method:"GET",path:"/api/admin/finance/ai-cost-intelligence",ownerId:owner,body:{periodMonth:"not-a-month"}});
 assert.equal(bad.status,400);
 const good=await service.handle({method:"GET",path:"/api/admin/finance/ai-cost-intelligence",ownerId:owner,body:{periodMonth:"2026-11-01"}});
 assert.equal(good.status,200);
 assert.equal(called,true);
});


test("AI usage API maps GenAI attributes to a durable cost event",async()=>{
 let payload;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/record_ai_usage_cost_event")){
   payload=JSON.parse(options.body);
   return json({id:"usage-event",costBasis:"provider_reported",costMinor:17,currency:"USD"});
  }
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/ai-usage",ownerId:owner,body:{
  attributes:{"gen_ai.provider.name":"openai","gen_ai.request.model":"gpt-test","gen_ai.response.model":"gpt-test-2026","gen_ai.operation.name":"chat"},
  usage:{billable_input_tokens:120,billable_output_tokens:40,currency:"USD",cost_minor:17},
  operationId:"generation-123",ownerId:owner,idempotencyKey:"usage-event-key-001"
 }});
 assert.equal(result.status,200);
 assert.equal(payload.p_provider,"openai");
 assert.equal(payload.p_requested_model,"gpt-test");
 assert.equal(payload.p_response_model,"gpt-test-2026");
 assert.equal(payload.p_input_tokens,120);
 assert.equal(payload.p_output_tokens,40);
 assert.equal(payload.p_provider_cost_minor,17);
 assert.equal(payload.p_owner_id,owner);
});

test("AI usage API rejects invalid reporting month before calling the database",async()=>{
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  throw new Error("Invalid date must not reach financial RPC");
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/ai-cost-intelligence",ownerId:owner,body:{periodMonth:"2026-13-01"}});
 assert.equal(result.status,400);
});


test("verified invoice posting is finance-admin protected and binds the exact import ID",async()=>{
 let rpcBody=null;
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized ledger posting must not run");
 });
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/ai-invoices/post-to-ledger",ownerId:owner,body:{importId}});
 assert.equal(blocked.status,403);
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/post_verified_ai_invoice_to_service_cost_ledger")){
   rpcBody=JSON.parse(options.body);
   return json({importId,posted:3,idempotentReplays:0,sharedCostLines:1,totalMinor:900,currency:"USD",status:"posted_to_service_cost_ledger"});
  }
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"POST",path:"/api/admin/finance/ai-invoices/post-to-ledger",ownerId:owner,body:{importId:"bad"}});
 assert.equal(invalid.status,400);
 const result=await service.handle({method:"POST",path:"/api/admin/finance/ai-invoices/post-to-ledger",ownerId:owner,body:{importId}});
 assert.equal(result.status,200);
 assert.equal(rpcBody.p_actor_id,owner);
 assert.equal(rpcBody.p_import_id,importId);
 assert.equal(result.body.posting.posted,3);
});

test("profitability trend API validates bounded month ranges and is finance-admin protected",async()=>{
 let rpcBody=null;
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized trend query must not run");
 });
 const blocked=await denied.handle({method:"GET",path:"/api/admin/finance/profitability-trends",ownerId:owner,query:{months:"12"}});
 assert.equal(blocked.status,403);
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.endsWith("/rpc/financial_profitability_trend_report")){
   rpcBody=JSON.parse(options.body);return json({months:12,periods:[{currency:"USD",grossMarginPct:42.5}],limitations:[]});
  }
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"GET",path:"/api/admin/finance/profitability-trends",ownerId:owner,query:{months:"2"}});
 assert.equal(invalid.status,400);
 const result=await service.handle({method:"GET",path:"/api/admin/finance/profitability-trends",ownerId:owner,query:{months:"12"}});
 assert.equal(result.status,200);
 assert.equal(rpcBody.p_actor_id,owner);
 assert.equal(rpcBody.p_months,12);
 assert.equal(result.body.trends.periods[0].grossMarginPct,42.5);
});
