import test from "node:test";
import assert from "node:assert/strict";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({
 supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
 flutterwaveClientId:"client-test",flutterwaveClientSecret:"client-secret-test",
 webhookSecretHash:"webhook-secret",billingEnabled:true,refundsEnabled:true,fetchImpl
});}
const admin=async(url)=>String(url).includes("/platform_admins?")?json([{role:"billing_admin"}]):json({});

test("cashflow forecast requires a financial administrator",async()=>{
 let rpcCalled=false;
 const service=api(async url=>{if(String(url).includes("/platform_admins?"))return json([]);if(String(url).includes("/rpc/financial_cashflow_forecast_overview"))rpcCalled=true;throw new Error("Unexpected request "+url);});
 const result=await service.handle({method:"GET",path:"/api/admin/finance/cashflow-forecast",ownerId:owner});
 assert.equal(result.status,403);assert.equal(rpcCalled,false);
});

test("cashflow forecast returns scenario outputs from the protected RPC",async()=>{
 const payload={scenarios:[{currency:"ZZZ",scenario:"base",openingAvailableCashMinor:100000,positionAgeDays:1,horizons:[{days:30,projectedClosingMinor:90000,liquidityShortfall:false}],weekly:[]}],items:[],positions:[],limitations:["Restricted cash is excluded."]};
 const calls=[];
 const service=api(async(url,options={})=>{const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});if(target.includes("/platform_admins?"))return json([{role:"owner"}]);if(target.endsWith("/rpc/financial_cashflow_forecast_overview"))return json(payload);throw new Error("Unexpected request "+target);});
 const result=await service.handle({method:"GET",path:"/api/admin/finance/cashflow-forecast",ownerId:owner});
 assert.equal(result.status,200);assert.deepEqual(result.body.cashflowForecast,payload);
 assert.equal(calls.find(x=>x.target.endsWith("/rpc/financial_cashflow_forecast_overview")).body.p_actor_id,owner);
});

test("cash position rejects invalid evidence and never calls the RPC",async()=>{
 let called=false;
 const service=api(async url=>{if(String(url).includes("/platform_admins?"))return json([{role:"billing_admin"}]);if(String(url).includes("/rpc/"))called=true;throw new Error("Unexpected request "+url);});
 const result=await service.handle({method:"POST",path:"/api/admin/finance/cash-position",ownerId:owner,body:{currency:"US",availableCashMinor:-1,asOfDate:"tomorrow",sourceType:"unknown",sourceReference:"x",evidenceNote:"",idempotencyKey:"short"}});
 assert.equal(result.status,400);assert.equal(called,false);
});

test("cash position stores validated source-referenced cash balances",async()=>{
 const calls=[];
 const service=api(async(url,options={})=>{const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);if(target.endsWith("/rpc/record_financial_cash_position"))return json({id:"position-1",currency:"UGX",availableCashMinor:120000,restrictedCashMinor:10000});throw new Error("Unexpected request "+target);});
 const payload={currency:"UGX",availableCashMinor:120000,restrictedCashMinor:10000,asOfDate:new Date().toISOString().slice(0,10),sourceType:"bank_statement",sourceReference:"statement-2026-11",evidenceNote:"Reconciled bank statement balance",idempotencyKey:"cash-position-123"};
 const result=await service.handle({method:"POST",path:"/api/admin/finance/cash-position",ownerId:owner,body:payload});
 assert.equal(result.status,201);assert.equal(result.body.position.currency,"UGX");
 assert.deepEqual(calls.find(x=>x.target.endsWith("/rpc/record_financial_cash_position")).body,{p_actor_id:owner,p_payload:payload});
});

test("cashflow items reject invalid confidence and payment statuses",async()=>{
 const service=api(async url=>String(url).includes("/platform_admins?")?json([{role:"owner"}]):json({}));
 const result=await service.handle({method:"POST",path:"/api/admin/finance/cashflow-items",ownerId:owner,body:{direction:"outflow",currency:"USD",amountMinor:1000,expectedDate:new Date().toISOString().slice(0,10),confidenceBps:15000,status:"paid",sourceType:"payroll",sourceReference:"payroll-01",description:"Monthly payroll",idempotencyKey:"cashflow-item-123"}});
 assert.equal(result.status,400);
});

