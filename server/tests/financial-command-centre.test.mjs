import test from "node:test";
import assert from "node:assert/strict";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function service(fetchImpl){return createFinancialIntelligenceApi({
 supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
 flutterwaveClientId:"client-test",flutterwaveClientSecret:"client-secret-test",
 billingEnabled:true,fetchImpl
});}

test("financial command centre is role-gated and delegates aggregates to the database",async()=>{
 let rpcBody;
 const api=service(async(url,options={})=>{
  const target=String(url);
  if(target.includes("platform_admins"))return json([{role:"billing_admin"}]);
  if(target.includes("/rpc/admin_financial_command_centre")){rpcBody=JSON.parse(options.body);return json({
   byCurrency:[{currency:"UGX",grossRevenueMinor:100000,refundsMinor:5000,netRevenueMinor:95000,mrrMinor:25000,arrMinor:300000}],
   tiers:[{plan_code:"creator-monthly",active_subscriptions:1}],
   customerProfiles:[],riskIndicators:[],failedPaymentRecovery:{openAttempts:1},refunds:{pending:0},chargebacks:{open:0}
  });}
  throw new Error("Unexpected request: "+target);
 });
 const result=await api.handle({method:"GET",path:"/api/admin/finance/command-centre",ownerId:owner,query:{from:"2026-11-01",to:"2026-11-10"}});
 assert.equal(result.status,200);
 assert.equal(result.body.byCurrency[0].mrrMinor,25000);
 assert.equal(result.body.byCurrency[0].arrMinor,300000);
 assert.equal(rpcBody.p_actor_id,owner);
 assert.equal(rpcBody.p_from,"2026-11-01T00:00:00.000Z");
});

test("support role cannot access financial command centre",async()=>{
 const api=service(async url=>{
  if(String(url).includes("platform_admins"))return json([{role:"support"}]);
  throw new Error("No privileged query should run");
 });
 const result=await api.handle({method:"GET",path:"/api/admin/finance/command-centre",ownerId:owner});
 assert.equal(result.status,403);
 assert.equal(result.body.error.code,"FINANCE_ADMIN_REQUIRED");
});

test("customer financial profile is restricted to the selected owner and billing admins",async()=>{
 const urls=[];
 const api=service(async url=>{
  const target=String(url);urls.push(target);
  if(target.includes("platform_admins"))return json([{role:"owner"}]);
  return json([]);
 });
 const customer="22222222-2222-4222-8222-222222222222";
 const result=await api.handle({method:"GET",path:"/api/admin/finance/customer",ownerId:owner,query:{ownerId:customer}});
 assert.equal(result.status,200);
 assert.equal(result.body.customerId,customer);
 for(const target of urls.filter(x=>/payment_transactions|customer_subscriptions|payment_refunds|payment_attempts|chargeback_cases/.test(x)))assert.ok(target.includes("owner_id=eq."+customer));
});

test("financial exports are audited and bounded",async()=>{
 let auditArgs;
 const api=service(async(url,options={})=>{
  const target=String(url);
  if(target.includes("platform_admins"))return json([{role:"platform_admin"}]);
  if(target.includes("/payment_transactions?"))return json([{id:"payment-1",amount_minor:15000,currency:"UGX"}]);
  if(target.includes("/rpc/write_financial_admin_audit")){auditArgs=JSON.parse(options.body);return json("audit-id");}
  throw new Error("Unexpected request: "+target);
 });
 const result=await api.handle({method:"GET",path:"/api/admin/finance/export",ownerId:owner,query:{kind:"payments",limit:"5"}});
 assert.equal(result.status,200);
 assert.equal(result.body.rows.length,1);
 assert.equal(result.body.kind,"payments");
 assert.equal(auditArgs.p_action,"finance.export.payments");
});

test("Flutterwave settlement reconciliation paginates charges and compares local verified totals",async()=>{
 let recordedArgs,auditArgs;const providerCalls=[];
 const api=service(async(url,options={})=>{
  const target=String(url);providerCalls.push(target);
  if(target.includes("platform_admins"))return json([{role:"owner"}]);
  if(target==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token")return json({access_token:"provider-test-token",expires_in:600});
  if(target.includes("/settlements?page=1&size=100"))return json({data:[{id:"stm-batch12",currency:"UGX",charge_count:"2"}],meta:{page_info:{total_pages:1}}});
  if(target.includes("/settlements/stm-batch12?page=1&size=50"))return json({data:{id:"stm-batch12",currency:"UGX",gross_amount:1500,net_amount:1350,charge_count:"2",fees:[{type:"charge_fee",amount:150}],charges:[{id:"chg-one"}]},meta:{page_info:{total_pages:2}}});
  if(target.includes("/settlements/stm-batch12?page=2&size=50"))return json({data:{charges:[{id:"chg-two"}]},meta:{page_info:{total_pages:2}}});
  if(target.includes("payment_transactions?select=provider_transaction_id"))return json([
   {provider_transaction_id:"chg-one",amount_minor:1000,provider_fee_minor:100,currency:"UGX",status:"successful"},
   {provider_transaction_id:"chg-two",amount_minor:500,provider_fee_minor:50,currency:"UGX",status:"successful"}
  ]);
  if(target.includes("/rpc/record_flutterwave_settlement")){recordedArgs=JSON.parse(options.body);return json({currency:"UGX",exceptions:[]});}
  if(target.includes("/rpc/write_financial_admin_audit")){auditArgs=JSON.parse(options.body);return json("audit-id");}
  throw new Error("Unexpected request: "+target);
 });
 const result=await api.handle({method:"POST",path:"/api/admin/finance/settlements/reconcile",ownerId:owner,body:{from:"2026-11-01",to:"2026-11-10"}});
 assert.equal(result.status,200);
 assert.equal(result.body.checked,1);
 assert.equal(result.body.results[0].lineItemsComplete,true);
 assert.equal(result.body.results[0].localChargeMatch,true);
 assert.equal(recordedArgs.p_expected_gross_minor,1500);
 assert.equal(recordedArgs.p_expected_fees_minor,150);
 assert.equal(auditArgs.p_action,"finance.settlements.reconcile");
 assert.ok(providerCalls.some(url=>url.includes("page=2&size=50")));
});
