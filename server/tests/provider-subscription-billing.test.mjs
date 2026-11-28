import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {createProviderSubscriptionBilling,getProviderSubscriptionBillingReadiness,verifyProviderSubscriptionBillingDatabase} from "../provider-subscription-billing.mjs";
import {createPaddleSubscriptionProvider,createPesapalSubscriptionProvider} from "../subscription-payment-providers.mjs";

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
  assert.equal(getProviderSubscriptionBillingReadiness({
    ...env,SUPABASE_SERVICE_ROLE_KEY:"",SUPABASE_SECRET_KEY:"sb_secret_test_placeholder"
  }).ready,true);
  assert.equal(getProviderSubscriptionBillingReadiness({...env,PADDLE_PESAPAL_BILLING_ENABLED:"false"}).ready,false);
  assert.equal(getProviderSubscriptionBillingReadiness({...env,PADDLE_API_BASE_URL:"https://api.paddle.com",PADDLE_ALLOW_LIVE:"false"}).ready,false);
  assert.equal(getProviderSubscriptionBillingReadiness({...env,PESAPAL_API_BASE_URL:"https://pay.pesapal.com/v3",PESAPAL_ALLOW_LIVE:"false"}).ready,false);
});

test("provider billing runtime schema gate requires the Batch 150 database capability report",async()=>{
  const calls=[];
  const result=await verifyProviderSubscriptionBillingDatabase({
    supabaseUrl:env.SUPABASE_URL,
    serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    fetchImpl:async(url,options)=>{
      calls.push({url,options});
      return json({ready:true,schema:"executive_visuals",schemaVersion:"batch-150",missing:[]});
    }
  });
  assert.equal(result.state,"READY");
  assert.equal(result.ready,true);
  assert.deepEqual(result.missing,[]);
  assert.equal(calls.length,1);
  assert.ok(calls[0].url.endsWith("/rest/v1/rpc/check_subscription_billing_runtime_schema"));
  assert.equal(calls[0].options.method,"POST");
  assert.equal(calls[0].options.headers["content-profile"],"executive_visuals");
  assert.equal(calls[0].options.headers["accept-profile"],"executive_visuals");
  assert.equal(calls[0].options.body,"{}");
});

test("provider billing runtime schema gate blocks when the Batch 150 RPC is absent",async()=>{
  const result=await verifyProviderSubscriptionBillingDatabase({
    supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    fetchImpl:async()=>json({message:"function not found"},404)
  });
  assert.equal(result.ready,false);
  assert.equal(result.state,"BLOCKED");
  assert.equal(result.reason,"schema_probe_unavailable");
  assert.equal(result.httpStatus,404);
});

test("provider billing runtime schema gate blocks missing tables, functions or grants",async()=>{
  const result=await verifyProviderSubscriptionBillingDatabase({
    supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    fetchImpl:async()=>json({
      ready:false,schema:"executive_visuals",schemaVersion:"batch-150",
      missing:["table_missing:payment_transactions","client_table_grant:customer_subscriptions"]
    })
  });
  assert.equal(result.ready,false);
  assert.equal(result.state,"BLOCKED");
  assert.deepEqual(result.missing,["table_missing:payment_transactions","client_table_grant:customer_subscriptions"]);
});