test("cashflow item stores a dated, confidence-weighted commitment",async()=>{
 const calls=[];
 const service=api(async(url,options={})=>{const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});if(target.includes("/platform_admins?"))return json([{role:"owner"}]);if(target.endsWith("/rpc/record_financial_cashflow_item"))return json({id:"item-1",direction:"inflow",currency:"UGX",amountMinor:50000,confidenceBps:7500});throw new Error("Unexpected request "+target);});
 const payload={direction:"inflow",currency:"UGX",amountMinor:50000,expectedDate:new Date().toISOString().slice(0,10),confidenceBps:7500,status:"committed",sourceType:"customer_receipt",sourceReference:"invoice-44",description:"Customer payment due",idempotencyKey:"cashflow-item-123"};
 const result=await service.handle({method:"POST",path:"/api/admin/finance/cashflow-items",ownerId:owner,body:payload});
 assert.equal(result.status,201);assert.equal(result.body.item.confidenceBps,7500);
 assert.deepEqual(calls.find(x=>x.target.endsWith("/rpc/record_financial_cashflow_item")).body,{p_actor_id:owner,p_payload:payload});
});

test("cashflow actuals require a finance administrator",async()=>{
 let rpcCalled=false;
 const service=api(async url=>{if(String(url).includes("/platform_admins?"))return json([]);if(String(url).includes("/rpc/"))rpcCalled=true;throw new Error("Unexpected request "+url);});
 const result=await service.handle({method:"POST",path:"/api/admin/finance/cashflow-actuals",ownerId:owner,body:{}});
 assert.equal(result.status,403);assert.equal(rpcCalled,false);
});

test("cashflow actuals reject malformed or future evidence before the RPC",async()=>{
 let rpcCalled=false;
 const service=api(async url=>{if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);if(String(url).includes("/rpc/"))rpcCalled=true;throw new Error("Unexpected request "+url);});
 const result=await service.handle({method:"POST",path:"/api/admin/finance/cashflow-actuals",ownerId:owner,body:{
  cashflowItemId:"not-a-uuid",amountMinor:-1,actualDate:"2099-01-01",sourceType:"unknown",
  sourceReference:"x",evidenceNote:"",idempotencyKey:"short"
 }});
 assert.equal(result.status,400);assert.equal(rpcCalled,false);
});

test("cashflow actuals persist validated partial settlement evidence",async()=>{
 const calls=[];
 const service=api(async(url,options={})=>{const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/record_financial_cashflow_actual"))return json({id:"actual-1",cashflowItemId:"22222222-2222-4222-8222-222222222222",amountMinor:25000});
  throw new Error("Unexpected request "+target);
 });
 const payload={cashflowItemId:"22222222-2222-4222-8222-222222222222",amountMinor:25000,actualDate:new Date().toISOString().slice(0,10),
  sourceType:"bank_statement",sourceReference:"bank-line-44",evidenceNote:"Part payment matched to invoice 44",idempotencyKey:"cashflow-actual-123"};
 const result=await service.handle({method:"POST",path:"/api/admin/finance/cashflow-actuals",ownerId:owner,body:payload});
 assert.equal(result.status,201);assert.equal(result.body.actual.amountMinor,25000);
 assert.deepEqual(calls.find(x=>x.target.endsWith("/rpc/record_financial_cashflow_actual")).body,{p_actor_id:owner,p_payload:payload});
});

test("cashflow reconciliation validates range and returns currency-separated variances",async()=>{
 const payload={fromDate:"2026-08-01",toDate:"2026-11-10",items:[],currencies:[{currency:"UGX",forecastAmountMinor:100000,actualAmountMinor:90000,favorableVarianceMinor:-10000}],limitations:[]};
 const calls=[];
 const service=api(async(url,options={})=>{const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.endsWith("/rpc/financial_cashflow_reconciliation"))return json(payload);
  throw new Error("Unexpected request "+target);
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/cashflow-reconciliation",ownerId:owner,query:{fromDate:payload.fromDate,toDate:payload.toDate}});
 assert.equal(result.status,200);assert.deepEqual(result.body.reconciliation,payload);
 assert.deepEqual(calls.find(x=>x.target.endsWith("/rpc/financial_cashflow_reconciliation")).body,{p_actor_id:owner,p_from_date:payload.fromDate,p_to_date:payload.toDate});
});

test("cashflow reconciliation rejects reversed or excessive date ranges",async()=>{
 let rpcCalled=false;
 const service=api(async url=>{if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);if(String(url).includes("/rpc/"))rpcCalled=true;throw new Error("Unexpected request "+url);});
 const result=await service.handle({method:"GET",path:"/api/admin/finance/cashflow-reconciliation",ownerId:owner,query:{fromDate:"2025-01-01",toDate:"2026-11-10"}});
 assert.equal(result.status,400);assert.equal(rpcCalled,false);
});

