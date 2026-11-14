import test from "node:test";
import assert from "node:assert/strict";
import {createProviderSubscriptionBilling,getProviderSubscriptionBillingReadiness} from "../provider-subscription-billing.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const paymentId="22222222-2222-4222-8222-222222222222";
const subscriptionId="33333333-3333-4333-8333-333333333333";
const payment={
  id:paymentId,owner_id:owner,provider:"paddle",provider_transaction_id:"txn-1",
  tx_ref:"EVP-order-1",amount_minor:5000,currency:"USD",status:"pending",
  metadata:{payment_purpose:"subscription_purchase",subscription_id:subscriptionId,plan_code:"creator",provider_price_id:"pri_01creator123"}
};
const env={
  PADDLE_PESAPAL_BILLING_ENABLED:"true",PADDLE_API_KEY:"paddle-key",PADDLE_WEBHOOK_SECRET:"paddle-secret",
  PADDLE_RETURN_URL:"https://app.example/billing/return",PADDLE_API_BASE_URL:"https://sandbox-api.paddle.com",
  PESAPAL_CONSUMER_KEY:"pesapal-key",PESAPAL_CONSUMER_SECRET:"pesapal-secret",
  PESAPAL_IPN_ID:"ipn-1",PESAPAL_CALLBACK_URL:"https://app.example/api/billing/return",
  PESAPAL_API_BASE_URL:"https://cybqa.pesapal.com/pesapalv3",
  SUPABASE_URL:"https://project.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"service-role"
};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
const empty=(status=204)=>new Response(null,{status});

test("provider billing readiness requires both sandbox credentials, callbacks and server database access",()=>{
  assert.equal(getProviderSubscriptionBillingReadiness(env).ready,true);
  assert.equal(getProviderSubscriptionBillingReadiness({...env,PESAPAL_IPN_ID:""}).ready,false);
  assert.equal(getProviderSubscriptionBillingReadiness({...env,SUPABASE_SERVICE_ROLE_KEY:""}).ready,false);
  assert.equal(getProviderSubscriptionBillingReadiness({...env,PADDLE_PESAPAL_BILLING_ENABLED:"false"}).ready,false);
  assert.equal(getProviderSubscriptionBillingReadiness({...env,PADDLE_API_BASE_URL:"https://api.paddle.com",PADDLE_ALLOW_LIVE:"false"}).ready,false);
  assert.equal(getProviderSubscriptionBillingReadiness({...env,PESAPAL_API_BASE_URL:"https://pay.pesapal.com/v3",PESAPAL_ALLOW_LIVE:"false"}).ready,false);
});

test("Paddle customer portal route checks subscription ownership before creating a portal session",async()=>{
  const calls=[];
  const providers={
    paddle:{createCheckout:async()=>({}),verifyWebhook:()=>({}),
      createCustomerPortalSession:async input=>{calls.push(input);return {portalUrl:"https://customer-portal.paddle.com/subscription?token=abc"};}},
    pesapal:{createCheckout:async()=>({}),handleNotification:async()=>({})}
  };
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);calls.push([options.method,target.pathname,target.search]);
    if(target.pathname.endsWith("/customer_subscriptions"))return json([{
      id:subscriptionId,provider:"paddle",provider_customer_id:"ctm_01abcdefghijklmnopqrstuvwx",
      provider_subscription_id:"sub_01abcdefghijklmnopqrstuvwx"
    }]);
    throw new Error("unexpected database request "+target.pathname);
  };
  const billing=createProviderSubscriptionBilling({supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl});
  const result=await billing.handle({method:"POST",path:"/api/billing/subscription/provider-portal",
    ownerId:owner,body:{subscriptionId}});
  assert.equal(result.status,200);
  assert.equal(result.body.portal.portalUrl,"https://customer-portal.paddle.com/subscription?token=abc");
  assert.deepEqual(calls.find(x=>x.customerId),{
    customerId:"ctm_01abcdefghijklmnopqrstuvwx",subscriptionId:"sub_01abcdefghijklmnopqrstuvwx"
  });
});

