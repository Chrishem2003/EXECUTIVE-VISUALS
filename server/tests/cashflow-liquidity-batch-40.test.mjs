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
