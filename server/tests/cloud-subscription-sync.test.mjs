import test from "node:test";
import assert from "node:assert/strict";
import {openDatabase} from "../db.mjs";
import {ensureBillingSchema} from "../billing.mjs";
import {ensureBillingWebhookSchema} from "../billing-webhooks.mjs";
import {ensureDodoSubscriptionSchema} from "../dodo-subscriptions.mjs";
import {enqueueCloudSubscriptionSync,processNextCloudSubscriptionSync} from "../cloud-subscription-sync.mjs";

function setup(){
 const db=openDatabase(":memory:");ensureBillingSchema(db);ensureBillingWebhookSchema(db);
 ensureDodoSubscriptionSchema(db);return db;
}
const input={
 provider:"dodo",providerEventId:"webhook-event-001",ownerId:"owner-uuid",
 planCode:"creator",providerCustomerId:"cus_test_123",providerSubscriptionId:"sub_test_123",
 periodStart:"2026-11-01T00:00:00.000Z",periodEnd:"2026-12-01T00:00:00.000Z",
 metadata:{paymentId:"pay_test_123"}
};

test("outbox enqueues verified provider subscriptions once",()=>{
 const db=setup();try{
  const first=enqueueCloudSubscriptionSync(db,input);
  const second=enqueueCloudSubscriptionSync(db,input);
  assert.equal(first.id,second.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cloud_subscription_sync_outbox").get().n,1);
 }finally{db.close();}
});

test("sync worker activates cloud subscription and grants period credits idempotently",async()=>{
 const db=setup();let activateCalls=0,grantCalls=0;
 try{
  enqueueCloudSubscriptionSync(db,input);
  const ledger={
   async activateSubscription(args){activateCalls++;assert.equal(args.ownerId,input.ownerId);assert.equal(args.providerSubscriptionId,input.providerSubscriptionId);return {subscriptionId:"cloud-sub-1",replayed:activateCalls>1};},
   async grantPeriodCredits(args){grantCalls++;assert.equal(args.subscriptionId,"cloud-sub-1");assert.equal(args.periodStart,input.periodStart);return {ledgerId:"ledger-1",balance:120,replayed:grantCalls>1};}
  };
  const first=await processNextCloudSubscriptionSync(db,{ledger});
  assert.equal(first.processed,true);assert.equal(first.balance,120);
  assert.equal(db.prepare("SELECT processed_at IS NOT NULL done FROM cloud_subscription_sync_outbox").get().done,1);
  assert.deepEqual(await processNextCloudSubscriptionSync(db,{ledger}),{processed:false});
 }finally{db.close();}
});

test("failed credit grant retries activation safely before retrying grant",async()=>{
 const db=setup();let grants=0,activations=0;
 try{
  enqueueCloudSubscriptionSync(db,input);
  const ledger={
   async activateSubscription(){activations++;return {subscriptionId:"cloud-sub-1",replayed:activations>1};},
   async grantPeriodCredits(){grants++;if(grants===1)throw Object.assign(new Error("temporary"),{code:"TEMPORARY"});return {ledgerId:"ledger-1",balance:120,replayed:false};}
  };
  const failed=await processNextCloudSubscriptionSync(db,{ledger});
  assert.equal(failed.retryable,true);
  const completed=await processNextCloudSubscriptionSync(db,{ledger});
  assert.equal(completed.processed,true);
  assert.equal(activations,2);assert.equal(grants,2);
  assert.equal(db.prepare("SELECT attempts FROM cloud_subscription_sync_outbox").get().attempts,1);
 }finally{db.close();}
});

test("outbox rejects invalid periods and unsupported providers",()=>{
 const db=setup();try{
  assert.throws(()=>enqueueCloudSubscriptionSync(db,{...input,provider:"manual"}));
  assert.throws(()=>enqueueCloudSubscriptionSync(db,{...input,periodEnd:input.periodStart}));
 }finally{db.close();}
});
