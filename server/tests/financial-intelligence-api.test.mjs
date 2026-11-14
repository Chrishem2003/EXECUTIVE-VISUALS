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

test("customer-success telemetry remains available when payment processing is disabled",async()=>{
 const service=api(async(url,options={})=>{
  if(String(url).endsWith("/rpc/record_customer_success_event"))return json({recorded:true,duplicate:false,milestonesAwarded:0});
  throw new Error("Unexpected request: "+String(url));
 },{billingEnabled:false});
 const event=await service.handle({method:"POST",path:"/api/customer-success/events",ownerId:owner,body:{eventType:"session_started",eventKey:"session-no-billing-01"}});
 assert.equal(event.status,202);
 const billing=await service.handle({method:"GET",path:"/api/billing/plans",ownerId:owner});
 assert.equal(billing.status,503);
});

test("customer-success events and milestone summary are scoped to the authenticated account",async()=>{
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url),body=options.body?JSON.parse(options.body):null;calls.push({target,body});
  if(target.endsWith("/rpc/record_customer_success_event"))return json({recorded:true,duplicate:false,milestonesAwarded:1});
  if(target.endsWith("/rpc/customer_success_summary"))return json({milestones:[],progress:[{code:"first_project",completed:false}],points:0,completedCount:0,totalCount:1});
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"POST",path:"/api/customer-success/events",ownerId:owner,body:{eventType:"unknown",eventKey:"event-key-123"}});
 assert.equal(invalid.status,400);
 const recorded=await service.handle({method:"POST",path:"/api/customer-success/events",ownerId:owner,body:{eventType:"render_completed",eventKey:"render-key-123"}});
 assert.equal(recorded.status,202);
 assert.equal(calls[0].body.p_owner_id,owner);
 assert.equal(calls[0].body.p_event_type,"render_completed");
 const summary=await service.handle({method:"GET",path:"/api/customer-success/me",ownerId:owner});
 assert.equal(summary.status,200);
 assert.equal(summary.body.success.progress[0].completed,false);
});

test("customer-success admin overview requires an authorized admin role",async()=>{
 let overviewCalled=false;
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([]);
  throw new Error("Unauthorized caller must not reach admin data");
 });
 const deniedResult=await denied.handle({method:"GET",path:"/api/admin/customer-success/overview",ownerId:owner});
 assert.equal(deniedResult.status,403);
 const allowed=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/customer_success_admin_overview")){overviewCalled=true;return json({totalCustomers:12,atRisk:2,customers:[]});}
  throw new Error("Unexpected request: "+target);
 });
 const allowedResult=await allowed.handle({method:"GET",path:"/api/admin/customer-success/overview",ownerId:owner});
 assert.equal(allowedResult.status,200);
 assert.equal(overviewCalled,true);
 assert.equal(allowedResult.body.overview.totalCustomers,12);
});

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

test("refund initiation fails closed for Paddle and Pesapal charges before calling Flutterwave",async()=>{
  const calls=[];
  const service=api(async(url,options={})=>{
    const target=String(url);calls.push({target,method:options.method||"GET"});
    if(target.includes("platform_admins"))return json([{role:"billing_admin"}]);
    if(target.includes("payment_transactions?select=id,owner_id,provider,provider_transaction_id"))return json([{
      id:paymentId,owner_id:owner,provider:"paddle",provider_transaction_id:"txn_paddle_verified",
      amount_minor:5000,currency:"USD",status:"successful"
    }]);
    throw new Error("Unsupported provider refund must stop before any provider or RPC call: "+target);
  });
  const result=await service.handle({
    method:"POST",path:"/api/admin/finance/refunds",ownerId:owner,
    body:{paymentTransactionId:paymentId,amountMinor:1000,reason:"Customer request"},
    idempotencyKey:"refund-key-paddle-0001"
  });
  assert.equal(result.status,409);
  assert.equal(result.body.error.code,"REFUND_PROVIDER_UNSUPPORTED");
  assert.equal(calls.length,2);
  assert.ok(!calls.some(call=>call.target.includes("flutterwave")||call.target.includes("/rpc/")));
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
    if(target.includes("payment_transactions?select=id,customer_email,tx_ref,status,provider_transaction_id,metadata"))
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


test("credit checkout idempotency key cannot replay for a different customer email",async()=>{
 let providerCalled=false;
 const service=api(async url=>{
  const target=String(url);
  if(target.includes("payment_transactions?select=id,customer_email,tx_ref,status,provider_transaction_id,metadata"))
   return json([{id:paymentId,customer_email:"other@example.com",tx_ref:"EVSprior",status:"pending",
    metadata:{product_code:"creator_credits",mobile_money_network:"MTN"}}]);
  if(target.includes("flutterwave"))providerCalled=true;
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/billing/checkout",ownerId:owner,
  idempotencyKey:"credit-email-key-01",
  body:{productCode:"creator_credits",network:"MTN",email:"buyer@example.com",firstName:"Test",lastName:"Buyer",phoneNumber:"0771234567"}});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"IDEMPOTENCY_KEY_REUSED");
 assert.equal(providerCalled,false);
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
    if(target.includes("/payment_transactions?select=id,customer_email,tx_ref,status,provider_transaction_id,metadata"))return json([]);
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


test("subscription renewal idempotency key cannot replay for a different customer email",async()=>{
 let providerCalled=false;
 const service=api(async url=>{
  const target=String(url);
  if(target.includes("payment_transactions?select=id,customer_email,tx_ref,status,provider_transaction_id,metadata"))
   return json([{id:paymentId,customer_email:"other@example.com",tx_ref:"EVRprior",status:"pending",
    metadata:{payment_purpose:"subscription_renewal",subscription_id:"44444444-4444-4444-8444-444444444444",mobile_money_network:"MTN"}}]);
  if(target.includes("flutterwave"))providerCalled=true;
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/billing/subscription/renewal-checkout",ownerId:owner,
  idempotencyKey:"renewal-email-key-01",
  body:{subscriptionId:"44444444-4444-4444-8444-444444444444",network:"MTN",email:"customer@example.com",firstName:"Test",lastName:"Customer",phoneNumber:"0771234567"}});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"IDEMPOTENCY_KEY_REUSED");
 assert.equal(providerCalled,false);
});

test("subscription renewal checkout rejects a second pending attempt before charging provider",async()=>{
  let providerCalled=false;
  const service=api(async url=>{
    const target=String(url);
    if(target.includes("/payment_transactions?select=id,customer_email,tx_ref,status,provider_transaction_id,metadata"))return json([]);
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
    if(target.includes("/customer_subscriptions?select=id,provider"))return json([{provider:"flutterwave"}]);
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

test("growth intelligence requires administrator access and returns measured cohorts",async()=>{
 const denied=api(async()=>json([]));
 const forbidden=await denied.handle({method:"GET",path:"/api/admin/customer-success/growth",ownerId:owner});
 assert.equal(forbidden.status,403);
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url);calls.push({target,method:options.method||"GET",body:options.body?JSON.parse(options.body):null});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/customer_growth_admin_overview"))return json({
   cohortDefinition:"First paid month; current paid status snapshot.",
   cohorts:[{cohortMonth:"2026-10-01",customers:12,activeNow:9,currentRetentionPct:75}],
   renewalWatchlist:[],cancellationReasons:[],experiments:[]
  });
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"GET",path:"/api/admin/customer-success/growth",ownerId:owner});
 assert.equal(result.status,200);
 assert.equal(result.body.growth.cohorts[0].currentRetentionPct,75);
 assert.ok(calls.some(x=>x.target.endsWith("/rpc/customer_growth_admin_overview")));
});

test("growth experiments validate definitions and assign only to the authenticated customer",async()=>{
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.endsWith("/rpc/customer_growth_create_experiment"))return json({id:"44444444-4444-4444-8444-444444444444",experimentKey:"onboarding-test",status:"draft"});
  if(target.endsWith("/rpc/customer_growth_assign_experiment"))return json({assigned:true,experimentKey:"onboarding-test",variant:"control"});
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"POST",path:"/api/admin/customer-success/experiments",ownerId:owner,body:{experimentKey:"bad",name:"x",hypothesis:"short",primaryMetric:"activation_rate",variants:[]}});
 assert.equal(invalid.status,400);
 const created=await service.handle({method:"POST",path:"/api/admin/customer-success/experiments",ownerId:owner,body:{
  experimentKey:"onboarding-test",name:"Onboarding test",hypothesis:"A guided first project increases activation.",
  primaryMetric:"activation_rate",variants:[{key:"control",label:"Standard"},{key:"guided",label:"Guided"}]
 }});
 assert.equal(created.status,201);
 const assigned=await service.handle({method:"POST",path:"/api/customer-success/experiments/assign",ownerId:owner,body:{experimentKey:"onboarding-test"}});
 assert.equal(assigned.status,200);
 assert.equal(assigned.body.assignment.variant,"control");
 const assignmentCall=calls.find(x=>x.target.endsWith("/rpc/customer_growth_assign_experiment"));
 assert.equal(assignmentCall.body.p_owner_id,owner);
});

