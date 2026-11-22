import test from "node:test";
import assert from "node:assert/strict";
import {createProviderSubscriptionBilling} from "../provider-subscription-billing.mjs";

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
const owner="11111111-1111-4111-8111-111111111111";
const paymentId="22222222-2222-4222-8222-222222222222";
const reserved={paymentId,txRef:"EVC-batch66-credit-pack",amountMinor:15000,currency:"UGX",creditUnits:5000,status:"pending",idempotentReplay:false};
const env={
  supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
  paddleReturnUrl:"https://executive-visuals.example/billing/return",
  pesapalCallbackUrl:"https://executive-visuals.example/billing/return",
  pesapalNotificationId:"ipn-test"
};

test("Pesapal credit-pack checkout uses server reservation and returns the hosted checkout",async()=>{
  const calls=[];
  let payment={id:paymentId,owner_id:owner,provider:"pesapal",provider_transaction_id:null,
    tx_ref:reserved.txRef,amount_minor:15000,currency:"UGX",status:"pending",
    metadata:{payment_purpose:"credit_pack_purchase",product_code:"creator-pack-01",credit_units:5000}};
  let checkoutCalls=0;
  const providers={
    paddle:{createCheckout:async()=>({}),verifyWebhook:()=>({})},
    pesapal:{
      createCheckout:async input=>{
        checkoutCalls++;assert.equal(input.amount,15000);assert.equal(input.currency,"UGX");
        assert.equal(input.reference,reserved.txRef);
        return {provider:"pesapal",trackingId:"track-66",merchantReference:reserved.txRef,
          checkoutUrl:"https://pay.pesapal.com/order/track-66",status:"pending"};
      },
      handleNotification:async(query,expected)=>{
        assert.equal(query.OrderTrackingId,"track-66");
        assert.deepEqual(expected,{expectedAmount:15000,expectedCurrency:"UGX"});
        return {provider:"pesapal",trackingId:"track-66",merchantReference:reserved.txRef,
          amount:15000,currency:"UGX",confirmationCode:"confirm-66",paymentMethod:"MTN"};
      }
    }
  };
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);const method=options.method;
    calls.push({method,path:target.pathname,body:options.body?JSON.parse(options.body):null});
    if(target.pathname.endsWith("/rpc/reserve_credit_pack_purchase"))return json(reserved);
    if(target.pathname.endsWith("/payment_transactions")&&method==="GET")return json([payment]);
    if(target.pathname.endsWith("/payment_transactions")&&method==="PATCH"){
      payment={...payment,provider_transaction_id:"track-66",metadata:{...payment.metadata,
        provider_checkout_id:"track-66",provider_checkout_url:"https://pay.pesapal.com/order/track-66"}};
      return new Response(null,{status:204});
    }
    if(target.pathname.endsWith("/rpc/finalize_credit_pack_purchase"))return json({status:"successful",creditUnits:5000,creditGrantInserted:true});
    throw new Error("Unexpected database request "+method+" "+target.pathname);
  };
  const billing=createProviderSubscriptionBilling({...env,providers,fetchImpl});
  const result=await billing.handle({method:"POST",path:"/api/billing/credits/topup-checkout",ownerId:owner,
    idempotencyKey:"credit-pack-checkout-66-0001",
    body:{provider:"pesapal",productCode:"creator-pack-01",email:"buyer@example.com",
      firstName:"Test",lastName:"Buyer",phone:"256700000000"}});
  assert.equal(result.status,202);
  assert.equal(result.body.checkout.checkoutUrl,"https://pay.pesapal.com/order/track-66");
  assert.equal(result.body.checkout.creditUnits,5000);
  assert.equal(checkoutCalls,1);

  const replay=await billing.handle({method:"POST",path:"/api/billing/credits/topup-checkout",ownerId:owner,
    idempotencyKey:"credit-pack-checkout-66-0001",
    body:{provider:"pesapal",productCode:"creator-pack-01",email:"buyer@example.com",
      firstName:"Test",lastName:"Buyer",phone:"256700000000"}});
  assert.equal(replay.status,200);
  assert.equal(replay.body.checkout.idempotentReplay,true);
  assert.equal(checkoutCalls,1);
});

test("Pesapal credit-pack IPN re-queries status and calls verified finalization RPC",async()=>{
  const calls=[];
  const payment={id:paymentId,owner_id:owner,provider:"pesapal",provider_transaction_id:"track-66",
    tx_ref:reserved.txRef,amount_minor:15000,currency:"UGX",status:"pending",
    metadata:{payment_purpose:"credit_pack_purchase",product_code:"creator-pack-01",credit_units:5000}};
  const providers={
    paddle:{createCheckout:async()=>({}),verifyWebhook:()=>({})},
    pesapal:{
      createCheckout:async()=>({}),
      handleNotification:async(query,expected)=>{
        assert.deepEqual(expected,{expectedAmount:15000,expectedCurrency:"UGX"});
        return {provider:"pesapal",trackingId:"track-66",merchantReference:reserved.txRef,
          amount:15000,currency:"UGX",confirmationCode:"confirm-66",paymentMethod:"MTN"};
      }
    }
  };
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);const method=options.method;
    calls.push({method,path:target.pathname,body:options.body?JSON.parse(options.body):null});
    if(target.pathname.endsWith("/payment_transactions")&&method==="GET")return json([payment]);
    if(target.pathname.endsWith("/rpc/finalize_credit_pack_purchase"))return json({status:"successful",creditUnits:5000,creditGrantInserted:true});
    throw new Error("Unexpected database request "+method+" "+target.pathname);
  };
  const billing=createProviderSubscriptionBilling({...env,providers,fetchImpl});
  const result=await billing.handlePesapalIpn({OrderNotificationType:"IPNCHANGE",
    OrderTrackingId:"track-66",OrderMerchantReference:reserved.txRef});
  assert.equal(result.status,200);
  assert.equal(result.body.result.paymentPurpose,"credit_pack_purchase");
  const finalize=calls.find(call=>call.path.endsWith("/rpc/finalize_credit_pack_purchase"));
  assert.ok(finalize);
  assert.equal(finalize.body.p_provider_transaction_id,"track-66");
  assert.deepEqual(finalize.body.p_provider_payload,{
    status:"succeeded",amount_minor:15000,currency:"UGX",reference:reserved.txRef,
    confirmation_code:"confirm-66",payment_method:"MTN"
  });
});