test("provider billing runtime schema gate never probes without server credentials or exposes them",async()=>{
  let calls=0;
  const result=await verifyProviderSubscriptionBillingDatabase({
    supabaseUrl:env.SUPABASE_URL,serviceRoleKey:"",
    fetchImpl:async()=>{calls++;throw new Error("must not call");}
  });
  assert.equal(calls,0);
  assert.equal(result.ready,false);
  assert.equal(result.state,"BLOCKED");
  assert.equal(JSON.stringify(result).includes("service-role"),false);
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

test("Paddle refund and chargeback adjustments are durably quarantined without changing subscription entitlements",async()=>{
  for(const adjustmentAction of ["refund","chargeback","chargeback_warning"]){
    const calls=[];
    const providers={
      paddle:{createCheckout:async()=>({}),verifyWebhook:()=>({
        provider:"paddle",eventId:"evt-adjustment-"+adjustmentAction,eventType:"adjustment.created",
        providerTransactionId:"txn-original",providerSubscriptionId:"sub_01abcdefghijklmnopqrstuvwxyz",
        adjustmentId:"adj-"+adjustmentAction,adjustmentAction,adjustmentStatus:"pending_approval",
        adjustmentType:"partial",adjustmentReason:"customer request",adjustmentCreatedAt:"2026-11-14T09:59:00Z",
        adjustmentUpdatedAt:"2026-11-14T10:01:00Z",adjustmentCustomerId:"ctm-1",
        adjustmentCreditAppliedToBalance:false,adjustmentAmount:"5000",adjustmentSubtotal:"4500",
        adjustmentTax:"500",adjustmentFee:"100",adjustmentRetainedFee:"20",adjustmentEarnings:"4400",
        adjustmentTotalsCurrency:"USD",adjustmentCurrency:"USD",
        adjustmentPayoutTotals:{total:"5000",earnings:"4400",currency:"USD"},
        adjustmentChargebackFee:{amount:"150",originalAmount:"150",originalCurrency:"USD"},
        adjustmentTaxRates:adjustmentAction==="chargeback"?null:[{rate:"0.1111",subtotal:"4500",tax:"500",total:"5000"}],
        adjustmentItems:[{id:"adjitm-1",transactionItemId:"txnitm-1",type:"partial",amount:"5000",total:"5000",
          proration:{rate:"0.5",startsAt:"2026-11-01T00:00:00Z",endsAt:"2026-12-01T00:00:00Z"}}],
        occurredAt:"2026-11-14T10:00:00Z"
      })},
      pesapal:{createCheckout:async()=>({}),handleNotification:async()=>({})}
    };
    const fetchImpl=async(url,options)=>{
      const target=new URL(url);calls.push({method:options.method,path:target.pathname,body:options.body?JSON.parse(options.body):null});
      if(target.pathname.endsWith("/rpc/claim_payment_webhook_event"))return json({claimed:true,processingStatus:"processing",attempt:1});
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="POST")return empty(201);
      if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="PATCH")return empty();
      throw new Error("Adjustment reconciliation must not invoke payment/subscription settlement: "+target.pathname);
    };
    const billing=createProviderSubscriptionBilling({supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
      paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl});
    const result=await billing.handlePaddleWebhook({rawBody:Buffer.from("{}"),signature:"signed"});
    assert.equal(result.status,200);
    assert.equal(result.body.applied,false);
    assert.equal(result.body.needsReview,true);
    assert.equal(result.body.adjustment.action,adjustmentAction);
    assert.equal(result.body.adjustment.type,"partial");
    assert.equal(result.body.adjustment.reason,"customer request");
    assert.equal(result.body.adjustment.subtotal,"4500");
    assert.equal(result.body.adjustment.items[0].transactionItemId,"txnitm-1");
    assert.equal(calls.filter(call=>call.method==="POST"&&call.path.endsWith("/payment_webhook_events")).length,1);
    const stored=calls.find(call=>call.method==="POST").body.payload;
    assert.equal(stored.adjustmentId,"adj-"+adjustmentAction);
    assert.equal(stored.adjustmentItems[0].total,"5000");
    assert.equal(stored.adjustmentPayoutTotals.earnings,"4400");
    assert.equal(stored.adjustmentChargebackFee.originalCurrency,"USD");
    if(adjustmentAction==="chargeback")assert.equal(stored.adjustmentTaxRates,null);
    else assert.equal(stored.adjustmentTaxRates[0].rate,"0.1111");
    assert.equal(stored.adjustmentItems[0].proration.rate,"0.5");
    assert.equal(result.body.adjustment.retainedFee,"20");
    if(adjustmentAction==="chargeback")assert.equal(result.body.adjustment.taxRates,null);
    else assert.equal(result.body.adjustment.taxRates[0].rate,"0.1111");
    assert.equal(calls.filter(call=>call.method==="PATCH").length,2);
    assert.equal(calls.at(-1).body.processing_status,"needs_review");
    assert.ok(calls.every(call=>call.path.endsWith("/payment_webhook_events")||call.path.endsWith("/rpc/claim_payment_webhook_event")));
  }
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
    if(target.pathname.endsWith("/rpc/claim_payment_webhook_event"))return json({claimed:true,processingStatus:"processing",attempt:1});
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
  assert.ok(calls.some(x=>typeof x[1]==="string"&&x[1].endsWith("/rpc/finalize_subscription_purchase_for_provider")));
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
    if(target.pathname.endsWith("/rpc/claim_payment_webhook_event"))return json({claimed:true,processingStatus:"processing",attempt:1});
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
    if(target.pathname.endsWith("/rpc/claim_payment_webhook_event"))return json({claimed:true,processingStatus:"processing",attempt:1});
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
  assert.ok(calls.some(x=>typeof x[1]==="string"&&x[1].endsWith("/rpc/finalize_subscription_purchase_for_provider")));
});