test("authenticated provider checkout reserves ledger price and persists hosted checkout before returning",async()=>{
  const calls=[];
  const providers={
    paddle:{createCheckout:async input=>{calls.push(["paddle",input]);return {provider:"paddle",transactionId:"txn-1",checkoutUrl:"https://checkout.paddle.com/txn-1"};},verifyWebhook:()=>({})},
    pesapal:{createCheckout:async()=>{throw new Error("unexpected");},handleNotification:async()=>({})}
  };
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);calls.push([options.method,target.pathname,target.search]);
    if(target.pathname.endsWith("/rpc/reserve_subscription_purchase_for_provider"))return json({
      paymentId,subscriptionId,txRef:"EVP-order-1",amountMinor:5000,amountMajor:50,currency:"USD",
      provider:"paddle",providerPriceId:"pri_01creator123",billingInterval:"monthly",status:"pending",idempotentReplay:false
    });
    if(target.pathname.endsWith("/payment_transactions")&&options.method==="GET")return json([payment]);
    if(target.pathname.endsWith("/payment_transactions")&&options.method==="PATCH")return empty();
    throw new Error("unexpected database request "+target.pathname);
  };
  const billing=createProviderSubscriptionBilling({supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl});
  const result=await billing.handle({
    method:"POST",path:"/api/billing/subscription/provider-checkout",ownerId:owner,
    idempotencyKey:"checkout-key-0001",body:{provider:"paddle",planCode:"creator",email:"buyer@example.com"}
  });
  assert.equal(result.status,202);
  assert.equal(result.body.checkout.checkoutUrl,"https://checkout.paddle.com/txn-1");
  assert.equal(calls.find(x=>x[0]==="paddle")[1].priceId,"pri_01creator123");
  assert.equal(calls.find(x=>x[0]==="paddle")[1].paymentId,paymentId);
  assert.ok(calls.some(x=>x[0]==="PATCH"&&x[1].endsWith("/payment_transactions")));
});

test("authenticated Pesapal manual renewal reserves the active subscription and persists its checkout",async()=>{
  const calls=[];
  const pesapalPayment={...payment,provider:"pesapal",provider_transaction_id:null,tx_ref:"EVR-order-1",currency:"UGX",
    amount_minor:50000,metadata:{...payment.metadata,payment_purpose:"subscription_renewal"}};
  const providers={
    paddle:{createCheckout:async()=>({}),verifyWebhook:()=>({})},
    pesapal:{createCheckout:async input=>{calls.push(["checkout",input]);return {provider:"pesapal",trackingId:"track-renewal",checkoutUrl:"https://pay.pesapal.com/order/renewal"};},
      handleNotification:async()=>({})}
  };
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);calls.push([options.method,target.pathname]);
    if(target.pathname.endsWith("/rpc/reserve_pesapal_subscription_renewal"))return json({
      paymentId,subscriptionId,txRef:"EVR-order-1",amountMinor:50000,amountMajor:50000,currency:"UGX",status:"pending",idempotentReplay:false
    });
    if(target.pathname.endsWith("/payment_transactions")&&options.method==="GET")return json([pesapalPayment]);
    if(target.pathname.endsWith("/payment_transactions")&&options.method==="PATCH")return empty();
    throw new Error("unexpected database request "+target.pathname);
  };
  const billing=createProviderSubscriptionBilling({supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl});
  const result=await billing.handle({method:"POST",path:"/api/billing/subscription/provider-renewal-checkout",
    ownerId:owner,idempotencyKey:"pesapal-renewal-0001",
    body:{subscriptionId,firstName:"Test",lastName:"Buyer",email:"buyer@example.com",phone:"256771234567"}});
  assert.equal(result.status,202);
  assert.equal(result.body.checkout.provider,"pesapal");
  assert.equal(result.body.checkout.checkoutUrl,"https://pay.pesapal.com/order/renewal");
  const order=calls.find(x=>x[0]==="checkout")[1];
  assert.equal(order.amount,50000);
  assert.equal(order.currency,"UGX");
  assert.equal(order.accountNumber,undefined);
});

