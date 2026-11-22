import test from "node:test";
import assert from "node:assert/strict";
import {createFinancialIntelligenceApi} from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function service(fetchImpl){
 return createFinancialIntelligenceApi({
  supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
  flutterwaveClientId:"client-test",flutterwaveClientSecret:"client-secret-test",
  fetchImpl
 });
}

test("customer spend summary is owner-scoped and counts reserved work with settled actual usage",async()=>{
 const calls=[];
 const usage={
  periodStart:"2026-11-01T00:00:00.000Z",periodEnd:"2026-12-01T00:00:00.000Z",
  periodType:"subscription_period",subscriptionAmbiguous:false,
  allowance:1000,allowancePublished:true,settledCredits:420,reservedCredits:80,
  usedCredits:500,usagePercent:50,alertsEnabled:true,
  alerts:[{threshold:50,level:"notice",usedCredits:500,allowance:1000,usagePercent:50}],
  accountingBasis:"settled_actual_plus_active_reservations"
 };
 const api=service(async(url,options={})=>{
  const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});
  if(target.endsWith("/rpc/get_customer_credit_spend_summary"))return json(usage);
  throw new Error("Unexpected request: "+target);
 });
 const result=await api.handle({method:"GET",path:"/api/billing/credits/usage",ownerId:owner});
 assert.equal(result.status,200);
 assert.equal(result.body.usage.usedCredits,500);
 assert.equal(result.body.usage.settledCredits,420);
 assert.equal(result.body.usage.reservedCredits,80);
 assert.equal(result.body.usage.usagePercent,50);
 assert.equal(result.body.usage.alerts[0].threshold,50);
 assert.equal(calls.length,1);
 assert.equal(calls[0].body.p_owner_id,owner);
});

test("customer spend summary never activates alerts or invents an allowance for unpublished plan credits",async()=>{
 const api=service(async url=>{
  if(String(url).endsWith("/rpc/get_customer_credit_spend_summary"))return json({
   periodStart:"2026-11-01T00:00:00.000Z",periodEnd:"2026-12-01T00:00:00.000Z",
   periodType:"calendar_month",subscriptionAmbiguous:false,allowance:null,
   allowancePublished:false,settledCredits:900,reservedCredits:100,usedCredits:1000,
   usagePercent:null,alertsEnabled:false,alerts:[],
   accountingBasis:"settled_actual_plus_active_reservations"
  });
  throw new Error("Unexpected request: "+String(url));
 });
 const result=await api.handle({method:"GET",path:"/api/billing/credits/usage",ownerId:owner});
 assert.equal(result.status,200);
 assert.equal(result.body.usage.allowance,null);
 assert.equal(result.body.usage.allowancePublished,false);
 assert.equal(result.body.usage.alertsEnabled,false);
 assert.deepEqual(result.body.usage.alerts,[]);
 assert.equal(result.body.usage.usedCredits,1000);
});

test("customer spend summary rejects inconsistent ledger totals and malformed periods",async()=>{
 for(const mutate of [
  value=>({...value,usedCredits:499}),
  value=>({...value,periodEnd:"invalid"}),
  value=>({...value,allowance:0,allowancePublished:true}),
  value=>({...value,alerts:"not-an-array"})
 ]){
  const base={
   periodStart:"2026-11-01T00:00:00.000Z",periodEnd:"2026-12-01T00:00:00.000Z",
   periodType:"subscription_period",subscriptionAmbiguous:false,allowance:1000,
   allowancePublished:true,settledCredits:420,reservedCredits:80,usedCredits:500,
   usagePercent:50,alertsEnabled:true,alerts:[]
  };
  const api=service(async url=>{
   if(String(url).endsWith("/rpc/get_customer_credit_spend_summary"))return json(mutate(base));
   throw new Error("Unexpected request: "+String(url));
  });
  const result=await api.handle({method:"GET",path:"/api/billing/credits/usage",ownerId:owner});
  assert.notEqual(result.status,200);
 }
});