test("provider webhook duplicate in a live claim lease is acknowledged without repeating settlement",async()=>{
  const calls=[];
  const providers={
    paddle:{createCheckout:async()=>({}),verifyWebhook:()=>({
      provider:"paddle",eventId:"evt-concurrent-1",eventType:"transaction.completed",ownerId:owner,
      planCode:"creator",paymentId,reference:"EVP-order-1",providerTransactionId:"txn-1",
      providerSubscriptionId:"sub_01abcdefghijklmnopqrstuvwxyz",providerPriceId:"pri_01creator123",
      origin:"web",amountMinor:5000,totalPaidMinor:5500,discountMinor:0,currency:"USD",
      occurredAt:"2026-11-14T10:00:00Z"
    })},
    pesapal:{createCheckout:async()=>({}),handleNotification:async()=>({})}
  };
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);calls.push({method:options.method,path:target.pathname,body:options.body?JSON.parse(options.body):null});
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="POST")return empty(409);
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="GET")return json([{
      processing_status:"processing",payload_hash:calls.find(x=>x.method==="POST").body.payload_hash
    }]);
    if(target.pathname.endsWith("/rpc/claim_payment_webhook_event"))return json({
      claimed:false,duplicate:true,inProgress:true,processingStatus:"processing",attempt:1
    });
    throw new Error("A live duplicate must not reach settlement: "+target.pathname);
  };
  const billing=createProviderSubscriptionBilling({supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,
    pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl});
  const result=await billing.handlePaddleWebhook({rawBody:Buffer.from("{}"),signature:"signed"});
  assert.equal(result.status,200);
  assert.equal(result.body.duplicate,true);
  assert.equal(result.body.processingStatus,"processing");
  assert.equal(calls.some(x=>x.path.endsWith("/payment_transactions")),false);
});

test("provider webhook with a changed payload hash is rejected before claiming",async()=>{
  const calls=[];
  const providers={
    paddle:{createCheckout:async()=>({}),verifyWebhook:()=>({provider:"paddle",eventId:"evt-conflict-1",
      eventType:"subscription.updated",providerSubscriptionId:"sub_01abcdefghijklmnopqrstuvwxyz",occurredAt:"2026-11-14T10:00:00Z"})},
    pesapal:{createCheckout:async()=>({}),handleNotification:async()=>({})}
  };
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);calls.push({method:options.method,path:target.pathname});
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="POST")return empty(409);
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="GET")return json([{processing_status:"processed",payload_hash:"0".repeat(64)}]);
    throw new Error("Payload conflict must stop before claim or settlement: "+target.pathname);
  };
  const billing=createProviderSubscriptionBilling({supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,
    pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl});
  const result=await billing.handlePaddleWebhook({rawBody:Buffer.from("{}"),signature:"signed"});
  assert.equal(result.status,409);
  assert.equal(result.body.error.code,"PROVIDER_EVENT_ID_PAYLOAD_CONFLICT");
  assert.equal(calls.some(x=>x.path.endsWith("/rpc/claim_payment_webhook_event")),false);
});