test("customer-success intervention completion requires a measured outcome",async()=>{
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/customer_growth_update_intervention"))return json({id:"55555555-5555-4555-8555-555555555555",status:"completed",outcome:"renewed"});
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"PATCH",path:"/api/admin/customer-success/interventions",ownerId:owner,body:{
  interventionId:"55555555-5555-4555-8555-555555555555",status:"completed"
 }});
 assert.equal(invalid.status,400);
 const completed=await service.handle({method:"PATCH",path:"/api/admin/customer-success/interventions",ownerId:owner,body:{
  interventionId:"55555555-5555-4555-8555-555555555555",status:"completed",outcome:"renewed"
 }});
 assert.equal(completed.status,200);
 assert.equal(completed.body.intervention.outcome,"renewed");
});

test("predictive revenue overview is finance-admin only and preserves scenario semantics",async()=>{
 const denied=api(async()=>json([]));
 const forbidden=await denied.handle({method:"GET",path:"/api/admin/finance/predictive-overview",ownerId:owner});
 assert.equal(forbidden.status,403);
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/financial_predictive_revenue_overview"))return json({
   modelVersion:"subscription-scenario-v1",sourceWindowDays:180,
   forecastSemantics:"Scenario estimates, not recognized revenue or guaranteed collections.",
   currencies:[{currency:"UGX",activeSubscribers:20,currentMrrMinor:500000,currentArrMinor:6000000,
    observedMonthlyChurnPct:2.1,churnConfidence:"low",churnSampleSize:25,
    averageRealizedLtvMinor:125000,predictedLtvMinor:450000,cacAvailability:"not_instrumented",
    forecast:[{days:30,base:{endMrrMinor:489500,mrrAtRiskMinor:10500},
      conservative:{endMrrMinor:484250,mrrAtRiskMinor:15750},
      upside:{endMrrMinor:492125,mrrAtRiskMinor:7875}}]}],
   limitations:["CAC and acquisition-channel attribution are unavailable."]
  });
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/predictive-overview",ownerId:owner});
 assert.equal(result.status,200);
 assert.equal(result.body.forecast.currencies[0].forecast[0].days,30);
 assert.equal(result.body.forecast.currencies[0].cacAvailability,"not_instrumented");
 assert.match(result.body.forecast.forecastSemantics,/not recognized revenue/);
 const rpcCall=calls.find(x=>x.target.endsWith("/rpc/financial_predictive_revenue_overview"));
 assert.equal(rpcCall.body.p_actor_id,owner);
});

test("predictive revenue overview remains disabled when billing intelligence is disabled",async()=>{
 const service=api(async()=>{throw new Error("Database must not be called");},{billingEnabled:false});
 const result=await service.handle({method:"GET",path:"/api/admin/finance/predictive-overview",ownerId:owner});
 assert.equal(result.status,503);
});

