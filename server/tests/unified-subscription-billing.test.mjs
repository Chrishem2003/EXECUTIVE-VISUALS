import test from "node:test";
import assert from "node:assert/strict";
import {createUnifiedSubscriptionBilling} from "../unified-subscription-billing.mjs";

const owner="11111111-1111-4111-8111-111111111111";
function fixture(overrides={}){
  const calls=[];
  const repository={
    reserveCheckout:async input=>{calls.push(["reserve",input]);return {paymentId:"payment-1",subscriptionId:"subscription-1",reference:"EVS-order-1",providerPriceId:"pri_01creator123",billingInterval:"monthly",amountMajor:25000,currency:"UGX",...overrides.reservation};},
    getCheckout:async input=>{calls.push(["get",input]);return {checkoutUrl:"https://checkout.example/replay",paymentId:input.paymentId};},
    attachProviderCheckout:async input=>{calls.push(["attach",input]);return true;},
    markCheckoutUncertain:async input=>{calls.push(["uncertain",input]);return true;},
    applyProviderEvent:async input=>{calls.push(["apply",input]);return {applied:true};},
    findPendingPesapalPayment:async input=>{calls.push(["find-pesapal",input]);return {paymentId:"payment-1",subscriptionId:"subscription-1",ownerId:owner,amountMajor:25000,currency:"UGX"};},
    ...overrides.repository
  };
  const providers={
    paddle:{
      createCheckout:async input=>{calls.push(["paddle-checkout",input]);return {provider:"paddle",transactionId:"txn-1",checkoutUrl:"https://checkout.example/paddle"};},
      verifyWebhook:()=>({eventId:"evt-1",ownerId:owner,planCode:"creator",status:"active"})
    },
    pesapal:{
      createCheckout:async input=>{calls.push(["pesapal-checkout",input]);return {provider:"pesapal",trackingId:"track-1",checkoutUrl:"https://checkout.example/pesapal"};},
      handleNotification:async (query,expected)=>{calls.push(["pesapal-verify",query,expected]);return {eventId:"track-1",eventType:"recurring.payment.completed"};}
    },
    ...overrides.providers
  };
  return {service:createUnifiedSubscriptionBilling({providers,repository}),calls};
}

test("unified checkout reserves server-side before Paddle and persists provider checkout",async()=>{
  const {service,calls}=fixture();
  const result=await service.createCheckout({provider:"paddle",ownerId:owner,planCode:"creator",email:"buyer@example.com",idempotencyKey:"checkout-key-0001",returnUrl:"https://app.example/billing"});
  assert.equal(result.provider,"paddle");
  assert.equal(result.paymentId,"payment-1");
  assert.equal(calls[0][0],"reserve");
  assert.equal(calls[1][0],"paddle-checkout");
  assert.equal(calls[2][0],"attach");
  assert.equal(calls[2][1].provider,"paddle");
  const paddleCall=calls.find(x=>x[0]==="paddle-checkout")[1];
  assert.equal(paddleCall.paymentId,"payment-1");
  assert.equal(paddleCall.reference,"EVS-order-1");
  assert.equal(paddleCall.priceId,"pri_01creator123");
  assert.deepEqual(paddleCall.expectedPrice,{amountMinor:25000,currency:"UGX",billingInterval:"monthly"});
});

test("unified checkout derives Pesapal amount and reference from reservation, not client input",async()=>{
  const {service,calls}=fixture();
  const result=await service.createCheckout({provider:"pesapal",ownerId:owner,planCode:"creator",email:"buyer@example.com",idempotencyKey:"checkout-key-0002",pesapalOrder:{amount:1,reference:"attacker-ref",currency:"USD",notificationId:"ipn-1"}});
  const providerCall=calls.find(x=>x[0]==="pesapal-checkout")[1];
  assert.equal(result.trackingId,"track-1");
  assert.equal(providerCall.reference,"EVS-order-1");
  assert.equal(providerCall.amount,25000);
  assert.equal(providerCall.currency,"UGX");
  assert.equal(providerCall.accountNumber,undefined);
});

test("unified checkout returns saved replay and never starts a second provider charge",async()=>{
  const {service,calls}=fixture({reservation:{idempotentReplay:true}});
  const result=await service.createCheckout({provider:"paddle",ownerId:owner,planCode:"creator",email:"buyer@example.com",idempotencyKey:"checkout-key-0003"});
  assert.equal(result.idempotentReplay,true);
  assert.equal(result.checkoutUrl,"https://checkout.example/replay");
  assert.equal(calls.some(x=>x[0]==="paddle-checkout"),false);
});

test("provider timeout leaves reservation marked uncertain and prevents a blind new charge",async()=>{
  const {service,calls}=fixture({providers:{paddle:{createCheckout:async()=>{throw Object.assign(new Error("timeout"),{code:"PAYMENT_PROVIDER_TIMEOUT"});}}}});
  await assert.rejects(()=>service.createCheckout({provider:"paddle",ownerId:owner,planCode:"creator",email:"buyer@example.com",idempotencyKey:"checkout-key-0004"}),{code:"SUBSCRIPTION_CHECKOUT_UNCERTAIN",status:202});
  assert.equal(calls.some(x=>x[0]==="uncertain"),true);
});

test("Paddle webhook applies only a verified event to the unified repository",async()=>{
  const {service,calls}=fixture();
  const result=await service.handlePaddleWebhook({rawBody:Buffer.from("{}"),signature:"verified-by-adapter"});
  assert.equal(result.applied,true);
  assert.equal(calls.find(x=>x[0]==="apply")[1].provider,"paddle");
});

test("Paddle webhook cannot grant access when verified event has no owner mapping",async()=>{
  const {service,calls}=fixture({providers:{paddle:{verifyWebhook:()=>({eventId:"evt-2",ownerId:"",planCode:"creator"})}}});
  await assert.rejects(()=>service.handlePaddleWebhook({rawBody:Buffer.from("{}"),signature:"x"}),{code:"PADDLE_EVENT_REQUIRES_REVIEW"});
  assert.equal(calls.some(x=>x[0]==="apply"),false);
});

test("Pesapal IPN must match a pending ledger payment and provider-verified amount",async()=>{
  const {service,calls}=fixture();
  const result=await service.handlePesapalNotification({OrderMerchantReference:"EVS-order-1",OrderTrackingId:"track-1",OrderNotificationType:"RECURRING"});
  assert.equal(result.provider,"pesapal");
  const verify=calls.find(x=>x[0]==="pesapal-verify");
  assert.equal(verify[2].expectedAmount,25000);
  assert.equal(verify[2].expectedCurrency,"UGX");
  assert.equal(calls.find(x=>x[0]==="apply")[1].paymentId,"payment-1");
});

test("Pesapal notification without a pending internal reference is rejected",async()=>{
  const {service,calls}=fixture({repository:{findPendingPesapalPayment:async()=>null}});
  await assert.rejects(()=>service.handlePesapalNotification({OrderMerchantReference:"unknown",OrderTrackingId:"track"}),{code:"PESAPAL_PAYMENT_NOT_FOUND"});
  assert.equal(calls.some(x=>x[0]==="apply"),false);
});
