import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {createPaddleSubscriptionProvider,createPesapalSubscriptionProvider,createSubscriptionPaymentProviders} from "../subscription-payment-providers.mjs";

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
const owner="11111111-1111-4111-8111-111111111111";
const now=()=>Date.parse("2026-11-14T10:00:00Z");

test("Paddle checkout uses a server-mapped price and returns hosted checkout only",async()=>{
  let request;
  const provider=createPaddleSubscriptionProvider({
    apiKey:"sandbox-key",webhookSecret:"webhook-secret",priceIds:{creator:"pri_01creator123"},
    now,fetchImpl:async(url,options)=>{request={url:String(url),options,body:JSON.parse(options.body)};return json({data:{id:"txn_123",status:"draft",checkout:{url:"https://checkout.paddle.com/txn_123"}}});}
  });
  const result=await provider.createCheckout({planCode:"creator",ownerId:owner,email:"buyer@example.com",returnUrl:"https://executive-visuals.onrender.com/billing/return",paymentId:"payment-123",reference:"EVS-order-123"});
  assert.equal(result.checkoutUrl,"https://checkout.paddle.com/txn_123");
  assert.equal(result.transactionId,"txn_123");
  assert.equal(request.url,"https://sandbox-api.paddle.com/transactions");
  assert.equal(request.options.headers.authorization,"Bearer sandbox-key");
  assert.deepEqual(request.body.items,[{price_id:"pri_01creator123",quantity:1}]);
  assert.deepEqual(request.body.custom_data,{owner_id:owner,plan_code:"creator",product:"executive_visuals"});
});

test("Paddle checkout rejects client-controlled price IDs and invalid return URLs",async()=>{
  const provider=createPaddleSubscriptionProvider({apiKey:"x",priceIds:{creator:"pri_valid"},fetchImpl:async()=>{throw new Error("must not call");}});
  await assert.rejects(()=>provider.createCheckout({planCode:"missing",ownerId:owner,email:"buyer@example.com"}),{code:"PADDLE_CHECKOUT_INPUT_INVALID"});
  await assert.rejects(()=>provider.createCheckout({planCode:"creator",ownerId:owner,email:"buyer@example.com",returnUrl:"http://attacker.example/"}),{code:"PADDLE_RETURN_URL_INVALID"});
});

test("Paddle webhook verifies raw-body HMAC and normalizes subscription activation",()=>{
  const secret="paddle-secret",timestamp=Math.floor(now()/1000);
  const raw=Buffer.from(JSON.stringify({event_id:"evt_1",event_type:"subscription.activated",occurred_at:"2026-11-14T10:00:00Z",data:{
    id:"sub_1",customer_id:"ctm_1",status:"active",custom_data:{owner_id:owner,plan_code:"creator"},
    current_billing_period:{starts_at:"2026-11-14T00:00:00Z",ends_at:"2026-12-14T00:00:00Z"}
  }}));
  const signature=createHmac("sha256",secret).update(String(timestamp)+":").update(raw).digest("hex");
  const provider=createPaddleSubscriptionProvider({apiKey:"x",webhookSecret:secret,priceIds:{},now,fetchImpl:async()=>json({})});
  const event=provider.verifyWebhook(raw,"ts="+timestamp+";h1="+signature);
  assert.equal(event.provider,"paddle");
  assert.equal(event.eventId,"evt_1");
  assert.equal(event.ownerId,owner);
  assert.equal(event.providerSubscriptionId,"sub_1");
  assert.equal(event.status,"active");
  assert.equal(event.periodEnd,"2026-12-14T00:00:00Z");
});

test("Paddle webhook rejects tampered and stale signatures",()=>{
  const secret="paddle-secret",timestamp=Math.floor(now()/1000),raw=Buffer.from('{"event_id":"evt","event_type":"subscription.activated","data":{}}');
  const valid=createHmac("sha256",secret).update(String(timestamp)+":").update(raw).digest("hex");
  const provider=createPaddleSubscriptionProvider({apiKey:"x",webhookSecret:secret,now,fetchImpl:async()=>json({})});
  assert.throws(()=>provider.verifyWebhook(Buffer.from(raw.toString()+" "), "ts="+timestamp+";h1="+valid),{code:"PADDLE_WEBHOOK_SIGNATURE_INVALID"});
  assert.throws(()=>provider.verifyWebhook(raw,"ts="+(timestamp-6)+";h1="+valid),{code:"PADDLE_WEBHOOK_SIGNATURE_INVALID"});
});

test("Paddle webhook accepts any valid h1 during endpoint secret rotation",()=>{
  const secret="paddle-secret",timestamp=Math.floor(now()/1000),raw=Buffer.from('{"event_id":"evt-rotation","event_type":"subscription.activated","data":{}}');
  const valid=createHmac("sha256",secret).update(String(timestamp)+":").update(raw).digest("hex");
  const provider=createPaddleSubscriptionProvider({apiKey:"x",webhookSecret:secret,now,fetchImpl:async()=>json({})});
  const event=provider.verifyWebhook(raw,"ts="+timestamp+";h1="+"0".repeat(64)+";h1="+valid);
  assert.equal(event.eventId,"evt-rotation");
});