test("revenue retention overview and snapshot capture require a financial administrator",async()=>{
 const denied=api(async()=>json([]));
 const forbidden=await denied.handle({method:"GET",path:"/api/admin/finance/revenue-retention",ownerId:owner});
 assert.equal(forbidden.status,403);
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/financial_revenue_retention_overview"))return json({retention:[],acquisition:[],forecastAccuracy:[],limitations:["Two snapshots required."]});
  if(target.endsWith("/rpc/capture_subscription_revenue_snapshot"))return json({snapshotMonth:"2026-11-01",capturedCustomers:12,insertedCustomers:12,alreadyCaptured:false});
  throw new Error("Unexpected request: "+target);
 });
 const overview=await service.handle({method:"GET",path:"/api/admin/finance/revenue-retention",ownerId:owner});
 assert.equal(overview.status,200);
 assert.equal(overview.body.intelligence.retention.length,0);
 const snapshot=await service.handle({method:"POST",path:"/api/admin/finance/revenue-retention/snapshot",ownerId:owner,body:{}});
 assert.equal(snapshot.status,200);
 const capture=calls.find(x=>x.target.endsWith("/rpc/capture_subscription_revenue_snapshot"));
 assert.equal(capture.body.p_actor_id,owner);
});

test("acquisition spend API validates input and binds spend to the authenticated administrator",async()=>{
 let rpcBody=null;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.endsWith("/rpc/record_customer_acquisition_spend")){
   rpcBody=JSON.parse(options.body);return json({id:"44444444-4444-4444-8444-444444444444",amountMinor:120000});
  }
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"POST",path:"/api/admin/finance/acquisition-spend",ownerId:owner,body:{periodMonth:"November",channel:"paid_search"}});
 assert.equal(invalid.status,400);
 const valid=await service.handle({method:"POST",path:"/api/admin/finance/acquisition-spend",ownerId:owner,body:{
  periodMonth:"2026-11-01",channel:"paid_search",campaign:"launch",currency:"UGX",
  amountMinor:120000,description:"November campaign spend",idempotencyKey:"campaign-spend-2026-11"
 }});
 assert.equal(valid.status,200);
 assert.equal(rpcBody.p_actor_id,owner);
 assert.equal(rpcBody.p_amount_minor,120000);
 assert.equal(rpcBody.p_currency,"UGX");
});

test("customer acquisition attribution validates paid customer identity and source",async()=>{
 let rpcBody=null;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/record_customer_acquisition_attribution")){
   rpcBody=JSON.parse(options.body);return json({ownerId:owner,channel:"referral",currency:"UGX"});
  }
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/acquisition-attribution",ownerId:owner,body:{
  ownerId:owner,channel:"referral",campaign:"creator-circle",currency:"UGX",
  sourceType:"referral",acquiredAt:"2026-11-10T08:00:00.000Z"
 }});
 assert.equal(result.status,200);
 assert.equal(rpcBody.p_actor_id,owner);
 assert.equal(rpcBody.p_owner_id,owner);
 assert.equal(rpcBody.p_source_type,"referral");
});

test("profitability overview is protected and returns evidence-backed unit economics",async()=>{
 let rpcCalled=false;
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([]);
  throw new Error("Unauthorized finance data must not be queried");
 });
 const deniedResult=await denied.handle({method:"GET",path:"/api/admin/finance/profitability",ownerId:owner});
 assert.equal(deniedResult.status,403);
 const allowed=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/financial_profitability_overview")){
   rpcCalled=true;assert.equal(JSON.parse(options.body).p_actor_id,owner);
   return json({byCurrency:[{currency:"UGX",grossContributionMinor:19000,directGrossMarginPct:95}],customers:[],sharedCosts:[],limitations:[]});
  }
  throw new Error("Unexpected request: "+target);
 });
 const result=await allowed.handle({method:"GET",path:"/api/admin/finance/profitability",ownerId:owner});
 assert.equal(result.status,200);
 assert.equal(rpcCalled,true);
 assert.equal(result.body.profitability.byCurrency[0].directGrossMarginPct,95);
});

test("service cost API validates reversals and binds immutable cost evidence to the admin",async()=>{
 let rpcBody=null;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.endsWith("/rpc/record_financial_service_cost")){
   rpcBody=JSON.parse(options.body);return json({id:"44444444-4444-4444-8444-444444444444",entryType:rpcBody.p_reverses_event_id?"reversal":"expense"});
  }
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"POST",path:"/api/admin/finance/service-cost",ownerId:owner,body:{
  periodMonth:"2026-11-01",category:"ai_inference",sourceType:"provider_invoice",currency:"UGX",
  amountMinor:-500,description:"Invalid negative cost",idempotencyKey:"invalid-cost-01"
 }});
 assert.equal(invalid.status,400);
 const valid=await service.handle({method:"POST",path:"/api/admin/finance/service-cost",ownerId:owner,body:{
  periodMonth:"2026-11-01",ownerId:owner,category:"ai_inference",sourceType:"provider_usage_export",
  currency:"UGX",amountMinor:1500,sourceReference:"invoice-2026-11",description:"Attributed model inference cost",
  idempotencyKey:"model-cost-2026-11"
 }});
 assert.equal(valid.status,200);
 assert.equal(rpcBody.p_actor_id,owner);
 assert.equal(rpcBody.p_owner_id,owner);
 assert.equal(rpcBody.p_amount_minor,1500);
 assert.equal(rpcBody.p_cost_category,"ai_inference");
 const reversal=await service.handle({method:"POST",path:"/api/admin/finance/service-cost",ownerId:owner,body:{
  periodMonth:"2026-11-01",ownerId:owner,category:"ai_inference",sourceType:"provider_invoice",
  currency:"UGX",amountMinor:-500,reversesEventId:"44444444-4444-4444-8444-444444444444",
  description:"Partial provider credit reversal",idempotencyKey:"model-cost-reversal-01"
 }});
 assert.equal(reversal.status,200);
 assert.equal(rpcBody.p_amount_minor,-500);
 assert.equal(rpcBody.p_reverses_event_id,"44444444-4444-4444-8444-444444444444");
});

test("service cost evidence is included in protected, audited CSV exports",async()=>{
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url);calls.push({target,method:options.method||"GET",body:options.body?JSON.parse(options.body):null});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.includes("/financial_service_cost_events?"))return json([{id:"cost-1",amount_minor:1500,currency:"UGX"}]);
  if(target.endsWith("/rpc/write_financial_admin_audit"))return json({id:"audit-1"});
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/export",ownerId:owner,query:{kind:"costs"}});
 assert.equal(result.status,200);
 assert.equal(result.body.kind,"costs");
 assert.equal(result.body.rows[0].amount_minor,1500);
 assert.ok(calls.some(x=>x.target.includes("/financial_service_cost_events?")));
 assert.ok(calls.some(x=>x.target.endsWith("/rpc/write_financial_admin_audit")&&x.body.p_action==="finance.export.costs"));
});