test("provider webhook claims a persisted event before any settlement side effect",async()=>{
  const calls=[];
  const providers={
    paddle:{createCheckout:async()=>({}),verifyWebhook:()=>({
      provider:"paddle",eventId:"evt-claim-order-1",eventType:"transaction.completed",ownerId:owner,
      planCode:"creator",paymentId,reference:"EVP-order-1",providerTransactionId:"txn-1",
      providerSubscriptionId:"sub_01abcdefghijklmnopqrstuvwxyz",providerPriceId:"pri_01creator123",
      origin:"web",amountMinor:5000,totalPaidMinor:5500,discountMinor:0,currency:"USD",
      occurredAt:"2026-11-14T10:00:00Z"
    })},
    pesapal:{createCheckout:async()=>({}),handleNotification:async()=>({})}
  };
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);calls.push({method:options.method,path:target.pathname,body:options.body?JSON.parse(options.body):null});
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="POST")return empty(201);
    if(target.pathname.endsWith("/rpc/claim_payment_webhook_event"))return json({claimed:true,processingStatus:"processing",attempt:1});
    if(target.pathname.endsWith("/payment_transactions")&&options.method==="GET")return json([payment]);
    if(target.pathname.endsWith("/rpc/finalize_subscription_purchase_for_provider"))return json({status:"active",subscriptionId});
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="GET")return json([]);
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="PATCH")return empty();
    throw new Error("unexpected database request "+target.pathname);
  };
  const billing=createProviderSubscriptionBilling({supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,
    pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl});
  const result=await billing.handlePaddleWebhook({rawBody:Buffer.from("{}"),signature:"signed"});
  assert.equal(result.status,200);
  assert.equal(result.body.applied,true);
  const claimIndex=calls.findIndex(x=>x.path.endsWith("/rpc/claim_payment_webhook_event"));
  const settlementIndex=calls.findIndex(x=>x.path.endsWith("/rpc/finalize_subscription_purchase_for_provider"));
  assert.ok(claimIndex>=0&&settlementIndex>claimIndex);
  const claimBody=calls[claimIndex].body;
  assert.equal(claimBody.p_provider,"paddle");
  assert.match(claimBody.p_event_key,/^[a-f0-9]{64}$/);
  assert.match(claimBody.p_payload_hash,/^[a-f0-9]{64}$/);
});

test("subscription database response bodies are streamed with a strict 1 MiB cap",async()=>{
  let canceled=false,providerCalled=false;
  const body=new ReadableStream({
    pull(controller){controller.enqueue(new Uint8Array(1024*1024+1));},
    cancel(){canceled=true;}
  });
  const providers={
    paddle:{createCheckout:async()=>{providerCalled=true;return {};},verifyWebhook:()=>({})},
    pesapal:{createCheckout:async()=>({}),handleNotification:async()=>({})}
  };
  const billing=createProviderSubscriptionBilling({
    supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,
    pesapalNotificationId:env.PESAPAL_IPN_ID,providers,
    fetchImpl:async()=>new Response(body,{status:200})
  });
  const result=await billing.handle({
    method:"POST",path:"/api/billing/subscription/provider-checkout",ownerId:owner,
    idempotencyKey:"bounded-response-key",body:{provider:"paddle",planCode:"creator",email:"buyer@example.com"}
  });
  assert.equal(result.status,502);
  assert.equal(result.body.error.code,"SUBSCRIPTION_DATABASE_RESPONSE_TOO_LARGE");
  assert.equal(canceled,true);
  assert.equal(providerCalled,false);
});


function signedPaddleDelivery(event,{secret="paddle-secret",timestamp=Math.floor(Date.parse("2026-11-28T10:00:00.000Z")/1000)}={}){
  const rawBody=Buffer.from(JSON.stringify(event));
  const digest=createHmac("sha256",secret).update(String(timestamp)+":").update(rawBody).digest("hex");
  return {rawBody,signature:"ts="+timestamp+";h1="+digest};
}

function paddleCompletedEvent(overrides={}){
  return {
    event_id:"evt_01batch145abcdefghijklmnop",
    event_type:"transaction.completed",
    occurred_at:"2026-11-28T09:59:00.000Z",
    data:{
      id:"txn-1",
      subscription_id:"sub_01abcdefghijklmnopqrstuvwxyz",
      customer_id:"ctm_01abcdefghijklmnopqrstuvwxyz",
      currency_code:"USD",
      origin:"web",
      custom_data:{
        owner_id:owner,plan_code:"creator",payment_id:paymentId,reference:"EVP-order-1"
      },
      details:{
        totals:{subtotal:"5000",grand_total:"5500",discount:"0"},
        line_items:[{price_id:"pri_01creator123"}]
      },
      ...overrides
    }
  };
}

