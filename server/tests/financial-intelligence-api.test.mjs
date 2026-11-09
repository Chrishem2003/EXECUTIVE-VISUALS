import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";
import { createFlutterwaveAccessTokenProvider } from "../flutterwave-auth.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const paymentId="22222222-2222-4222-8222-222222222222";
const refundId="33333333-3333-4333-8333-333333333333";
const secret="webhook-secret";

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl,options={}) {
  return createFinancialIntelligenceApi({
    supabaseUrl:"https://project.supabase.co",
    serviceRoleKey:"service-role-test",
    flutterwaveClientId:"client-test",
    flutterwaveClientSecret:"client-secret-test",
    webhookSecretHash:secret,
    billingEnabled:true,
    refundsEnabled:true,
    fetchImpl,
    ...options
  });
}

test("billing endpoints fail closed when billing is disabled",async()=>{
  const service=api(async()=>{throw new Error("must not call network");},{billingEnabled:false});
  const result=await service.handle({method:"GET",path:"/api/billing/transactions",ownerId:owner});
  assert.equal(result.status,503);
  assert.equal(result.body.error.code,"BILLING_DISABLED");
});

test("customer transaction history is scoped to the authenticated owner",async()=>{
  let requestUrl="",requestHeaders={};
  const service=api(async(url,options={})=>{
    requestUrl=String(url);requestHeaders=options.headers||{};
    return json([{id:paymentId,status:"successful",amount_minor:10000,currency:"UGX"}]);
  });
  const result=await service.handle({method:"GET",path:"/api/billing/transactions",ownerId:owner,query:{limit:"10",offset:"0"}});
  assert.equal(result.status,200);
  assert.equal(result.body.transactions.length,1);
  assert.ok(requestUrl.includes("owner_id=eq."+owner));
  assert.ok(requestUrl.includes("limit=10"));
  assert.equal(requestHeaders["accept-profile"],"executive_visuals");
});

test("refund initiation requires billing admin authorization",async()=>{
  const service=api(async(url)=>{
    if(String(url).includes("platform_admins"))return json([{role:"support"}]);
    throw new Error("payment lookup must not happen for support role");
  });
  const result=await service.handle({
    method:"POST",path:"/api/admin/finance/refunds",ownerId:owner,
    body:{paymentTransactionId:paymentId,amountMinor:1000,reason:"Customer request"},
    idempotencyKey:"refund-key-0001"
  });
  assert.equal(result.status,403);
  assert.equal(result.body.error.code,"FINANCE_ADMIN_REQUIRED");
});

test("v4 webhook rejects invalid signatures before writing event records",async()=>{
  let calls=0;
  const service=api(async()=>{calls++;return json([]);});
  const rawBody=Buffer.from('{"event":"refund.updated","data":{"id":"rfd_test","status":"succeeded"}}');
  const result=await service.handleWebhook({rawBody,signatureV4:"invalid"});
  assert.equal(result.status,401);
  assert.equal(calls,0);
});