test("Paddle live API is fail-closed without explicit opt-in",()=>{
  assert.throws(()=>createPaddleSubscriptionProvider({apiKey:"x",baseUrl:"https://api.paddle.com",allowLive:false}),{code:"PADDLE_LIVE_DISABLED"});
});

test("Pesapal authenticates, registers IPN and creates a hosted recurring card order",async()=>{
  const calls=[];
  const provider=createPesapalSubscriptionProvider({
    consumerKey:"key",consumerSecret:"secret",now,
    fetchImpl:async(url,options)=>{
      calls.push({url:String(url),options,body:options.body?JSON.parse(options.body):null});
      if(String(url).endsWith("/api/Auth/RequestToken"))return json({token:"pesapal-token"});
      if(String(url).endsWith("/api/URLSetup/RegisterIPN"))return json({ipn_id:"ipn-1",url:"https://app.example/api/webhooks/pesapal"});
      if(String(url).endsWith("/api/Transactions/SubmitOrderRequest"))return json({order_tracking_id:"track-1",redirect_url:"https://pay.pesapal.com/order/1"});
      throw new Error("unexpected request "+url);
    }
  });
  const ipn=await provider.registerIpn("https://app.example/api/webhooks/pesapal");
  assert.equal(ipn.notificationId,"ipn-1");
  const checkout=await provider.createCheckout({
    reference:"EVS-order-1",description:"Executive Visuals Creator",amount:25000,currency:"UGX",
    email:"buyer@example.com",firstName:"Test",lastName:"Buyer",phone:"256771234567",
    callbackUrl:"https://app.example/billing/return",notificationId:ipn.notificationId,
    subscriptionDetails:{startDate:"14-11-2026",endDate:"14-11-2027",frequency:"MONTHLY"}
  });
  assert.equal(checkout.trackingId,"track-1");
  const order=calls.find(x=>x.url.endsWith("/api/Transactions/SubmitOrderRequest"));
  assert.equal(order.options.headers.authorization,"Bearer pesapal-token");
  assert.deepEqual(order.body.subscription_details,{start_date:"14-11-2026",end_date:"14-11-2027",frequency:"MONTHLY"});
  assert.equal(order.body.currency,"UGX");
  assert.equal("account_number" in order.body,false);
  assert.equal(calls.filter(x=>x.url.endsWith("/api/Auth/RequestToken")).length,1);
});

test("Pesapal recurring IPN is not trusted until transaction status is fetched and matched",async()=>{
  const calls=[];
  const provider=createPesapalSubscriptionProvider({
    consumerKey:"key",consumerSecret:"secret",now,
    fetchImpl:async(url,options)=>{
      calls.push(String(url));
      if(String(url).endsWith("/api/Auth/RequestToken"))return json({token:"token"});
      if(String(url).includes("/api/Transactions/GetTransactionStatus"))return json({
        merchant_reference:"EVS-order-2",status_code:1,payment_status_description:"Completed",
        amount:25000,currency:"UGX",payment_method:"Visa",confirmation_code:"confirmed",
        subscription_transaction_info:{account_reference:"EVS-order-2",correlation_id:"recurring-123"}
      });
      throw new Error("unexpected request "+url);
    }
  });
  const event=await provider.handleNotification({
    OrderNotificationType:"RECURRING",OrderTrackingId:"track-2",OrderMerchantReference:"EVS-order-2"
  },{expectedAmount:25000,expectedCurrency:"UGX"});
  assert.equal(event.eventType,"recurring.payment.completed");
  assert.equal(event.recurring.correlationId,"recurring-123");
  assert.ok(calls.some(url=>url.includes("GetTransactionStatus")));
});

test("Pesapal rejects mismatched amount, currency and merchant reference",async()=>{
  const provider=createPesapalSubscriptionProvider({
    consumerKey:"key",consumerSecret:"secret",now,
    fetchImpl:async(url)=>String(url).endsWith("/api/Auth/RequestToken")?json({token:"token"}):json({
      merchant_reference:"other-order",status_code:1,payment_status_description:"Completed",amount:10,currency:"USD"
    })
  });
  await assert.rejects(()=>provider.verifyNotification({trackingId:"track",merchantReference:"expected-order",expectedAmount:25000,expectedCurrency:"UGX"}),{code:"PESAPAL_PAYMENT_NOT_VERIFIED"});
});

test("Pesapal live API is fail-closed without explicit opt-in",()=>{
  assert.throws(()=>createPesapalSubscriptionProvider({consumerKey:"x",consumerSecret:"y",baseUrl:"https://pay.pesapal.com/v3",allowLive:false}),{code:"PESAPAL_LIVE_DISABLED"});
});

test("provider registry exposes one normalized Paddle and Pesapal contract",()=>{
  const providers=createSubscriptionPaymentProviders({
    paddle:{apiKey:"p",webhookSecret:"s",priceIds:{},fetchImpl:async()=>json({})},
    pesapal:{consumerKey:"k",consumerSecret:"s",fetchImpl:async()=>json({})}
  });
  assert.equal(providers.paddle.name,"paddle");
  assert.equal(providers.pesapal.name,"pesapal");
  assert.equal(providers.paddle.environment,"sandbox");
  assert.equal(providers.pesapal.environment,"sandbox");
});