test("Batch 145 end-to-end: signed Paddle completion is normalized, persisted, claimed and settled once",async()=>{
  const fixedNow=Date.parse("2026-11-28T10:00:00.000Z");
  const calls=[];
  let persistedEvent=null,claimed=false,settlements=0;
  const paddle=createPaddleSubscriptionProvider({
    apiKey:"sandbox-api-key",webhookSecret:"paddle-secret",
    baseUrl:"https://sandbox-api.paddle.com",priceIds:{creator:"pri_01creator123"},
    now:()=>fixedNow,fetchImpl:async()=>{throw new Error("Paddle API must not be called by webhook acceptance");}
  });
  const providers={paddle,pesapal:{createCheckout:async()=>({}),handleNotification:async()=>({})}};
  const fetchImpl=async(url,options)=>{
    const target=new URL(url),body=options.body?JSON.parse(options.body):null;
    calls.push({method:options.method,path:target.pathname,search:target.search,body});
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="POST"){
      if(persistedEvent)return empty(409);
      persistedEvent={payload_hash:body.payload_hash,processing_status:"received",event_type:body.event_type,payload:body.payload,event_key:body.event_key};
      return empty(201);
    }
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="GET"){
      if(target.search.includes("processing_status=eq.needs_review"))return json([]);
      return json(persistedEvent?[{payload_hash:persistedEvent.payload_hash,processing_status:persistedEvent.processing_status}]:[]);
    }
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="PATCH"){
      if(persistedEvent)persistedEvent.processing_status=body.processing_status||persistedEvent.processing_status;
      return empty();
    }
    if(target.pathname.endsWith("/rpc/claim_payment_webhook_event")){
      if(claimed)return json({claimed:false,duplicate:true,inProgress:false,processingStatus:"processed",attempt:1});
      claimed=true;
      return json({claimed:true,processingStatus:"processing",attempt:1});
    }
    if(target.pathname.endsWith("/payment_transactions")&&options.method==="GET")return json([payment]);
    if(target.pathname.endsWith("/rpc/finalize_subscription_purchase_for_provider")){
      settlements++;
      assert.equal(body.p_payment_id,paymentId);
      assert.equal(body.p_provider_transaction_id,"txn-1");
      assert.equal(body.p_provider_payload.amount_minor,5000);
      assert.equal(body.p_provider_payload.total_paid_minor,5500);
      assert.equal(body.p_provider_payload.currency,"USD");
      assert.equal(body.p_provider_payload.reference,"EVP-order-1");
      return json({status:"active",subscriptionId});
    }
    throw new Error("Unexpected acceptance request "+options.method+" "+target.pathname+target.search);
  };
  const billing=createProviderSubscriptionBilling({
    supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,
    pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl,now:()=>fixedNow
  });
  const delivery=signedPaddleDelivery(paddleCompletedEvent());
  const first=await billing.handlePaddleWebhook(delivery);
  assert.equal(first.status,200);
  assert.equal(first.body.applied,true);
  assert.equal(settlements,1);
  assert.equal(persistedEvent.processing_status,"processed");
  const claimIndex=calls.findIndex(call=>call.path.endsWith("/rpc/claim_payment_webhook_event"));
  const settleIndex=calls.findIndex(call=>call.path.endsWith("/rpc/finalize_subscription_purchase_for_provider"));
  assert.ok(claimIndex>=0&&settleIndex>claimIndex,"event must be durably claimed before settlement");

  const replay=await billing.handlePaddleWebhook(delivery);
  assert.equal(replay.status,200);
  assert.equal(replay.body.duplicate,true);
  assert.equal(replay.body.processingStatus,"processed");
  assert.equal(settlements,1,"identical provider delivery must never settle twice");
});

