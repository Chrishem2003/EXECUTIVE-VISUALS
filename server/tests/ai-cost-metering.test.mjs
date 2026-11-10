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