test("margin policy API is finance-admin protected and validates currency, thresholds and scope",async()=>{
 let rpcBody=null;
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([]);
  throw new Error("Unauthorized margin policy must not reach RPC");
 });
 const deniedResult=await denied.handle({method:"POST",path:"/api/admin/finance/margin-policies",ownerId:owner,body:{
  scopeType:"global",currency:"UGX",minGrossMarginPct:25,effectiveFrom:"2026-11-01",idempotencyKey:"margin-policy-0001"
 }});
 assert.equal(deniedResult.status,403);
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/add_financial_margin_policy")){
   rpcBody=JSON.parse(options.body);return json({policyId:"44444444-4444-4444-8444-444444444444",duplicate:false});
  }
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"POST",path:"/api/admin/finance/margin-policies",ownerId:owner,body:{
  scopeType:"global",ownerId:owner,currency:"UGX",minGrossMarginPct:101,
  effectiveFrom:"2026-11-01",idempotencyKey:"margin-policy-invalid"
 }});
 assert.equal(invalid.status,400);
 const midMonth=await service.handle({method:"POST",path:"/api/admin/finance/margin-policies",ownerId:owner,body:{
  scopeType:"global",currency:"UGX",minGrossMarginPct:25,effectiveFrom:"2026-11-15",idempotencyKey:"margin-policy-midmonth"
 }});
 assert.equal(midMonth.status,400);
 const valid=await service.handle({method:"POST",path:"/api/admin/finance/margin-policies",ownerId:owner,body:{
  scopeType:"customer",ownerId:owner,currency:"UGX",minGrossMarginPct:35.5,minContributionMinor:5000,
  effectiveFrom:"2026-11-01",effectiveTo:"2027-01-01",idempotencyKey:"margin-policy-0002"
 }});
 assert.equal(valid.status,200);
 assert.equal(rpcBody.p_actor_id,owner);
 assert.equal(rpcBody.p_scope_type,"customer");
 assert.equal(rpcBody.p_owner_id,owner);
 assert.equal(rpcBody.p_currency,"UGX");
 assert.equal(rpcBody.p_min_gross_margin_pct,35.5);
 assert.equal(rpcBody.p_min_contribution_minor,5000);
});

test("margin alert evaluation is protected and delegates to the trusted profitability evaluator",async()=>{
 let called=false;
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([]);
  throw new Error("Unauthorized margin evaluation must not run");
 });
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/margin-alerts/evaluate",ownerId:owner});
 assert.equal(blocked.status,403);
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.endsWith("/rpc/evaluate_financial_margin_alerts")){
   called=true;assert.equal(JSON.parse(options.body).p_actor_id,owner);
   return json({periodMonth:"2026-11-01",evaluatedCustomers:12,policiesApplied:4,alertsCreated:2,alerts:[]});
  }
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/margin-alerts/evaluate",ownerId:owner});
 assert.equal(result.status,200);
 assert.equal(called,true);
 assert.equal(result.body.evaluation.alertsCreated,2);
});

test("margin alert listing validates bounded limits and returns the admin alert ledger",async()=>{
 let rpcBody=null;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/list_financial_margin_alerts")){
   rpcBody=JSON.parse(options.body);return json({count:1,alerts:[{alertType:"negative_contribution",notificationStatus:"pending"}]});
  }
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"GET",path:"/api/admin/finance/margin-alerts",ownerId:owner,query:{limit:"5000"}});
 assert.equal(invalid.status,400);
 const result=await service.handle({method:"GET",path:"/api/admin/finance/margin-alerts",ownerId:owner,query:{limit:"25"}});
 assert.equal(result.status,200);
 assert.equal(rpcBody.p_actor_id,owner);
 assert.equal(rpcBody.p_limit,25);
 assert.equal(result.body.marginAlerts.alerts[0].notificationStatus,"pending");
});


test("shared-cost allocation overview is finance-admin protected and validates its reporting window",async()=>{
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized allocation report must not reach RPC");
 });
 const blocked=await denied.handle({method:"GET",path:"/api/admin/finance/shared-cost-allocations",ownerId:owner,query:{months:"12"}});
 assert.equal(blocked.status,403);
 let rpcBody=null;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/financial_shared_cost_allocation_overview")){
   rpcBody=JSON.parse(options.body);
   return json({months:12,policies:[],batches:[],customers:[],limitations:[]});
  }
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"GET",path:"/api/admin/finance/shared-cost-allocations",ownerId:owner,query:{months:"37"}});
 assert.equal(invalid.status,400);
 const result=await service.handle({method:"GET",path:"/api/admin/finance/shared-cost-allocations",ownerId:owner,query:{months:"12"}});
 assert.equal(result.status,200);
 assert.equal(rpcBody.p_actor_id,owner);
 assert.equal(rpcBody.p_months,12);
 assert.deepEqual(result.body.allocations.batches,[]);
});