test("Batch 145 rejects a tampered Paddle delivery before writing or claiming an event",async()=>{
  const fixedNow=Date.parse("2026-11-28T10:00:00.000Z");
  const paddle=createPaddleSubscriptionProvider({
    apiKey:"sandbox-api-key",webhookSecret:"paddle-secret",
    baseUrl:"https://sandbox-api.paddle.com",priceIds:{creator:"pri_01creator123"},
    now:()=>fixedNow,fetchImpl:async()=>{throw new Error("Paddle API must not be called");}
  });
  const providers={paddle,pesapal:{createCheckout:async()=>({}),handleNotification:async()=>({})}};
  let databaseCalls=0;
  const billing=createProviderSubscriptionBilling({
    supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,
    pesapalNotificationId:env.PESAPAL_IPN_ID,providers,
    fetchImpl:async()=>{databaseCalls++;throw new Error("Untrusted delivery must not touch the database");},
    now:()=>fixedNow
  });
  const delivery=signedPaddleDelivery(paddleCompletedEvent());
  const tampered=Buffer.from(delivery.rawBody.toString().replace('"grand_total":"5500"','"grand_total":"1"'));
  const result=await billing.handlePaddleWebhook({rawBody:tampered,signature:delivery.signature});
  assert.equal(result.status,401);
  assert.equal(result.body.error.code,"PADDLE_WEBHOOK_SIGNATURE_INVALID");
  assert.equal(databaseCalls,0);
});

test("Batch 145 rejects a validly signed replay with the same event ID but different normalized content",async()=>{
  const fixedNow=Date.parse("2026-11-28T10:00:00.000Z");
  const calls=[];
  let persistedEvent=null;
  const paddle=createPaddleSubscriptionProvider({
    apiKey:"sandbox-api-key",webhookSecret:"paddle-secret",
    baseUrl:"https://sandbox-api.paddle.com",priceIds:{creator:"pri_01creator123"},
    now:()=>fixedNow,fetchImpl:async()=>{throw new Error("Paddle API must not be called");}
  });
  const providers={paddle,pesapal:{createCheckout:async()=>({}),handleNotification:async()=>({})}};
  const fetchImpl=async(url,options)=>{
    const target=new URL(url),body=options.body?JSON.parse(options.body):null;
    calls.push({method:options.method,path:target.pathname,search:target.search,body});
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="POST"){
      if(persistedEvent)return empty(409);
      persistedEvent={payload_hash:body.payload_hash,processing_status:"received"};
      return empty(201);
    }
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="GET"){
      if(target.search.includes("processing_status=eq.needs_review"))return json([]);
      return json(persistedEvent?[{payload_hash:persistedEvent.payload_hash,processing_status:persistedEvent.processing_status}]:[]);
    }
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="PATCH"){
      persistedEvent.processing_status=body.processing_status||persistedEvent.processing_status;
      return empty();
    }
    if(target.pathname.endsWith("/rpc/claim_payment_webhook_event"))
      return json({claimed:true,processingStatus:"processing",attempt:1});
    if(target.pathname.endsWith("/payment_transactions")&&options.method==="GET")return json([payment]);
    if(target.pathname.endsWith("/rpc/finalize_subscription_purchase_for_provider"))
      return json({status:"active",subscriptionId});
    throw new Error("Unexpected changed-replay acceptance request: "+target.pathname);
  };
  const billing=createProviderSubscriptionBilling({
    supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,
    pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl,now:()=>fixedNow
  });
  const first=await billing.handlePaddleWebhook(signedPaddleDelivery(paddleCompletedEvent()));
  assert.equal(first.status,200);
  const changed=paddleCompletedEvent({details:{totals:{subtotal:"5000",grand_total:"5600",discount:"0"},line_items:[{price_id:"pri_01creator123"}]}});
  const replay=await billing.handlePaddleWebhook(signedPaddleDelivery(changed));
  assert.equal(replay.status,409);
  assert.equal(replay.body.error.code,"PROVIDER_EVENT_ID_PAYLOAD_CONFLICT");
  assert.equal(calls.filter(call=>call.path.endsWith("/rpc/claim_payment_webhook_event")).length,1,"only the first, unchanged event may be claimed");
});