test("verified Paddle transaction webhook settles only the matching reserved ledger payment",async()=>{
  const calls=[];
  const providers={
    paddle:{createCheckout:async()=>({}),verifyWebhook:()=>({
      provider:"paddle",eventId:"evt-1",eventType:"transaction.completed",ownerId:owner,planCode:"creator",
      paymentId,reference:"EVP-order-1",providerTransactionId:"txn-1",providerCustomerId:"ctm-1",
      providerSubscriptionId:"sub_01abcdefghijklmnopqrstuvwxyz",providerPriceId:"pri_01creator123",origin:"web",amountMinor:5000,totalPaidMinor:5500,discountMinor:0,currency:"USD",occurredAt:"2026-11-14T10:00:00Z"
    })},
    pesapal:{createCheckout:async()=>({}),handleNotification:async()=>({})}
  };
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);calls.push([options.method,target.pathname]);
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="POST")return empty(201);
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="PATCH")return empty();
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="GET")return json([]);
    if(target.pathname.endsWith("/payment_transactions")&&options.method==="GET")return json([payment]);
    if(target.pathname.endsWith("/rpc/finalize_subscription_purchase_for_provider"))return json({status:"active",subscriptionId});
    throw new Error("unexpected database request "+target.pathname);
  };
  const billing=createProviderSubscriptionBilling({supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl});
  const result=await billing.handlePaddleWebhook({rawBody:Buffer.from("{}"),signature:"signed"});
  assert.equal(result.status,200);
  assert.equal(result.body.applied,true);
  assert.ok(calls.some(x=>x[1].endsWith("/rpc/finalize_subscription_purchase_for_provider")));
});

test("verified Pesapal renewal IPN extends the existing subscription through the renewal finalizer",async()=>{
  const calls=[];
  const renewalPayment={...payment,provider:"pesapal",provider_transaction_id:"track-renewal",
    tx_ref:"EVR-order-1",amount_minor:50000,currency:"UGX",
    metadata:{...payment.metadata,payment_purpose:"subscription_renewal"}};
  const providers={
    paddle:{createCheckout:async()=>({}),verifyWebhook:()=>({})},
    pesapal:{createCheckout:async()=>({}),handleNotification:async()=>({
      provider:"pesapal",eventId:"track-renewal",eventType:"payment.completed",
      merchantReference:"EVR-order-1",trackingId:"track-renewal",amount:50000,currency:"UGX"
    })}
  };
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);calls.push([options.method,target.pathname]);
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="POST")return empty(201);
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="PATCH")return empty();
    if(target.pathname.endsWith("/payment_transactions")&&options.method==="GET")return json([renewalPayment]);
    if(target.pathname.endsWith("/rpc/finalize_subscription_renewal_for_provider"))return json({status:"active",subscriptionId});
    throw new Error("unexpected database request "+target.pathname);
  };
  const billing=createProviderSubscriptionBilling({supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl});
  const result=await billing.handlePesapalIpn({
    OrderNotificationType:"IPNCHANGE",OrderTrackingId:"track-renewal",OrderMerchantReference:"EVR-order-1"
  });
  assert.equal(result.status,200);
  assert.ok(calls.some(x=>x[1].endsWith("/rpc/finalize_subscription_renewal_for_provider")));
});

test("Pesapal IPN verifies the pending UGX order before invoking the atomic subscription finalizer",async()=>{
  const calls=[];
  const pesapalPayment={...payment,provider:"pesapal",provider_transaction_id:"track-1",tx_ref:"EVP-pesapal-1",amount_minor:50000,currency:"UGX"};
  const providers={
    paddle:{createCheckout:async()=>({}),verifyWebhook:()=>({})},
    pesapal:{createCheckout:async()=>({}),handleNotification:async(query,expected)=>{
      calls.push(["verify",query,expected]);
      return {provider:"pesapal",eventId:"track-1",eventType:"payment.completed",merchantReference:"EVP-pesapal-1",
        trackingId:"track-1",amount:50000,currency:"UGX",paymentMethod:"Visa"};
    }}
  };
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);calls.push([options.method,target.pathname,target.search]);
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="POST")return empty(201);
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="PATCH")return empty();
    if(target.pathname.endsWith("/payment_transactions")&&options.method==="GET")return json([pesapalPayment]);
    if(target.pathname.endsWith("/rpc/finalize_subscription_purchase_for_provider"))return json({status:"active",subscriptionId});
    throw new Error("unexpected database request "+target.pathname);
  };
  const billing=createProviderSubscriptionBilling({supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl});
  const result=await billing.handlePesapalIpn({
    OrderNotificationType:"IPNCHANGE",OrderTrackingId:"track-1",OrderMerchantReference:"EVP-pesapal-1"
  });
  assert.equal(result.status,200);
  assert.equal(result.body.status,200);
  assert.equal(calls.find(x=>x[0]==="verify")[2].expectedAmount,50000);
  assert.ok(calls.some(x=>x[1].endsWith("/rpc/finalize_subscription_purchase_for_provider")));
});