test("liquidity guardrails require finance administrator access",async()=>{
 let rpcCalled=false;
 const service=api(async url=>{if(String(url).includes("/platform_admins?"))return json([]);if(String(url).includes("/rpc/"))rpcCalled=true;throw new Error("Unexpected request "+url);});
 const result=await service.handle({method:"GET",path:"/api/admin/finance/liquidity-guardrails",ownerId:owner});
 assert.equal(result.status,403);assert.equal(rpcCalled,false);
});

test("liquidity policy rejects reserve below minimum floor",async()=>{
 let rpcCalled=false;
 const service=api(async url=>{if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);if(String(url).includes("/rpc/"))rpcCalled=true;throw new Error("Unexpected request "+url);});
 const result=await service.handle({method:"POST",path:"/api/admin/finance/liquidity-policies",ownerId:owner,body:{
  currency:"UGX",minimumCashFloorMinor:100000,reserveTargetMinor:90000,effectiveFrom:new Date().toISOString().slice(0,10),
  sourceReference:"board-policy-01",rationale:"Minimum liquidity protection",idempotencyKey:"liquidity-policy-01"
 }});
 assert.equal(result.status,400);assert.equal(rpcCalled,false);
});

test("liquidity policy stores validated effective-dated guardrails",async()=>{
 const calls=[];
 const service=api(async(url,options={})=>{const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/record_financial_liquidity_policy"))return json({id:"policy-1",currency:"UGX",minimumCashFloorMinor:100000,reserveTargetMinor:250000});
  throw new Error("Unexpected request "+target);
 });
 const payload={currency:"UGX",minimumCashFloorMinor:100000,reserveTargetMinor:250000,effectiveFrom:new Date().toISOString().slice(0,10),
  sourceReference:"board-policy-01",rationale:"Protect payroll and essential operating liquidity",idempotencyKey:"liquidity-policy-01"};
 const result=await service.handle({method:"POST",path:"/api/admin/finance/liquidity-policies",ownerId:owner,body:payload});
 assert.equal(result.status,201);assert.equal(result.body.policy.reserveTargetMinor,250000);
 assert.deepEqual(calls.find(x=>x.target.endsWith("/rpc/record_financial_liquidity_policy")).body,{p_actor_id:owner,p_payload:payload});
});

test("liquidity guardrails returns policy and scenario headroom",async()=>{
 const payload={policies:[{currency:"UGX",minimumCashFloorMinor:100000,reserveTargetMinor:250000}],scenarios:[{currency:"UGX",scenario:"base",lowestHeadroomMinor:-50000,firstFloorBreachDate:"2026-12-01"}],limitations:[]};
 const service=api(async url=>String(url).includes("/platform_admins?")?json([{role:"owner"}]):String(url).endsWith("/rpc/financial_liquidity_guardrails_overview")?json(payload):json({}));
 const result=await service.handle({method:"GET",path:"/api/admin/finance/liquidity-guardrails",ownerId:owner});
 assert.equal(result.status,200);assert.deepEqual(result.body.guardrails,payload);
});

test("liquidity policy rejects malformed effective dates",async()=>{
 let rpcCalled=false;
 const service=api(async url=>{if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);if(String(url).includes("/rpc/"))rpcCalled=true;throw new Error("Unexpected request "+url);});
 const result=await service.handle({method:"POST",path:"/api/admin/finance/liquidity-policies",ownerId:owner,body:{
  currency:"UGX",minimumCashFloorMinor:0,reserveTargetMinor:100000,effectiveFrom:"not-a-date",
  sourceReference:"board-policy-02",rationale:"Minimum liquidity policy",idempotencyKey:"liquidity-policy-02"
 }});
 assert.equal(result.status,400);assert.equal(rpcCalled,false);
});

test("liquidity guardrails returns forbidden for non-admin users",async()=>{
 let rpcCalled=false;
 const service=api(async url=>{if(String(url).includes("/platform_admins?"))return json([{role:"support_agent"}]);if(String(url).includes("/rpc/"))rpcCalled=true;throw new Error("Unexpected request "+url);});
 const result=await service.handle({method:"GET",path:"/api/admin/finance/liquidity-guardrails",ownerId:owner});
 assert.equal(result.status,403);assert.equal(rpcCalled,false);
});