test("shared-cost allocation policy API rejects unsupported drivers and binds immutable policy details",async()=>{
 let rpcBody=null;
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized allocation policy must not reach RPC");
 });
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/shared-cost-allocation-policies",ownerId:owner,body:{
  costCategory:"ai_inference",driverType:"image_count",currency:"USD",
  effectiveFrom:"2026-11-01",minimumRecipients:2,idempotencyKey:"allocation-policy-denied"
 }});
 assert.equal(blocked.status,403);
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/add_financial_shared_cost_allocation_policy")){
   rpcBody=JSON.parse(options.body);
   return json({policyId:"44444444-4444-4444-8444-444444444444",duplicate:false,driverType:"inference_tokens"});
  }
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"POST",path:"/api/admin/finance/shared-cost-allocation-policies",ownerId:owner,body:{
  costCategory:"ai_inference",driverType:"image_count",currency:"USD",
  effectiveFrom:"2026-11-01",minimumRecipients:2,idempotencyKey:"allocation-policy-invalid"
 }});
 assert.equal(invalid.status,400);
 const inheritedKey=await service.handle({method:"POST",path:"/api/admin/finance/shared-cost-allocation-policies",ownerId:owner,body:{
  costCategory:"toString",driverType:"includes",currency:"USD",
  effectiveFrom:"2026-11-01",minimumRecipients:2,idempotencyKey:"allocation-policy-prototype"
 }});
 assert.equal(inheritedKey.status,400);
 const valid=await service.handle({method:"POST",path:"/api/admin/finance/shared-cost-allocation-policies",ownerId:owner,body:{
  costCategory:"ai_inference",driverType:"inference_tokens",currency:"UGX",
  effectiveFrom:"2026-11-01",minimumRecipients:2,idempotencyKey:"allocation-policy-0001"
 }});
 assert.equal(valid.status,201);
 assert.equal(rpcBody.p_actor_id,owner);
 assert.equal(rpcBody.p_cost_category,"ai_inference");
 assert.equal(rpcBody.p_driver_type,"inference_tokens");
 assert.equal(rpcBody.p_currency,"UGX");
 assert.equal(rpcBody.p_minimum_recipients,2);
});

test("shared-cost allocation run API validates month, currency and category before calling the database",async()=>{
 let rpcBody=null;
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized allocation run must not reach RPC");
 });
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/shared-cost-allocations/run",ownerId:owner,body:{
  periodMonth:"2026-11-01",currency:"USD",costCategory:"ai_inference"
 }});
 assert.equal(blocked.status,403);
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.endsWith("/rpc/run_financial_shared_cost_allocation")){
   rpcBody=JSON.parse(options.body);
   return json({status:"allocated",sourcePoolMinor:1001,allocatedMinor:1001,unallocatedMinor:0,recipientCount:2});
  }
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"POST",path:"/api/admin/finance/shared-cost-allocations/run",ownerId:owner,body:{
  periodMonth:"2026-13-01",currency:"USD",costCategory:"ai_inference"
 }});
 assert.equal(invalid.status,400);
 const valid=await service.handle({method:"POST",path:"/api/admin/finance/shared-cost-allocations/run",ownerId:owner,body:{
  periodMonth:"2026-11-01",currency:"USD",costCategory:"ai_inference"
 }});
 assert.equal(valid.status,200);
 assert.equal(rpcBody.p_actor_id,owner);
 assert.equal(rpcBody.p_period_month,"2026-11-01");
 assert.equal(rpcBody.p_currency,"USD");
 assert.equal(rpcBody.p_cost_category,"ai_inference");
 assert.equal(valid.body.run.allocatedMinor,1001);
});


test("predictive workload estimates are admin-only, currency-safe and explicitly forecasts",async()=>{
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized workload estimate must not reach another service.");
 });
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/workload-estimates",ownerId:owner,body:{}});
 assert.equal(blocked.status,403);
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  throw new Error("Workload estimate must be computed locally, not persisted.");
 });
 const invalid=await service.handle({method:"POST",path:"/api/admin/finance/workload-estimates",ownerId:owner,body:{
  rateCard:{provider:"provider-a",model:"model-a",currency:"UGX",version:"v1",imageMinorPerImage:100},
  workload:{operation:"image",currency:"USD",imageCount:2}
 }});
 assert.equal(invalid.status,400);
 assert.equal(invalid.body.error.code,"WORKLOAD_CURRENCY_MISMATCH");
 const result=await service.handle({method:"POST",path:"/api/admin/finance/workload-estimates",ownerId:owner,body:{
  rateCard:{provider:"provider-a",model:"model-a",currency:"UGX",version:"v1",imageMinorPerImage:100},
  workload:{operation:"image",currency:"UGX",imageCount:2,successfulOutputs:1},
  pricing:{targetMarginBps:6000,paymentFeeBps:300,supportReserveBps:500}
 }});
 assert.equal(result.status,200);
 assert.equal(result.body.estimate.estimateType,"forecast_not_actual");
 assert.equal(result.body.estimate.costRange.baseMinor,200);
 assert.ok(result.body.estimate.pricing.minimumPriceMinor>200);
});

test("model economics comparison is admin-only and returns shadow recommendations without routing",async()=>{
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized comparison must not reach calculation.");
 });
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/model-economics-comparison",ownerId:owner,body:{}});
 assert.equal(blocked.status,403);
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);
  throw new Error("Comparison must not call provider APIs or persist routing.");
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/model-economics-comparison",ownerId:owner,body:{
  workload:{operation:"image",currency:"UGX",imageCount:1},
  rateCards:[
   {rateCard:{provider:"provider-a",model:"model-a",currency:"UGX",version:"v1",imageMinorPerImage:50},samples:30,qualityScore:.95,p95LatencyMs:200,evaluationVersion:"eval-1"},
   {rateCard:{provider:"provider-b",model:"model-b",currency:"UGX",version:"v1",imageMinorPerImage:25},samples:4,qualityScore:.99,p95LatencyMs:100,evaluationVersion:"eval-1"}
  ],
  limits:{maxCostMinor:1000,maxLatencyMs:1000,minQualityScore:.9}
 }});
 assert.equal(result.status,200);
 assert.equal(result.body.comparison.mode,"shadow_only");
 assert.equal(result.body.comparison.automaticRouting,false);
 assert.equal(result.body.comparison.recommended.provider,"provider-a");
});