test("Batch 145 defers an early Paddle subscription event and reconciles it after verified checkout settlement",async()=>{
  const fixedNow=Date.parse("2026-11-28T10:00:00.000Z");
  const calls=[],events=new Map(),claims=new Set();
  let lifecycleCalls=0,settlements=0;
  const providerSubscriptionId="sub_01abcdefghijklmnopqrstuvwxyz";
  const paddle=createPaddleSubscriptionProvider({
    apiKey:"sandbox-api-key",webhookSecret:"paddle-secret",
    baseUrl:"https://sandbox-api.paddle.com",priceIds:{creator:"pri_01creator123"},
    now:()=>fixedNow,fetchImpl:async()=>{throw new Error("Paddle API must not be called by webhook acceptance");}
  });
  const providers={paddle,pesapal:{createCheckout:async()=>({}),handleNotification:async()=>({})}};
  const fetchImpl=async(url,options)=>{
    const target=new URL(url),body=options.body?JSON.parse(options.body):null;
    calls.push({method:options.method,path:target.pathname,search:target.search,body});
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="POST"){
      if(events.has(body.event_key))return empty(409);
      events.set(body.event_key,{event_key:body.event_key,event_type:body.event_type,
        payload_hash:body.payload_hash,processing_status:"received",payload:body.payload});
      return empty(201);
    }
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="GET"){
      if(target.search.includes("processing_status=eq.needs_review"))
        return json([...events.values()].filter(row=>row.processing_status==="needs_review"));
      const key=target.search.match(/event_key=eq\.([a-f0-9]+)/)?.[1];
      const row=key?events.get(key):null;
      return json(row?[{payload_hash:row.payload_hash,processing_status:row.processing_status}]:[]);
    }
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="PATCH"){
      const key=target.search.match(/event_key=eq\.([a-f0-9]+)/)?.[1];
      const row=key?events.get(key):null;
      if(row)row.processing_status=body.processing_status||row.processing_status;
      return empty();
    }
    if(target.pathname.endsWith("/rpc/claim_payment_webhook_event")){
      if(claims.has(body.p_event_key))return json({claimed:false,duplicate:true,processingStatus:"processed"});
      claims.add(body.p_event_key);
      return json({claimed:true,processingStatus:"processing",attempt:1});
    }
    if(target.pathname.endsWith("/rpc/apply_paddle_subscription_lifecycle")){
      lifecycleCalls++;
      return lifecycleCalls===1?json({applied:false,needsReview:true,reason:"subscription_not_mapped"}):
        json({applied:true,subscriptionId,status:"active"});
    }
    if(target.pathname.endsWith("/payment_transactions")&&options.method==="GET")return json([payment]);
    if(target.pathname.endsWith("/rpc/finalize_subscription_purchase_for_provider")){
      settlements++;
      return json({status:"active",subscriptionId});
    }
    throw new Error("Unexpected lifecycle acceptance request "+options.method+" "+target.pathname+target.search);
  };
  const billing=createProviderSubscriptionBilling({
    supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,
    pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl,now:()=>fixedNow
  });

  const earlyLifecycle={
    event_id:"evt_01batch145lifecycleabcdefgh",
    event_type:"subscription.created",
    occurred_at:"2026-11-28T09:58:00.000Z",
    data:{id:providerSubscriptionId,status:"active",customer_id:"ctm_01abcdefghijklmnopqrstuvwxyz",
      current_billing_period:{starts_at:"2026-11-28T09:58:00.000Z",ends_at:"2026-12-28T09:58:00.000Z"},
      custom_data:{owner_id:owner,plan_code:"creator",payment_id:paymentId,reference:"EVP-order-1"}}
  };
  const early=await billing.handlePaddleWebhook(signedPaddleDelivery(earlyLifecycle));
  assert.equal(early.status,200);
  assert.equal(early.body.needsReview,true);
  assert.equal(settlements,0);
  const deferred=[...events.values()].find(row=>row.event_type==="subscription.created");
  assert.equal(deferred.processing_status,"needs_review");

  const completed=await billing.handlePaddleWebhook(signedPaddleDelivery(paddleCompletedEvent()));
  assert.equal(completed.status,200);
  assert.equal(completed.body.applied,true);
  assert.equal(settlements,1);
  assert.equal(lifecycleCalls,2,"deferred lifecycle event must be replayed after the internal subscription exists");
  assert.equal(deferred.processing_status,"processed");
  assert.ok(calls.some(call=>call.path.endsWith("/rpc/finalize_subscription_purchase_for_provider")));
});


