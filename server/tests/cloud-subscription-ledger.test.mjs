import test from "node:test";
import assert from "node:assert/strict";
import { createCloudSubscriptionLedger } from "../cloud-subscription-ledger.mjs";

const base={url:"https://example.supabase.co",serviceRoleKey:"service-role-test-secret",timeoutMs:3000};
const subscription={
  ownerId:"owner-123",planCode:"creator",provider:"flutterwave",
  providerCustomerId:"customer-123",providerSubscriptionId:"subscription-123",
  periodStart:"2026-11-01T00:00:00.000Z",periodEnd:"2026-12-01T00:00:00.000Z",
  status:"active",metadata:{verifiedPaymentId:"payment-123"}
};

test("activates a verified subscription through service-role schema RPC",async()=>{
  let request;
  const ledger=createCloudSubscriptionLedger({...base,fetchImpl:async(url,options)=>{
    request={url,options,body:JSON.parse(options.body)};
    return new Response(JSON.stringify([{subscription_id:"sub-row-1",replayed:false}]),{status:200});
  }});
  const result=await ledger.activateSubscription(subscription);
  assert.deepEqual(result,{subscriptionId:"sub-row-1",replayed:false});
  assert.equal(request.url,"https://example.supabase.co/rest/v1/rpc/activate_generation_subscription");
  assert.equal(request.options.headers["content-profile"],"executive_visuals");
  assert.equal(request.body.p_provider_subscription_id,"subscription-123");
  assert.equal(request.body.p_metadata.verifiedPaymentId,"payment-123");
});

test("rejects incomplete or invalid subscription periods before network access",async()=>{
  let calls=0;
  const ledger=createCloudSubscriptionLedger({...base,fetchImpl:async()=>{calls++;throw new Error("unexpected");}});
  await assert.rejects(ledger.activateSubscription({...subscription,periodEnd:subscription.periodStart}));
  await assert.rejects(ledger.activateSubscription({...subscription,provider:"unknown"}));
  await assert.rejects(ledger.activateSubscription({...subscription,providerSubscriptionId:""}));
  assert.equal(calls,0);
});

test("grants a subscription period idempotently through the ledger RPC",async()=>{
  let calls=0;
  const ledger=createCloudSubscriptionLedger({...base,fetchImpl:async(url,options)=>{
    calls++;
    assert.equal(url,"https://example.supabase.co/rest/v1/rpc/grant_subscription_period_credits");
    assert.equal(JSON.parse(options.body).p_subscription_id,"sub-row-1");
    return new Response(JSON.stringify([{ledger_id:"ledger-1",balance:120,replayed:calls>1}]),{status:200});
  }});
  const args={subscriptionId:"sub-row-1",periodStart:subscription.periodStart};
  assert.deepEqual(await ledger.grantPeriodCredits(args),{ledgerId:"ledger-1",balance:120,replayed:false});
  assert.deepEqual(await ledger.grantPeriodCredits(args),{ledgerId:"ledger-1",balance:120,replayed:true});
});

test("rejects invalid receipts and redacts service credentials",async()=>{
  const invalid=createCloudSubscriptionLedger({...base,fetchImpl:async()=>new Response("[]",{status:200})});
  await assert.rejects(invalid.grantPeriodCredits({subscriptionId:"sub-1",periodStart:subscription.periodStart}));
  const denied=createCloudSubscriptionLedger({...base,fetchImpl:async()=>new Response(JSON.stringify({message:"bad service-role-test-secret"}),{status:403})});
  await assert.rejects(denied.grantPeriodCredits({subscriptionId:"sub-1",periodStart:subscription.periodStart}),
    error=>!error.message.includes("service-role-test-secret"));
});
