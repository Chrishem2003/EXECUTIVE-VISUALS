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

test("Creator Circle referral summary and attribution endpoints are owner-scoped",async()=>{
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url),body=options.body?JSON.parse(options.body):null;calls.push({target,body});
  if(target.includes("/rpc/customer_referral_summary"))return json({code:"AB12CD34EF",referrals:[],rewardsEarned:0,offer:{bonusCreditsPerSide:50}});
  if(target.includes("/rpc/attribute_customer_referral_code"))return json({attributed:true,status:"pending"});
  throw new Error("Unexpected request: "+target);
 });
 const summary=await service.handle({method:"GET",path:"/api/billing/referrals",ownerId:owner});
 assert.equal(summary.status,200);
 assert.equal(summary.body.referrals.code,"AB12CD34EF");
 assert.equal(calls[0].body.p_owner_id,owner);
 const invalid=await service.handle({method:"POST",path:"/api/billing/referrals/attribute",ownerId:owner,body:{referralCode:"bad"}});
 assert.equal(invalid.status,400);
 const applied=await service.handle({method:"POST",path:"/api/billing/referrals/attribute",ownerId:owner,body:{referralCode:"ab12cd34ef"}});
 assert.equal(applied.status,200);
 assert.equal(calls[1].body.p_referred_owner_id,owner);
 assert.equal(calls[1].body.p_referral_code,"AB12CD34EF");
});

test("creator referral summary is owner-scoped and referral attribution validates the code",async()=>{
 const requests=[];
 const service=api(async(url,options={})=>{
  const target=String(url);requests.push({target,body:options.body?JSON.parse(options.body):null});
  if(target.includes("/rpc/customer_referral_summary"))return json({code:"AB12CD34EF",referrals:[],rewardsEarned:0,offer:{bonusCreditsPerSide:50}});
  if(target.includes("/rpc/attribute_customer_referral_code"))return json({attributed:true,status:"pending"});
  throw new Error("Unexpected request: "+target);
 });
 const summary=await service.handle({method:"GET",path:"/api/billing/referrals",ownerId:owner});
 assert.equal(summary.status,200);
 assert.equal(summary.body.referrals.code,"AB12CD34EF");
 assert.equal(requests[0].body.p_owner_id,owner);
 const invalid=await service.handle({method:"POST",path:"/api/billing/referrals/attribute",ownerId:owner,body:{referralCode:"bad"}});
 assert.equal(invalid.status,400);
 const applied=await service.handle({method:"POST",path:"/api/billing/referrals/attribute",ownerId:owner,body:{referralCode:"ab12cd34ef"}});
 assert.equal(applied.status,200);
 assert.equal(requests[1].body.p_referred_owner_id,owner);
 assert.equal(requests[1].body.p_referral_code,"AB12CD34EF");
});

test("customer loyalty summary is fetched only for the authenticated owner",async()=>{
 let rpcBody;
 const service=api(async(url,options={})=>{
  if(String(url).includes("/rpc/customer_loyalty_summary")){
   rpcBody=JSON.parse(options.body);
   return json({rewards:[{reward_code:"first_paid_creator_welcome",granted_days:30,bonus_credits:100}],events:[],creditBalance:1100});
  }
  throw new Error("Unexpected request: "+String(url));
 });
 const result=await service.handle({method:"GET",path:"/api/billing/loyalty",ownerId:owner});
 assert.equal(result.status,200);
 assert.equal(rpcBody.p_owner_id,owner);
 assert.equal(result.body.loyalty.rewards[0].granted_days,30);
 assert.equal(result.body.loyalty.creditBalance,1100);
});

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
    if(target.includes("/payment_webhook_events?select=id"))return json(duplicate?[{id:"event-1",processing_status:"processed"}]:[]);
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