test("v4 webhook verifies provider refund before atomic credit settlement and deduplicates repeats",async()=>{
  const rawBody=Buffer.from(JSON.stringify({event:"refund.updated",data:{id:"rfd_verified",status:"succeeded"}}));
  const signature=createHmac("sha256",secret).update(rawBody).digest("base64");
  let duplicate=false,finalized=0,providerReads=0,dbWrites=0;
  const service=api(async(url,options={})=>{
    const target=String(url);
    if(target==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token")return json({access_token:"provider-test-token",expires_in:600});
    if(target.includes("/payment_webhook_events?select=id"))return json(duplicate?[{id:"event-1"}]:[]);
    if(target.endsWith("/payment_webhook_events")&&options.method==="POST"){dbWrites++;return new Response(null,{status:201});}
    if(target.includes("payment_refunds?select=id,owner_id"))return json([{
      id:refundId,owner_id:owner,payment_transaction_id:paymentId,
      provider_refund_id:"rfd_verified",amount_minor:2500,currency:"USD",status:"processing"
    }]);
    if(target==="https://developersandbox-api.flutterwave.com/refunds/rfd_verified"){
      providerReads++;
      return json({data:{id:"rfd_verified",charge_id:"chg_verified",amount_refunded:25,status:"succeeded"}});
    }
    if(target.includes("payment_transactions?select=id,provider_transaction_id")){
      return json([{id:paymentId,owner_id:owner,provider_transaction_id:"chg_verified",amount_minor:10000,currency:"USD"}]);
    }
    if(target.includes("/rpc/finalize_payment_refund")){finalized++;return json({refundId,status:"succeeded",creditReversalDelta:250});}
    if(target.includes("/payment_webhook_events?provider=eq.flutterwave")){dbWrites++;return new Response(null,{status:204});}
    throw new Error("Unexpected request: "+target);
  });
  const first=await service.handleWebhook({rawBody,signatureV4:signature});
  assert.equal(first.status,200);
  assert.equal(first.body.result.status,"succeeded");
  assert.equal(finalized,1);
  assert.equal(providerReads,1);
  assert.ok(dbWrites>=2);
  duplicate=true;
  const second=await service.handleWebhook({rawBody,signatureV4:signature});
  assert.equal(second.status,200);
  assert.equal(second.body.duplicate,true);
  assert.equal(finalized,1);
  assert.equal(providerReads,1);
});

test("provider amount or charge mismatch cannot finalize a refund",async()=>{
  const rawBody=Buffer.from(JSON.stringify({event:"refund.updated",data:{id:"rfd_bad",status:"succeeded"}}));
  const signature=createHmac("sha256",secret).update(rawBody).digest("base64");
  let finalized=0;
  const service=api(async(url,options={})=>{
    const target=String(url);
    if(target==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token")return json({access_token:"provider-test-token",expires_in:600});
    if(target.includes("/payment_webhook_events?select=id"))return json([]);
    if(target.endsWith("/payment_webhook_events")&&options.method==="POST")return new Response(null,{status:201});
    if(target.includes("payment_refunds?select=id,owner_id"))return json([{id:refundId,owner_id:owner,payment_transaction_id:paymentId,provider_refund_id:"rfd_bad",amount_minor:2500,currency:"USD",status:"processing"}]);
    if(target.includes("payment_transactions?select=id,provider_transaction_id"))return json([{id:paymentId,provider_transaction_id:"chg_expected",amount_minor:10000,currency:"USD"}]);
    if(target==="https://developersandbox-api.flutterwave.com/refunds/rfd_bad")return json({data:{id:"rfd_bad",charge_id:"chg_other",amount_refunded:25,status:"succeeded"}});
    if(target.includes("/rpc/finalize_payment_refund")){finalized++;return json({});}
    if(target.includes("/payment_webhook_events?provider=eq.flutterwave"))return new Response(null,{status:204});
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handleWebhook({rawBody,signatureV4:signature});
  assert.equal(result.status,500);
  assert.equal(finalized,0);
});

test("Flutterwave OAuth access token is cached and refreshed before expiry",async()=>{
  let calls=0,clock=1000;
  const getToken=createFlutterwaveAccessTokenProvider({
    clientId:"client",clientSecret:"secret",now:()=>clock,
    fetchImpl:async(url,options)=>{
      calls++;
      assert.equal(String(url),"https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token");
      assert.equal(options.method,"POST");
      assert.equal(options.headers["content-type"],"application/x-www-form-urlencoded");
      return json({access_token:"token-"+calls,expires_in:600});
    }
  });
  assert.equal(await getToken(),"token-1");
  assert.equal(await getToken(),"token-1");
  assert.equal(calls,1);
  clock+=550000;
  assert.equal(await getToken(),"token-2");
  assert.equal(calls,2);
});