test("financial reconciliation preview is admin-only, read-only and supports invoice and settlement checks",async()=>{
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized reconciliation must not reach data processing.");
 });
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/reconciliation-preview",ownerId:owner,body:{invoiceHeaders:[]}});
 assert.equal(blocked.status,403);
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  throw new Error("Read-only preview must not call database RPCs or payment providers.");
 });
 const missing=await service.handle({method:"POST",path:"/api/admin/finance/reconciliation-preview",ownerId:owner,body:{invoiceLines:[]}});
 assert.equal(missing.status,400);
 assert.equal(missing.body.error.code,"FINANCIAL_RECON_INPUT_INCOMPLETE");
 const result=await service.handle({method:"POST",path:"/api/admin/finance/reconciliation-preview",ownerId:owner,body:{
  invoiceHeaders:[
   {provider:"p",invoiceReference:"inv-1",currency:"USD",totalMinor:1000},
   {provider:"p",invoiceReference:"INV 1",currency:"USD",totalMinor:1000},
   {provider:"p",invoiceReference:"INV-2",currency:"USD",totalMinor:500}
  ],
  invoiceLines:[{provider:"p",invoiceReference:"INV-2",currency:"USD",amountMinor:450}],
  statementRows:[{provider:"flw",providerReference:"tx-1",currency:"UGX",amountMinor:10000}],
  payments:[{id:"payment-1",provider:"flw",providerReference:"TX 1",currency:"UGX",amountMinor:10000,status:"settled"}]
 }});
 assert.equal(result.status,200);
 assert.equal(result.body.reconciliation.mode,"read_only_preview");
 assert.equal(result.body.reconciliation.automaticPosting,false);
 assert.equal(result.body.reconciliation.duplicateInvoices.duplicateGroups,1);
 assert.equal(result.body.reconciliation.paymentSettlement.counts.matched,1);
 assert.equal(result.body.reconciliation.invoiceHeaderTotals.counts.variance,1);
});

test("financial reconciliation preview rejects non-admins and malformed financial values without writes",async()=>{
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);
  throw new Error("Malformed data must fail before any write.");
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/reconciliation-preview",ownerId:owner,body:{
  statementRows:[{provider:"flw",providerReference:"tx-1",currency:"USD",amountMinor:12.5}],payments:[]
 }});
 assert.equal(result.status,400);
 assert.equal(result.body.error.code,"FINANCIAL_RECON_AMOUNT_INVALID");
});


test("financial close readiness is admin-only, read-only and requires independent evidence-backed review",async()=>{
 const denied=api(async(url)=>{if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);throw new Error("Denied close assessment must not read or write financial data.");});
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/close/readiness",ownerId:owner,body:{period:"2026-10",tasks:[],reconciliations:[],evidence:[]}});
 assert.equal(blocked.status,403);
 const service=api(async(url)=>{if(String(url).includes("/platform_admins?"))return json([{role:"billing_admin"}]);throw new Error("Close readiness must not persist or post financial records.");});
 const hash="a".repeat(64);
 const ready=await service.handle({method:"POST",path:"/api/admin/finance/close/readiness",ownerId:owner,body:{
  period:"2026-10",asOf:"2026-11-04T10:00:00Z",
  evidence:[{evidenceId:"bank",sha256:hash,sourceType:"bank_statement",sourceReference:"statement-1",period:"2026-10",recordedAt:"2026-11-01T10:00:00Z",recordedBy:"preparer"}],
  tasks:[{taskId:"cash",title:"Cash reconciliation",ownerId:"preparer",reviewerId:"reviewer",status:"completed",dueAt:"2026-11-03T17:00:00Z",completedAt:"2026-11-02T12:00:00Z",evidenceRefs:["bank"],approval:{preparedBy:"preparer",approvedBy:"reviewer",approvedAt:"2026-11-02T14:00:00Z",decision:"approved"}}],
  reconciliations:[{reconciliationId:"cash-ledger",status:"approved",currency:"UGX",varianceMinor:0,preparedBy:"preparer",reviewedBy:"reviewer",evidenceRefs:["bank"]}]
 }});
 assert.equal(ready.status,200);
 assert.equal(ready.body.assessment.status,"eligible_for_human_signoff");
 assert.equal(ready.body.assessment.automaticClose,false);
 assert.equal(ready.body.assessment.automaticJournalPosting,false);
 assert.equal(ready.body.assessment.controls.signoffRecorded,false);
 const incomplete=await service.handle({method:"POST",path:"/api/admin/finance/close/readiness",ownerId:owner,body:{period:"2026-10",tasks:[{taskId:"cash",title:"Cash",ownerId:"same",reviewerId:"same",status:"in_progress",evidenceRefs:[]}],reconciliations:[],evidence:[]}});
 assert.equal(incomplete.status,200);
 assert.equal(incomplete.body.assessment.status,"blocked");
 assert.ok(incomplete.body.assessment.blockers.some(x=>x.issue==="preparer_reviewer_conflict"));
 assert.ok(incomplete.body.assessment.tasks[0].issues.includes("missing_evidence"));
});


test("financial audit ledger enforces admin access, idempotent append and independent chain verification",async()=>{
 const denied=api(async(url)=>{if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);throw new Error("Unauthorized audit requests must not reach ledger storage.");});
 const forbidden=await denied.handle({method:"POST",path:"/api/admin/finance/audit/events",ownerId:owner,body:{subjectOwnerId:"33333333-3333-4333-8333-333333333333",eventType:"close_period.created",idempotencyKey:"audit-close-2026-10",payload:{period:"2026-10"}}});
 assert.equal(forbidden.status,403);
 let appended=null;
 const service=api(async(url,options={})=>{
  const u=String(url);
  if(u.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(u.includes("/financial_audit_events?select=event_id"))return json([]);
  if(u.endsWith("/rpc/get_financial_audit_head"))return json({sequence:0,headHash:"0".repeat(64)});
  if(u.endsWith("/rpc/append_financial_audit_event")){appended=JSON.parse(options.body);return json({duplicate:false,sequence:1,eventHash:appended.p_event_hash});}
  if(u.includes("/financial_audit_events?select=event_envelope"))return json([]);
  throw new Error("Unexpected audit request: "+u);
 });
 const created=await service.handle({method:"POST",path:"/api/admin/finance/audit/events",ownerId:owner,body:{subjectOwnerId:"33333333-3333-4333-8333-333333333333",eventType:"close_period.created",idempotencyKey:"audit-close-2026-10",payload:{period:"2026-10"}}});
 assert.equal(created.status,201);
 assert.equal(created.body.event.sequence,1);
 assert.ok(/^[a-f0-9]{64}$/.test(created.body.event.eventHash));
 assert.equal(appended.p_event_envelope.ownerId,"33333333-3333-4333-8333-333333333333");
 assert.equal(appended.p_event_envelope.actorId,owner);
 assert.equal(appended.p_event_envelope.eventType,"close_period.created");
 assert.equal(appended.p_event_envelope.sequence,1);
 const history=await service.handle({method:"GET",path:"/api/admin/finance/audit/events",ownerId:owner,query:{ownerId:"33333333-3333-4333-8333-333333333333"}});
 assert.equal(history.status,200);
 assert.equal(history.body.head.sequence,0);
 const verified=await service.handle({method:"GET",path:"/api/admin/finance/audit/verify",ownerId:owner,query:{ownerId:"33333333-3333-4333-8333-333333333333"}});
 assert.equal(verified.status,200);
 assert.equal(verified.body.verification.valid,true);
 assert.equal(verified.body.verification.complete,true);
});