test("Batch 145 end-to-end: Pesapal IPN is verified against provider status and the reserved UGX payment before settlement",async()=>{
  const fixedNow=Date.parse("2026-11-28T10:00:00.000Z");
  const calls=[],providerCalls=[];
  let persistedEvent=null,settlements=0;
  const pesapalPayment={...payment,provider:"pesapal",provider_transaction_id:"pesapal-track-145",
    tx_ref:"EVP-order-1",amount_minor:50000,currency:"UGX"};
  const paddle=createPaddleSubscriptionProvider({
    apiKey:"sandbox-api-key",webhookSecret:"paddle-secret",
    baseUrl:"https://sandbox-api.paddle.com",priceIds:{creator:"pri_01creator123"},
    now:()=>fixedNow,fetchImpl:async()=>{throw new Error("Paddle API must not be called");}
  });
  const pesapal=createPesapalSubscriptionProvider({
    consumerKey:"pesapal-sandbox-key",consumerSecret:"pesapal-sandbox-secret",
    baseUrl:"https://cybqa.pesapal.com/pesapalv3",now:()=>fixedNow,
    fetchImpl:async(url,options)=>{
      const target=new URL(url);
      providerCalls.push({method:options.method,url:target.toString(),body:options.body?JSON.parse(options.body):null});
      if(target.pathname.endsWith("/api/Auth/RequestToken"))
        return json({token:"pesapal-access-token",expiryDate:"2026-11-28T10:10:00.000Z"});
      if(target.pathname.endsWith("/api/Transactions/GetTransactionStatus")){
        assert.equal(target.searchParams.get("orderTrackingId"),"pesapal-track-145");
        assert.equal(options.headers.authorization,"Bearer pesapal-access-token");
        return json({merchant_reference:"EVP-order-1",status_code:1,
          payment_status_description:"Completed",amount:50000,currency:"UGX",
          payment_method:"Mobile Money",confirmation_code:"PESAPAL-TEST-145"});
      }
      throw new Error("Unexpected Pesapal provider request "+target.pathname);
    }
  });
  const providers={paddle,pesapal};
  const fetchImpl=async(url,options)=>{
    const target=new URL(url),body=options.body?JSON.parse(options.body):null;
    calls.push({method:options.method,path:target.pathname,search:target.search,body});
    if(target.pathname.endsWith("/payment_transactions")&&options.method==="GET")return json([pesapalPayment]);
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="POST"){
      persistedEvent=body;
      return empty(201);
    }
    if(target.pathname.endsWith("/rpc/claim_payment_webhook_event"))
      return json({claimed:true,processingStatus:"processing",attempt:1});
    if(target.pathname.endsWith("/payment_webhook_events")&&options.method==="PATCH")return empty();
    if(target.pathname.endsWith("/rpc/finalize_subscription_purchase_for_provider")){
      settlements++;
      assert.equal(body.p_payment_id,paymentId);
      assert.equal(body.p_provider_transaction_id,"pesapal-track-145");
      assert.equal(body.p_provider_payload.amount_minor,50000);
      assert.equal(body.p_provider_payload.currency,"UGX");
      assert.equal(body.p_provider_payload.reference,"EVP-order-1");
      return json({status:"active",subscriptionId});
    }
    throw new Error("Unexpected Pesapal acceptance database request "+options.method+" "+target.pathname+target.search);
  };
  const billing=createProviderSubscriptionBilling({
    supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,
    paddleReturnUrl:env.PADDLE_RETURN_URL,pesapalCallbackUrl:env.PESAPAL_CALLBACK_URL,
    pesapalNotificationId:env.PESAPAL_IPN_ID,providers,fetchImpl,now:()=>fixedNow
  });
  const result=await billing.handlePesapalIpn({
    OrderNotificationType:"IPNCHANGE",OrderTrackingId:"pesapal-track-145",
    OrderMerchantReference:"EVP-order-1"
  });
  assert.equal(result.status,200);
  assert.equal(result.body.status,200);
  assert.equal(result.body.result.applied,true);
  assert.equal(settlements,1);
  assert.equal(providerCalls.length,2,"Pesapal must authenticate and fetch authoritative transaction status");
  assert.ok(providerCalls[1].url.includes("/api/Transactions/GetTransactionStatus"));
  assert.equal(persistedEvent.signature_verified,true);
  assert.equal(persistedEvent.payload.currency,"UGX");
  assert.equal(persistedEvent.payload.amountMinor,50000);
  assert.equal(persistedEvent.payload.amount,50000);
});