test("scheduled reconciliation retries an ambiguous refund with the same idempotency key",async()=>{
  const refundKey="stable-refund-key-0001";
  const calls=[];
  const service=api(async(url,options={})=>{
    const target=String(url);calls.push({target,options});
    if(target.includes("payment_refunds?select=id,owner_id")&&target.includes("status=in."))return json([{
      id:refundId,owner_id:owner,payment_transaction_id:paymentId,provider_refund_id:null,
      status:"requested",amount_minor:2500,currency:"USD",reason:"Customer request",idempotency_key:refundKey
    }]);
    if(target.includes("payment_transactions?select=id,provider_transaction_id")&&target.includes("provider_transaction_id,amount_minor,currency,status"))return json([{
      id:paymentId,owner_id:owner,provider_transaction_id:"chg_verified",amount_minor:10000,currency:"USD",status:"successful"
    }]);
    if(target==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token")return json({access_token:"provider-test-token",expires_in:600});
    if(target==="https://developersandbox-api.flutterwave.com/refunds"&&options.method==="POST")return json({data:{id:"rfd_retry",status:"new",charge_id:"chg_verified",amount_refunded:25}});
    if(target.includes("payment_refunds?id=eq."+refundId)&&options.method==="PATCH")return new Response(null,{status:204});
    if(target.includes("payment_refunds?select=id,owner_id")&&target.includes("provider_refund_id=eq.rfd_retry"))return json([{
      id:refundId,owner_id:owner,payment_transaction_id:paymentId,provider_refund_id:"rfd_retry",
      amount_minor:2500,currency:"USD",status:"processing"
    }]);
    if(target.includes("payment_transactions?select=id,provider_transaction_id")&&target.includes("owner_id=eq."+owner))return json([{
      id:paymentId,provider_transaction_id:"chg_verified",amount_minor:10000,currency:"USD"
    }]);
    if(target==="https://developersandbox-api.flutterwave.com/refunds/rfd_retry")return json({data:{id:"rfd_retry",charge_id:"chg_verified",amount_refunded:25,status:"pending"}});
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.reconcilePendingRefunds();
  assert.equal(result.checked,1);
  assert.equal(result.results[0].status,"processing");
  const refundPost=calls.find(call=>call.target==="https://developersandbox-api.flutterwave.com/refunds"&&call.options.method==="POST");
  assert.ok(refundPost);
  assert.equal(refundPost.options.headers["x-idempotency-key"],refundKey);
  assert.deepEqual(JSON.parse(refundPost.options.body),{amount:25,reason:"Customer request",charge_id:"chg_verified"});
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


test("Uganda mobile-money checkout uses server-priced active catalogue and idempotent v4 charge",async()=>{
  const calls=[];
  const service=api(async(url,options={})=>{
    const target=String(url);calls.push({target,options});
    if(target==="https://project.supabase.co/rest/v1/billing_products?select=product_code,name,description,amount_minor,currency,credit_units&product_code=eq.creator_credits&active=eq.true&limit=1")
      return json([{product_code:"creator_credits",name:"Creator credits",description:"Test pack",amount_minor:5000,currency:"UGX",credit_units:100}]);
    if(target.includes("payment_transactions?select=id,tx_ref,status,provider_transaction_id,metadata"))
      return json([]);
    if(target.endsWith("/payment_transactions")&&options.method==="POST")
      return json([{id:paymentId,metadata:{product_code:"creator_credits",credit_units:100,idempotency_key:"checkout-key-0001",mobile_money_network:"MTN"}}],201);
    if(target==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token")
      return json({access_token:"provider-test-token",expires_in:600});
    if(target==="https://developersandbox-api.flutterwave.com/orchestration/direct-charges"&&options.method==="POST")
      return json({data:{id:"chg_checkout",status:"pending",next_action:{type:"payment_instruction",payment_instruction:{note:"Approve on phone"}}}});
    if(target.includes("/payment_transactions?id=eq."+paymentId)&&options.method==="PATCH")
      return new Response(null,{status:204});
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handle({
    method:"POST",path:"/api/billing/checkout",ownerId:owner,idempotencyKey:"checkout-key-0001",
    body:{productCode:"creator_credits",network:"MTN",email:"buyer@example.com",firstName:"Test",lastName:"Buyer",phoneNumber:"0771234567"}
  });
  assert.equal(result.status,202);
  assert.equal(result.body.payment.providerChargeId,"chg_checkout");
  const charge=calls.find(call=>call.target==="https://developersandbox-api.flutterwave.com/orchestration/direct-charges");
  assert.ok(charge);
  const body=JSON.parse(charge.options.body);
  assert.equal(body.amount,5000);
  assert.equal(body.currency,"UGX");
  assert.equal(body.payment_method.mobile_money.network,"MTN");
  assert.equal(body.payment_method.mobile_money.country_code,"256");
  assert.equal(body.payment_method.mobile_money.phone_number,"771234567");
  assert.equal(charge.options.headers["x-idempotency-key"],"checkout-key-0001");
});

test("payment webhook verifies Flutterwave charge and atomically fulfils once",async()=>{
  const rawBody=Buffer.from(JSON.stringify({type:"charge.completed",data:{id:"chg_paid",status:"succeeded"}}));
  const signature=createHmac("sha256",secret).update(rawBody).digest("base64");
  let grants=0;
  const service=api(async(url,options={})=>{
    const target=String(url);
    if(target.includes("/payment_webhook_events?select=id"))return json([]);
    if(target.endsWith("/payment_webhook_events")&&options.method==="POST")return new Response(null,{status:201});
    if(target==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token")return json({access_token:"provider-test-token",expires_in:600});
    if(target==="https://developersandbox-api.flutterwave.com/charges/chg_paid")
      return json({data:{id:"chg_paid",reference:"EV-TEST-REFERENCE",amount:5000,currency:"UGX",status:"succeeded",payment_method_details:{type:"mobile_money"}}});
    if(target.includes("payment_transactions?select=id,owner_id,provider_transaction_id,tx_ref"))
      return json([{id:paymentId,owner_id:owner,provider_transaction_id:"chg_paid",tx_ref:"EV-TEST-REFERENCE",amount_minor:5000,currency:"UGX",status:"pending",metadata:{product_code:"creator_credits",credit_units:100},description:"Creator credits"}]);
    if(target.includes("/rpc/finalize_payment_purchase")){grants++;return json({status:"successful",credit_units:100,invoice_number:"EV-20261110-TEST"});}
    if(target.includes("/payment_webhook_events?provider=eq.flutterwave"))return new Response(null,{status:204});
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handleWebhook({rawBody,signatureV4:signature});
  assert.equal(result.status,200);
  assert.equal(result.body.result.status,"successful");
  assert.equal(grants,1);
});


test("credit balance endpoint returns server-computed owner balance only",async()=>{
  let rpcBody=null,requestUrl="";
  const service=api(async(url,options={})=>{
    requestUrl=String(url);
    rpcBody=JSON.parse(options.body||"{}");
    return json({ledger_balance:1200,reserved_credits:200,available_credits:1000});
  });
  const result=await service.handle({method:"GET",path:"/api/billing/credits",ownerId:owner});
  assert.equal(result.status,200);
  assert.deepEqual(result.body.credits,{ledgerBalance:1200,reserved:200,available:1000});
  assert.ok(requestUrl.endsWith("/rpc/get_credit_balance"));
  assert.deepEqual(rpcBody,{p_owner_id:owner});
});

test("credit balance endpoint fails closed on malformed database values",async()=>{
  const service=api(async()=>json({ledger_balance:"not-a-number",reserved_credits:0,available_credits:0}));
  const result=await service.handle({method:"GET",path:"/api/billing/credits",ownerId:owner});
  assert.equal(result.status,502);
  assert.equal(result.body.error.code,"CREDIT_BALANCE_INVALID");
});


test("customer invoice history is owner-scoped and never exposes private object paths",async()=>{
  let requestUrl="";
  const service=api(async(url)=>{
    requestUrl=String(url);
    return json([{
      id:"44444444-4444-4444-8444-444444444444",
      payment_transaction_id:paymentId,invoice_number:"EV-20261110-ABCDEF1234",
      currency:"UGX",total_minor:5000,issued_at:"2026-11-10T10:00:00Z",
      snapshot:{description:"Creator credits",credit_units:100},
      pdf_object_path:"private/owner/invoice.pdf"
    }]);
  });
  const result=await service.handle({method:"GET",path:"/api/billing/invoices",ownerId:owner,query:{limit:"10",offset:"0"}});
  assert.equal(result.status,200);
  assert.equal(result.body.invoices.length,1);
  assert.equal(result.body.invoices[0].pdfAvailable,true);
  assert.equal(Object.hasOwn(result.body.invoices[0],"pdf_object_path"),false);
  assert.ok(requestUrl.includes("owner_id=eq."+owner));
  assert.ok(requestUrl.includes("limit=10"));
});


test("subscription plan catalogue exposes only active public plans",async()=>{
  let requestUrl="";
  const service=api(async url=>{
    requestUrl=String(url);
    return json([{plan_code:"free",status:"active",is_public:true,billing_interval:"none",amount_minor:0,currency:"UGX",included_credits:0}]);
  });
  const result=await service.handle({method:"GET",path:"/api/billing/plans",ownerId:owner});
  assert.equal(result.status,200);
  assert.equal(result.body.plans.length,1);
  assert.ok(requestUrl.includes("status=eq.active"));
  assert.ok(requestUrl.includes("is_public=eq.true"));
});

test("customer subscription endpoint is scoped to the authenticated owner",async()=>{
  let requestUrl="";
  const service=api(async url=>{
    requestUrl=String(url);
    return json([{id:"55555555-5555-4555-8555-555555555555",owner_id:owner,plan_code:"free",status:"active",entitlements_snapshot:{projects:3}}]);
  });
  const result=await service.handle({method:"GET",path:"/api/billing/subscription",ownerId:owner});
  assert.equal(result.status,200);
  assert.equal(result.body.subscription.plan_code,"free");
  assert.ok(requestUrl.includes("owner_id=eq."+owner));
  assert.ok(requestUrl.includes("status=in.(pending,trialing,active,past_due)"));
});

test("subscription grant requires a platform billing role before calling the grant RPC",async()=>{
  let rpcCalled=false;
  const service=api(async url=>{
    const target=String(url);
    if(target.includes("/platform_admins?"))return json([{role:"support"}]);
    if(target.endsWith("/rpc/grant_customer_subscription"))rpcCalled=true;
    throw new Error("unexpected request");
  });
  const result=await service.handle({
    method:"POST",path:"/api/admin/subscriptions/grant",ownerId:owner,
    body:{customerId:paymentId,planCode:"free",periodStart:"2026-11-10T00:00:00Z",periodEnd:"2026-12-10T00:00:00Z",reason:"Courtesy access"}
  });
  assert.equal(result.status,403);
  assert.equal(result.body.error.code,"SUBSCRIPTION_ADMIN_REQUIRED");
  assert.equal(rpcCalled,false);
});

test("subscription grant calls audited server RPC with validated customer and period",async()=>{
  let rpcBody=null;
  const service=api(async(url,options={})=>{
    const target=String(url);
    if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
    if(target.endsWith("/rpc/grant_customer_subscription")){
      rpcBody=JSON.parse(options.body);
      return json("66666666-6666-4666-8666-666666666666");
    }
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handle({
    method:"POST",path:"/api/admin/subscriptions/grant",ownerId:owner,
    body:{customerId:paymentId,planCode:"free",periodStart:"2026-11-10T00:00:00Z",periodEnd:"2026-12-10T00:00:00Z",reason:"Courtesy access"}
  });
  assert.equal(result.status,201);
  assert.equal(result.body.subscription.status,"active");
  assert.equal(rpcBody.p_actor_id,owner);
  assert.equal(rpcBody.p_owner_id,paymentId);
  assert.equal(rpcBody.p_plan_code,"free");
  assert.equal(rpcBody.p_reason,"Courtesy access");
});

test("subscription grant rejects periods longer than 366 days",async()=>{
  let calls=0;
  const service=api(async()=>{calls++;return json([{role:"owner"}]);});
  const result=await service.handle({
    method:"POST",path:"/api/admin/subscriptions/grant",ownerId:owner,
    body:{customerId:paymentId,planCode:"free",periodStart:"2026-11-10T00:00:00Z",periodEnd:"2028-01-01T00:00:00Z",reason:"Courtesy access"}
  });
  assert.equal(result.status,400);
  assert.equal(result.body.error.code,"SUBSCRIPTION_GRANT_INVALID");
  assert.equal(calls,1); // role lookup only; invalid period never reaches grant RPC
});


test("verified Flutterwave subscription cancellation is retained for reconciliation, not blindly applied",async()=>{
  const rawBody=Buffer.from(JSON.stringify({
    event:"subscription.cancelled",
    data:{
      status:"deactivated",
      customer:{email:"customer@example.com"},
      plan:{id:98765,name:"Creator monthly",status:"cancel"}
    }
  }));
  const signature=createHmac("sha256",secret).update(rawBody).digest("base64");
  const calls=[];
  const service=api(async(url,options={})=>{
    const target=String(url);calls.push({target,method:options.method||"GET",body:options.body});
    if(target.includes("/payment_webhook_events?select=id"))return json([]);
    if(target.endsWith("/payment_webhook_events")&&options.method==="POST")return new Response(null,{status:201});
    if(target.includes("/payment_webhook_events?provider=eq.flutterwave&event_key=eq."))return new Response(null,{status:204});
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handleWebhook({rawBody,signatureV4:signature});
  assert.equal(result.status,200);
  assert.equal(result.body.needsReview,true);
  const patch=calls.find(call=>call.method==="PATCH");
  assert.ok(patch);
  assert.equal(JSON.parse(patch.body).processing_status,"needs_review");
  assert.equal(calls.some(call=>call.target.includes("customer_subscriptions")||call.target.includes("rpc/")),false);
});

test("subscription reconciliation queue is admin-only and returns sanitized event details",async()=>{
  let queueRead=false,requestUrl="";
  const service=api(async url=>{
    const target=String(url);
    if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
    if(target.includes("/payment_webhook_events?")){
      queueRead=true;requestUrl=target;
      return json([{
        id:"77777777-7777-4777-8777-777777777777",
        event_type:"subscription.cancelled",
        payload_hash:"a".repeat(64),
        processing_status:"needs_review",
        received_at:"2026-11-10T12:00:00Z",
        payload:{data:{status:"deactivated",customer:{email:"customer@example.com"},plan:{id:98765}}}
      }]);
    }
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handle({method:"GET",path:"/api/admin/subscriptions/reconciliation",ownerId:owner,query:{limit:"500"}});
  assert.equal(result.status,200);
  assert.equal(result.body.events.length,1);
  assert.equal(result.body.events[0].customerEmail,"customer@example.com");
  assert.equal(result.body.events[0].providerPlanId,98765);
  assert.equal(result.body.automatedEntitlementChanges,false);
  assert.equal(Object.hasOwn(result.body.events[0],"payload"),false);
  assert.ok(queueRead);
  assert.ok(requestUrl.includes("processing_status=eq.needs_review"));
  assert.ok(requestUrl.includes("limit=100"));
});

test("subscription reconciliation queue denies support role before reading webhook data",async()=>{
  let queueRead=false;
  const service=api(async url=>{
    const target=String(url);
    if(target.includes("/platform_admins?"))return json([{role:"support"}]);
    if(target.includes("/payment_webhook_events?"))queueRead=true;
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handle({method:"GET",path:"/api/admin/subscriptions/reconciliation",ownerId:owner});
  assert.equal(result.status,403);
  assert.equal(result.body.error.code,"SUBSCRIPTION_ADMIN_REQUIRED");
  assert.equal(queueRead,false);
});


test("provider readiness explains Flutterwave API version incompatibility without exposing credentials",async()=>{
  const service=api(async()=>{throw new Error("readiness endpoint must not call provider or database when admin lookup is denied");});
  // Admin role lookup is the only allowed request; provider credentials are never returned.
  const adminService=api(async url=>{
    if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);
    throw new Error("Unexpected provider/database request");
  });
  const result=await adminService.handle({method:"GET",path:"/api/admin/billing/provider-readiness",ownerId:owner});
  assert.equal(result.status,200);
  assert.equal(result.body.currentIntegrationApiVersion,"v4");
  assert.equal(result.body.recurringPaymentPlansApiVersion,"v3");
  assert.equal(result.body.recurringSubscriptionsAvailable,false);
  assert.equal(result.body.liveRecurringChargesEnabled,false);
  assert.equal(result.body.credentialsExposed,false);
  assert.match(result.body.reason,/only one API version/i);
  assert.equal(Object.hasOwn(result.body,"secretKey"),false);
});

test("provider readiness denies support users",async()=>{
  let providerRead=false;
  const service=api(async url=>{
    if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
    providerRead=true;
    throw new Error("Provider readiness must not be exposed");
  });
  const result=await service.handle({method:"GET",path:"/api/admin/billing/provider-readiness",ownerId:owner});
  assert.equal(result.status,403);
  assert.equal(result.body.error.code,"FINANCE_ADMIN_REQUIRED");
  assert.equal(providerRead,false);
});


test("customer-initiated subscription renewal uses V4 MTN checkout and idempotent reservation",async()=>{
  const calls=[];
  const service=api(async(url,options={})=>{
    const target=String(url);calls.push({target,method:options.method||"GET",body:options.body,headers:options.headers||{}});
    if(target.includes("/payment_transactions?select=id,tx_ref,status,provider_transaction_id,metadata"))return json([]);
    if(target.includes("/payment_transactions?select=id,tx_ref&"))return json([]);
    if(target.includes("/customer_subscriptions?select=id,owner_id,status,billing_interval"))return json([{
      id:"44444444-4444-4444-8444-444444444444",owner_id:owner,status:"past_due",
      billing_interval:"monthly",amount_minor:15000,currency:"UGX",
      current_period_end:"2026-10-01T00:00:00Z",customer_email:"customer@example.com"
    }]);
    if(target.endsWith("/payment_transactions")&&options.method==="POST")return json([{
      id:paymentId,owner_id:owner,tx_ref:"EVRrenewalref",status:"pending",
      metadata:{payment_purpose:"subscription_renewal",subscription_id:"44444444-4444-4444-8444-444444444444",idempotency_key:"renewal-key-0001",mobile_money_network:"MTN"}
    }],201);
    if(target==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token")return json({access_token:"provider-test-token",expires_in:600});
    if(target==="https://developersandbox-api.flutterwave.com/orchestration/direct-charges")return json({data:{id:"chg_renewal_1",status:"pending",next_action:{type:"wait"}}},202);
    if(target.includes("/payment_transactions?id=eq."+paymentId)&&options.method==="PATCH")return new Response(null,{status:204});
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handle({
    method:"POST",path:"/api/billing/subscription/renewal-checkout",ownerId:owner,
    idempotencyKey:"renewal-key-0001",
    body:{subscriptionId:"44444444-4444-4444-8444-444444444444",network:"MTN",email:"customer@example.com",firstName:"Test",lastName:"Customer",phoneNumber:"0771234567"}
  });
  assert.equal(result.status,202);
  assert.equal(result.body.payment.providerChargeId,"chg_renewal_1");
  const charge=calls.find(x=>x.target.endsWith("/orchestration/direct-charges"));
  assert.ok(charge);
  const payload=JSON.parse(charge.body);
  assert.equal(payload.amount,15000);
  assert.equal(payload.currency,"UGX");
  assert.equal(payload.payment_method.mobile_money.network,"MTN");
  assert.equal(charge.headers["x-idempotency-key"],"renewal-key-0001");
  const inserted=calls.find(x=>x.target.endsWith("/payment_transactions")&&x.method==="POST");
  assert.equal(JSON.parse(inserted.body).metadata.payment_purpose,"subscription_renewal");
});

test("subscription renewal checkout rejects a second pending attempt before charging provider",async()=>{
  let providerCalled=false;
  const service=api(async url=>{
    const target=String(url);
    if(target.includes("/payment_transactions?select=id,tx_ref,status,provider_transaction_id,metadata"))return json([]);
    if(target.includes("/payment_transactions?select=id,tx_ref&"))return json([{id:paymentId,tx_ref:"EVRpending"}]);
    if(target.includes("flutterwave"))providerCalled=true;
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handle({
    method:"POST",path:"/api/billing/subscription/renewal-checkout",ownerId:owner,
    idempotencyKey:"renewal-key-0002",
    body:{subscriptionId:"44444444-4444-4444-8444-444444444444",network:"AIRTEL",email:"customer@example.com",firstName:"Test",lastName:"Customer",phoneNumber:"0771234567"}
  });
  assert.equal(result.status,409);
  assert.equal(result.body.error.code,"SUBSCRIPTION_RENEWAL_ALREADY_PENDING");
  assert.equal(providerCalled,false);
});

test("verified V4 renewal charge calls atomic renewal RPC instead of granting purchase credits",async()=>{
  const rawBody=Buffer.from(JSON.stringify({event:"charge.completed",data:{id:"chg_renewal_verified",status:"succeeded"}}));
  const signature=createHmac("sha256",secret).update(rawBody).digest("base64");
  const calls=[];
  const service=api(async(url,options={})=>{
    const target=String(url);calls.push({target,method:options.method||"GET",body:options.body});
    if(target==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token")return json({access_token:"provider-test-token",expires_in:600});
    if(target.includes("/payment_webhook_events?select=id"))return json([]);
    if(target.endsWith("/payment_webhook_events")&&options.method==="POST")return new Response(null,{status:201});
    if(target==="https://developersandbox-api.flutterwave.com/charges/chg_renewal_verified")return json({data:{
      id:"chg_renewal_verified",reference:"EVRverifiedrenewal",currency:"UGX",amount:15000,status:"succeeded"
    }});
    if(target.includes("/payment_transactions?select=id,owner_id,provider_transaction_id,tx_ref,amount_minor,currency,status,metadata,description"))return json([{
      id:paymentId,owner_id:owner,provider_transaction_id:"chg_renewal_verified",
      tx_ref:"EVRverifiedrenewal",amount_minor:15000,currency:"UGX",status:"pending",
      metadata:{payment_purpose:"subscription_renewal",subscription_id:"44444444-4444-4444-8444-444444444444"}
    }]);
    if(target.endsWith("/rpc/finalize_subscription_renewal"))return json({status:"active"});
    if(target.includes("/payment_webhook_events?provider=eq.flutterwave&event_key=eq.")&&options.method==="PATCH")return new Response(null,{status:204});
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handleWebhook({rawBody,signatureV4:signature});
  assert.equal(result.status,200);
  assert.equal(result.body.result.subscriptionRenewed,true);
  assert.ok(calls.some(x=>x.target.endsWith("/rpc/finalize_subscription_renewal")));
  assert.equal(calls.some(x=>x.target.endsWith("/rpc/finalize_payment_purchase")),false);
});


test("verified webhook retries a previously failed inbox event instead of discarding it as duplicate",async()=>{
  const rawBody=Buffer.from(JSON.stringify({event:"charge.completed",data:{id:"chg_retry",status:"succeeded"}}));
  const signature=createHmac("sha256",secret).update(rawBody).digest("base64");
  const calls=[];
  const service=api(async(url,options={})=>{
    const target=String(url);calls.push({target,method:options.method||"GET",body:options.body});
    if(target.includes("/payment_webhook_events?select=id,processing_status"))return json([{id:"event-retry",processing_status:"failed"}]);
    if(target.includes("/payment_webhook_events?id=eq.event-retry")&&options.method==="PATCH")return new Response(null,{status:204});
    if(target==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token")return json({access_token:"provider-test-token",expires_in:600});
    if(target==="https://developersandbox-api.flutterwave.com/charges/chg_retry")return json({data:{
      id:"chg_retry",reference:"EVRretry",currency:"UGX",amount:15000,status:"succeeded"
    }});
    if(target.includes("/payment_transactions?select=id,owner_id,provider_transaction_id,tx_ref,amount_minor,currency,status,metadata,description"))return json([{
      id:paymentId,owner_id:owner,provider_transaction_id:"chg_retry",tx_ref:"EVRretry",
      amount_minor:15000,currency:"UGX",status:"pending",
      metadata:{payment_purpose:"subscription_renewal",subscription_id:"44444444-4444-4444-8444-444444444444"}
    }]);
    if(target.endsWith("/rpc/finalize_subscription_renewal"))return json({status:"active"});
    if(target.includes("/payment_webhook_events?provider=eq.flutterwave&event_key=eq.")&&options.method==="PATCH")return new Response(null,{status:204});
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handleWebhook({rawBody,signatureV4:signature});
  assert.equal(result.status,200);
  assert.equal(result.body.result.subscriptionRenewed,true);
  assert.ok(calls.some(x=>x.target.includes("/payment_webhook_events?id=eq.event-retry")&&x.method==="PATCH"));
});


test("verified failed Flutterwave charge creates recovery attempt and queues customer notification",async()=>{
  const rawBody=Buffer.from(JSON.stringify({event:"charge.completed",data:{id:"chg_failed_recovery",status:"failed"}}));
  const signature=createHmac("sha256",secret).update(rawBody).digest("base64");
  const calls=[];
  const service=api(async(url,options={})=>{
    const target=String(url);calls.push({target,method:options.method||"GET",body:options.body});
    if(target.includes("/payment_webhook_events?select=id,processing_status"))return json([]);
    if(target.endsWith("/payment_webhook_events")&&options.method==="POST")return new Response(null,{status:201});
    if(target==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token")return json({access_token:"provider-test-token",expires_in:600});
    if(target==="https://developersandbox-api.flutterwave.com/charges/chg_failed_recovery")return json({data:{
      id:"chg_failed_recovery",reference:"EVfailedrecovery",currency:"UGX",amount:15000,status:"failed",
      failure_code:"INSUFFICIENT_FUNDS",failure_message:"Insufficient funds"
    }});
    if(target.includes("/payment_transactions?select=id,owner_id,provider_transaction_id,tx_ref,amount_minor,currency,status,metadata,description"))return json([{
      id:paymentId,owner_id:owner,provider_transaction_id:"chg_failed_recovery",
      tx_ref:"EVfailedrecovery",amount_minor:15000,currency:"UGX",status:"pending",
      metadata:{payment_purpose:"subscription_renewal",subscription_id:"44444444-4444-4444-8444-444444444444"}
    }]);
    if(target.includes("/payment_transactions?id=eq."+paymentId)&&options.method==="PATCH")return new Response(null,{status:204});
    if(target.endsWith("/rpc/record_payment_failure")){
      const payload=JSON.parse(options.body);
      assert.equal(payload.p_payment_id,paymentId);
      assert.equal(payload.p_failure_code,"INSUFFICIENT_FUNDS");
      assert.equal(payload.p_grace_hours,72);
      return json({paymentAttemptId:"55555555-5555-4555-8555-555555555555",status:"retry_scheduled",subscriptionStatus:"past_due",notificationQueued:true});
    }
    if(target.includes("/payment_webhook_events?provider=eq.flutterwave&event_key=eq.")&&options.method==="PATCH")return new Response(null,{status:204});
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handleWebhook({rawBody,signatureV4:signature});
  assert.equal(result.status,200);
  assert.equal(result.body.result.status,"failed");
  assert.equal(result.body.result.recovery.notificationQueued,true);
  assert.ok(calls.some(x=>x.target.endsWith("/rpc/record_payment_failure")));
});

test("customer billing notifications are scoped to authenticated owner",async()=>{
  let target="";
  const service=api(async url=>{
    target=String(url);
    return json([{id:"55555555-5555-4555-8555-555555555555",owner_id:owner,notification_type:"payment_failed",payload:{title:"Payment needs attention"},status:"queued"}]);
  });
  const result=await service.handle({method:"GET",path:"/api/billing/notifications",ownerId:owner});
  assert.equal(result.status,200);
  assert.ok(target.includes("/billing_notification_outbox?"));
  assert.ok(target.includes("owner_id=eq."+owner));
  assert.equal(result.body.notifications.length,1);
});

test("customer cannot mark another user's billing notification as read",async()=>{
  let target="";
  const service=api(async(url,options={})=>{
    target=String(url);
    assert.equal(options.method,"PATCH");
    return json([]);
  });
  const result=await service.handle({
    method:"POST",path:"/api/billing/notifications/read",ownerId:owner,
    body:{notificationId:"55555555-5555-4555-8555-555555555555"}
  });
  assert.equal(result.status,200);
  assert.equal(result.body.markedRead,false);
  assert.ok(target.includes("owner_id=eq."+owner));
});

test("billing recovery queue is administrator-only",async()=>{
  const service=api(async url=>{
    if(String(url).includes("platform_admins"))return json([{role:"support"}]);
    throw new Error("Recovery data must not be read by support users");
  });
  const result=await service.handle({method:"GET",path:"/api/admin/billing/recovery",ownerId:owner});
  assert.equal(result.status,403);
  assert.equal(result.body.error.code,"BILLING_ADMIN_REQUIRED");
});

test("admin grace-expiry action is role-protected and reports no provider charges",async()=>{
  let rpcCalled=false;
  const service=api(async(url,options={})=>{
    if(String(url).includes("platform_admins"))return json([{role:"billing_admin"}]);
    if(String(url).endsWith("/rpc/expire_due_subscriptions")){
      rpcCalled=true;
      assert.equal(JSON.parse(options.body).p_limit,100);
      return json({expiredCount:2});
    }
    throw new Error("Unexpected request: "+String(url));
  });
  const result=await service.handle({method:"POST",path:"/api/admin/billing/recovery/expire-grace",ownerId:owner,body:{}});
  assert.equal(result.status,200);
  assert.equal(result.body.expiredCount,2);
  assert.equal(result.body.providerChargesInitiated,false);
  assert.equal(rpcCalled,true);
});


test("customer subscription management delegates ownership-bound cancellation to the service RPC",async()=>{
  let rpcPayload=null;
  const service=api(async(url,options={})=>{
    const target=String(url);
    if(target.endsWith("/rpc/manage_customer_subscription")){
      rpcPayload=JSON.parse(options.body);
      return json({subscriptionId:"44444444-4444-4444-8444-444444444444",status:"active",cancelAtPeriodEnd:true,effectiveAt:"2026-12-01T00:00:00Z"});
    }
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handle({method:"POST",path:"/api/billing/subscription/manage",ownerId:owner,body:{
    subscriptionId:"44444444-4444-4444-8444-444444444444",action:"cancel_at_period_end"
  }});
  assert.equal(result.status,200);
  assert.equal(rpcPayload.p_owner_id,owner);
  assert.equal(rpcPayload.p_action,"cancel_at_period_end");
  assert.equal(rpcPayload.p_reason,"Customer self-service");
});

test("subscription management rejects invalid plan codes before database access",async()=>{
  const service=api(async()=>{throw new Error("database must not be called");});
  const result=await service.handle({method:"POST",path:"/api/billing/subscription/manage",ownerId:owner,body:{
    subscriptionId:"44444444-4444-4444-8444-444444444444",action:"schedule_plan_change",planCode:"../../admin"
  }});
  assert.equal(result.status,400);
  assert.equal(result.body.error.code,"SUBSCRIPTION_MANAGEMENT_INPUT_INVALID");
});

test("subscription event history verifies ownership before reading events",async()=>{
  const calls=[];
  const service=api(async url=>{
    const target=String(url);calls.push(target);
    if(target.includes("/customer_subscriptions?select=id"))return json([{id:"44444444-4444-4444-8444-444444444444"}]);
    if(target.includes("/subscription_events?"))return json([{event_type:"renewed"}]);
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handle({method:"GET",path:"/api/billing/subscription/events",ownerId:owner,query:{
    subscriptionId:"44444444-4444-4444-8444-444444444444"
  }});
  assert.equal(result.status,200);
  assert.equal(result.body.events.length,1);
  assert.ok(calls[0].includes("owner_id=eq."+owner));
});


test("initial subscription checkout reserves server-priced plan and initiates customer-authorized MoMo",async()=>{
  const calls=[];
  const service=api(async(url,options={})=>{
    const target=String(url);calls.push({target,method:options.method||"GET",headers:options.headers,body:options.body});
    if(target==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token")
      return json({access_token:"provider-test-token",expires_in:600});
    if(target.endsWith("/rpc/reserve_subscription_purchase"))
      return json({paymentId,paymentIdempotentReplay:false,subscriptionId:"44444444-4444-4444-8444-444444444444",txRef:"EVScheckout",amountMinor:25000,currency:"UGX",status:"pending",idempotentReplay:false});
    if(target==="https://developersandbox-api.flutterwave.com/orchestration/direct-charges"){
      const payload=JSON.parse(options.body);
      assert.equal(payload.amount,25000);
      assert.equal(payload.currency,"UGX");
      assert.equal(payload.payment_method.mobile_money.network,"MTN");
      assert.equal(options.headers["x-idempotency-key"],"subscription-checkout-key");
      return json({data:{id:"chg_initial_sub",status:"pending",next_action:{type:"payment_instruction"}}});
    }
    if(target.includes("/payment_transactions?id=eq."+paymentId)&&options.method==="PATCH")return new Response(null,{status:204});
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handle({method:"POST",path:"/api/billing/subscription/checkout",ownerId:owner,
    idempotencyKey:"subscription-checkout-key",
    body:{planCode:"creator-monthly",network:"MTN",email:"customer@example.com",firstName:"Test",lastName:"Customer",phoneNumber:"0771234567"}});
  assert.equal(result.status,202);
  assert.equal(result.body.payment.subscriptionId,"44444444-4444-4444-8444-444444444444");
  assert.equal(result.body.payment.providerChargeId,"chg_initial_sub");
  assert.ok(calls.some(x=>x.target.endsWith("/rpc/reserve_subscription_purchase")));
});

test("initial subscription checkout rejects invalid plan input before reservation",async()=>{
  const service=api(async()=>{throw new Error("provider and database must not be called");});
  const result=await service.handle({method:"POST",path:"/api/billing/subscription/checkout",ownerId:owner,
    idempotencyKey:"subscription-checkout-key",
    body:{planCode:"../admin",network:"MTN",email:"customer@example.com",firstName:"Test",lastName:"Customer",phoneNumber:"0771234567"}});
  assert.equal(result.status,400);
  assert.equal(result.body.error.code,"SUBSCRIPTION_CHECKOUT_INPUT_INVALID");
});

test("verified initial subscription payment activates the pending plan through the atomic RPC",async()=>{
  const rawBody=Buffer.from(JSON.stringify({event:"charge.completed",data:{id:"chg_initial_verified",status:"succeeded"}}));
  const signature=createHmac("sha256",secret).update(rawBody).digest("base64");
  const calls=[];
  const service=api(async(url,options={})=>{
    const target=String(url);calls.push({target,method:options.method||"GET",body:options.body});
    if(target.includes("/payment_webhook_events?select=id,processing_status"))return json([]);
    if(target.endsWith("/payment_webhook_events")&&options.method==="POST")return new Response(null,{status:201});
    if(target==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token")return json({access_token:"provider-test-token",expires_in:600});
    if(target==="https://developersandbox-api.flutterwave.com/charges/chg_initial_verified")return json({data:{
      id:"chg_initial_verified",reference:"EVSverified",currency:"UGX",amount:25000,status:"succeeded"
    }});
    if(target.includes("/payment_transactions?select=id,owner_id,provider_transaction_id,tx_ref,amount_minor,currency,status,metadata,description"))return json([{
      id:paymentId,owner_id:owner,provider_transaction_id:"chg_initial_verified",tx_ref:"EVSverified",
      amount_minor:25000,currency:"UGX",status:"pending",
      metadata:{payment_purpose:"subscription_purchase",subscription_id:"44444444-4444-4444-8444-444444444444"}
    }]);
    if(target.endsWith("/rpc/finalize_subscription_purchase"))return json({status:"active",subscriptionId:"44444444-4444-4444-8444-444444444444"});
    if(target.includes("/payment_webhook_events?provider=eq.flutterwave&event_key=eq.")&&options.method==="PATCH")return new Response(null,{status:204});
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handleWebhook({rawBody,signatureV4:signature});
  assert.equal(result.status,200);
  assert.equal(result.body.result.subscriptionActivated,true);
  assert.ok(calls.some(x=>x.target.endsWith("/rpc/finalize_subscription_purchase")));
});


test("subscription lifecycle worker invokes bounded service-role expiry RPC",async()=>{
  let rpcPayload=null;
  const service=api(async(url,options={})=>{
    if(String(url).endsWith("/rpc/expire_due_subscriptions")){
      rpcPayload=JSON.parse(options.body);
      return json({expiredCount:3,scheduledCancellationsFinalized:2});
    }
    throw new Error("Unexpected request: "+String(url));
  });
  const result=await service.expireDueSubscriptions();
  assert.deepEqual(rpcPayload,{p_limit:100});
  assert.equal(result.expiredCount,3);
  assert.equal(result.scheduledCancellationsFinalized,2);
});