test("audit event API rejects unsupported event types and requires idempotency",async()=>{
 const service=api(async(url)=>{const u=String(url);if(u.includes("/platform_admins?"))return json([{role:"billing_admin"}]);if(u.includes("/financial_audit_events?select=event_id"))return json([]);if(u.endsWith("/rpc/get_financial_audit_head"))return json({sequence:0,headHash:"0".repeat(64)});throw new Error("Invalid audit payload must fail before storage.");});
 const missing=await service.handle({method:"POST",path:"/api/admin/finance/audit/events",ownerId:owner,body:{eventType:"close_period.created",payload:{period:"2026-10"}}});
 assert.equal(missing.status,400);
 assert.equal(missing.body.error.code,"FINANCIAL_AUDIT_IDEMPOTENCY_INVALID");
 const invalid=await service.handle({method:"POST",path:"/api/admin/finance/audit/events",ownerId:owner,body:{eventType:"ledger.deleted",idempotencyKey:"audit-invalid-event",payload:{}}});
 assert.equal(invalid.status,400);
 assert.equal(invalid.body.error.code,"FINANCIAL_AUDIT_EVENT_TYPE_INVALID");
});


test("financial audit export is administrator-only and marks unsigned bundles honestly",async()=>{
 const denied=api(async(url)=>{if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);throw new Error("Unauthorized audit export must not access records.");});
 const forbidden=await denied.handle({method:"GET",path:"/api/admin/finance/audit/export",ownerId:owner});
 assert.equal(forbidden.status,403);
 const service=api(async(url)=>{
  const u=String(url);
  if(u.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(u.endsWith("/rpc/get_financial_audit_head"))return json({sequence:0,headHash:"0".repeat(64)});
  if(u.includes("/financial_audit_events?select=event_envelope"))return json([]);
  throw new Error("Unexpected audit export request: "+u);
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/audit/export",ownerId:owner});
 assert.equal(result.status,200);
 assert.equal(result.body.bundle.format,"executive-visuals.financial-audit-export");
 assert.equal(result.body.bundle.signature.status,"unsigned_key_not_configured");
 assert.equal(result.body.bundle.verification.valid,true);
 assert.equal(result.body.bundle.eventCount,0);
});


test("persistent financial close commands are admin-only and atomically pair domain commands with audit envelopes",async()=>{
 const denied=api(async(url)=>{if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);throw new Error("Unauthorized close commands must not reach storage.");});
 const forbidden=await denied.handle({method:"POST",path:"/api/admin/finance/close/commands",ownerId:owner,body:{command:"create_period",idempotencyKey:"close-period-2026-11",payload:{}}});
 assert.equal(forbidden.status,403);

 let commandCall=null;
 const service=api(async(url,options={})=>{
  const u=String(url);
  if(u.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(u.endsWith("/rpc/get_financial_audit_head"))return json({sequence:7,headHash:"a".repeat(64)});
  if(u.endsWith("/rpc/execute_financial_close_command")){commandCall=JSON.parse(options.body);return json({duplicate:false,period:{id:"44444444-4444-4444-8444-444444444444",status:"open"}});}
  if(u.endsWith("/rpc/get_financial_close_overview"))return json({periods:[{status:"open"}],tasks:[],approvals:[]});
  throw new Error("Unexpected close workflow request: "+u);
 });
 const payload={periodStart:"2026-11-01",periodEnd:"2026-11-30",currency:"UGX",approvalStages:[
  {stageKey:"finance_manager",reviewerId:"55555555-5555-4555-8555-555555555555"},
  {stageKey:"controller",reviewerId:"66666666-6666-4666-8666-666666666666"}
 ]};
 const created=await service.handle({method:"POST",path:"/api/admin/finance/close/commands",ownerId:owner,body:{command:"create_period",idempotencyKey:"close-period-2026-11",payload}});
 assert.equal(created.status,201);
 assert.equal(commandCall.p_command,"create_period");
 assert.equal(commandCall.p_event_envelope.eventType,"close_period.created");
 assert.equal(commandCall.p_event_envelope.ownerId,owner);
 assert.equal(commandCall.p_event_envelope.actorId,owner);
 assert.deepEqual(commandCall.p_event_envelope.payload,payload);
 assert.equal(commandCall.p_event_envelope.sequence,8);
 assert.equal(commandCall.p_event_envelope.previousHash,"a".repeat(64));
 assert.match(commandCall.p_event_hash,/^[a-f0-9]{64}$/);
 const overview=await service.handle({method:"GET",path:"/api/admin/finance/close",ownerId:owner});
 assert.equal(overview.status,200);
 assert.equal(overview.body.close.periods[0].status,"open");
});

test("financial close API rejects unsupported commands, malformed payloads and missing idempotency",async()=>{
 const service=api(async(url)=>{if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);throw new Error("Invalid close commands must fail before database access.");});
 const unsupported=await service.handle({method:"POST",path:"/api/admin/finance/close/commands",ownerId:owner,body:{command:"post_journal",idempotencyKey:"close-invalid-command",payload:{}}});
 assert.equal(unsupported.status,400);
 assert.equal(unsupported.body.error.code,"FINANCIAL_CLOSE_COMMAND_INVALID");
 const malformed=await service.handle({method:"POST",path:"/api/admin/finance/close/commands",ownerId:owner,body:{command:"create_period",idempotencyKey:"close-invalid-payload",payload:[]}});
 assert.equal(malformed.status,400);
 assert.equal(malformed.body.error.code,"FINANCIAL_CLOSE_PAYLOAD_INVALID");
 const missing=await service.handle({method:"POST",path:"/api/admin/finance/close/commands",ownerId:owner,body:{command:"create_period",payload:{}}});
 assert.equal(missing.status,400);
 assert.equal(missing.body.error.code,"FINANCIAL_AUDIT_IDEMPOTENCY_INVALID");
});


test("reconciliation commands use the dedicated atomic audit RPC and remain administrator-only",async()=>{
 const denied=api(async(url)=>{if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);throw new Error("Unauthorized reconciliation commands must not reach storage.");});
 const forbidden=await denied.handle({method:"POST",path:"/api/admin/finance/close/commands",ownerId:owner,body:{command:"record_reconciliation",idempotencyKey:"recon-record-denied",payload:{}}});
 assert.equal(forbidden.status,403);
 let rpcName="",rpcBody=null;
 const service=api(async(url,options={})=>{
  const u=String(url);
  if(u.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(u.endsWith("/rpc/get_financial_audit_head"))return json({sequence:0,headHash:"0".repeat(64)});
  if(u.endsWith("/rpc/execute_financial_reconciliation_command")){rpcName="execute_financial_reconciliation_command";rpcBody=JSON.parse(options.body);return json({duplicate:false,reconciliation:{status:"pending"}});}
  throw new Error("Unexpected reconciliation request: "+u);
 });
 const payload={periodId:"44444444-4444-4444-8444-444444444444",reconciliationKey:"operating_bank",accountName:"Operating bank",currency:"UGX",ledgerBalanceMinor:100000,statementBalanceMinor:100000,evidenceReference:"private://bank-statement",evidenceSha256:"a".repeat(64),reviewerId:"55555555-5555-4555-8555-555555555555"};
 const result=await service.handle({method:"POST",path:"/api/admin/finance/close/commands",ownerId:owner,body:{command:"record_reconciliation",idempotencyKey:"recon-record-2026-11",payload}});
 assert.equal(result.status,201);
 assert.equal(rpcName,"execute_financial_reconciliation_command");
 assert.equal(rpcBody.p_command,"record_reconciliation");
 assert.equal(rpcBody.p_event_envelope.eventType,"reconciliation.recorded");
 assert.deepEqual(rpcBody.p_event_envelope.payload,payload);
});


test("workload cost variance endpoint is admin-only and does not persist or post actual costs",async()=>{
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Denied workload variance must not access provider or ledger services.");
 });
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/workload-variance",ownerId:owner,body:{}});
 assert.equal(blocked.status,403);
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  throw new Error("Workload variance is an in-memory analysis and must not persist.");
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/workload-variance",ownerId:owner,body:{
  estimate:{estimateType:"forecast_not_actual",estimateVersion:"1.0",rateCardVersion:"r1",provider:"provider-a",model:"video-model",operation:"video",currency:"UGX",costRange:{lowMinor:900,baseMinor:1000,highMinor:1100}},
  actuals:[{sourceId:"invoice-1",sourceType:"provider_invoice",amountMinor:1050,currency:"UGX",evidenceReference:"private://invoice/1",evidenceSha256:"a".repeat(64),observedAt:"2026-11-10T10:00:00Z"}],
  acceptedOutputs:3,rejectedOutputs:1
 }});
 assert.equal(result.status,200);
 assert.equal(result.body.variance.variance.amountMinor,50);
 assert.equal(result.body.variance.outputs.actualUnitCostMinor,350);
});

test("subscription cancellation reconciliation requires billing admin and exact review inputs",async()=>{
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("A denied reviewer must not reach reconciliation RPC.");
 });
 const blocked=await denied.handle({method:"POST",path:"/api/admin/subscriptions/reconciliation/resolve",ownerId:owner,
  body:{eventId:"44444444-4444-4444-8444-444444444444",subscriptionId:"55555555-5555-4555-8555-555555555555",reason:"Verified provider cancellation"}});
 assert.equal(blocked.status,403);
 const service=api(async(url,options={})=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(String(url).endsWith("/rpc/reconcile_flutterwave_subscription_cancellation")){
   const body=JSON.parse(options.body);
   assert.equal(body.p_actor_id,owner);
   assert.equal(body.p_event_id,"44444444-4444-4444-8444-444444444444");
   assert.equal(body.p_subscription_id,"55555555-5555-4555-8555-555555555555");
   assert.equal(body.p_reason,"Operator matched the provider subscription ID and customer email.");
   return json({resolved:true,idempotentReplay:false,subscriptionId:body.p_subscription_id});
  }
  throw new Error("Unexpected request: "+String(url));
 });
 const invalid=await service.handle({method:"POST",path:"/api/admin/subscriptions/reconciliation/resolve",ownerId:owner,
  body:{eventId:"bad",subscriptionId:"55555555-5555-4555-8555-555555555555",reason:"too short"}});
 assert.equal(invalid.status,400);
 const result=await service.handle({method:"POST",path:"/api/admin/subscriptions/reconciliation/resolve",ownerId:owner,
  body:{eventId:"44444444-4444-4444-8444-444444444444",subscriptionId:"55555555-5555-4555-8555-555555555555",
   reason:"Operator matched the provider subscription ID and customer email."}});
 assert.equal(result.status,200);
 assert.equal(result.body.reconciliation.resolved,true);
});

test("subscription cancellation reconciliation keeps ambiguous provider identity in review",async()=>{
 const service=api(async(url,options={})=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);
  if(String(url).endsWith("/rpc/reconcile_flutterwave_subscription_cancellation"))
   return json({resolved:false,reviewRequired:true,reason:"provider_plan_id_mismatch"});
  throw new Error("Unexpected request: "+String(url));
 });
 const result=await service.handle({method:"POST",path:"/api/admin/subscriptions/reconciliation/resolve",ownerId:owner,
  body:{eventId:"44444444-4444-4444-8444-444444444444",subscriptionId:"55555555-5555-4555-8555-555555555555",
   reason:"Operator reviewed provider event against local subscription."}});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"SUBSCRIPTION_RECONCILIATION_REQUIRES_REVIEW");
 assert.equal(result.body.reconciliation.reviewRequired,true);
});
