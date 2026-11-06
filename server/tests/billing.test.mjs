import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.mjs";
import {
  ensureBillingSchema,touchBillingAccount,listBillingPlans,saveBillingPlan,assignManualSubscription,
  getBillingOverview,getBillingBalance,getAdminOverview,listAdminUsers,adjustBillingCredits,
  setBillingAccountStatus,canUsePaidModels,saveBillingModelPrice,listBillingModelPrices
} from "../billing.mjs";

function setup() {
  const db = openDatabase(":memory:");
  ensureBillingSchema(db);
  return db;
}

test("billing bootstrap creates a free plan and a safe default account", () => {
  const db = setup();
  const plans = listBillingPlans(db);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].code, "free");
  assert.equal(plans[0].amountMinor, 0);
  assert.deepEqual(plans[0].limits.modelAllowlist, []);
  const account = touchBillingAccount(db,{id:"user-1",email:"USER@example.test"});
  assert.equal(account.status,"active");
  const overview = getBillingOverview(db,"user-1");
  assert.equal(overview.plan.code,"free");
  assert.equal(overview.balance,0);
  assert.equal(overview.subscription.provider,"system");
  assert.equal(canUsePaidModels(db,"user-1"),false);
  db.close();
});

test("plan creation validates prices and creates explicit feature and quota definitions", () => {
  const db = setup();
  const plan = saveBillingPlan(db,{
    code:"creator",name:"Creator",description:"Solo creator tier",amountMinor:1900,currency:"USD",
    interval:"month",creditsPerPeriod:1200,
    limits:{seats:1,concurrentJobs:2,storageBytes:5000000000,modelAllowlist:["fal/seedance"]},
    features:["Video generation","Private projects"]
  });
  assert.equal(plan.amountMinor,1900);
  assert.equal(plan.creditsPerPeriod,1200);
  assert.deepEqual(plan.features,["Video generation","Private projects"]);
  assert.throws(()=>saveBillingPlan(db,{code:"invalid",name:"Bad",amountMinor:-1}),e=>e.code==="BILLING_PLAN_INVALID");
  db.close();
});

test("manual subscription assignment grants expiring credits exactly once", () => {
  const db = setup();
  touchBillingAccount(db,{id:"user-2",email:"creator@example.test"});
  const plan = saveBillingPlan(db,{code:"studio",name:"Studio",amountMinor:4900,currency:"USD",creditsPerPeriod:2500,limits:{modelAllowlist:["model-a"]}});
  const subscription = assignManualSubscription(db,{userId:"user-2",planId:plan.id,periodDays:30,actorId:"admin-1"});
  assert.equal(subscription.status,"active");
  assert.equal(getBillingBalance(db,"user-2"),2500);
  assert.equal(getBillingOverview(db,"user-2").plan.code,"studio");
  assert.equal(canUsePaidModels(db,"user-2"),true);
  db.close();
});

test("credit adjustments are idempotent and cannot overdraw a user", () => {
  const db = setup();
  touchBillingAccount(db,{id:"user-3",email:"credits@example.test"});
  const grant = adjustBillingCredits(db,{userId:"user-3",amount:100,description:"Pilot grant",actorId:"admin-1",idempotencyKey:"grant-key-0001"});
  assert.equal(grant.balance,100);
  const replay = adjustBillingCredits(db,{userId:"user-3",amount:100,description:"Duplicate",actorId:"admin-1",idempotencyKey:"grant-key-0001"});
  assert.equal(replay.replayed,true);
  assert.equal(replay.balance,100);
  assert.throws(()=>adjustBillingCredits(db,{userId:"user-3",amount:-101,description:"Overdraw",actorId:"admin-1",idempotencyKey:"debit-key-0001"}),e=>e.code==="BILLING_INSUFFICIENT_CREDITS");
  touchBillingAccount(db,{id:"user-3b",email:"other@example.test"});
  assert.throws(()=>adjustBillingCredits(db,{userId:"user-3b",amount:100,description:"Cross-account replay",actorId:"admin-1",idempotencyKey:"grant-key-0001"}),e=>e.code==="BILLING_IDEMPOTENCY_CONFLICT");
  const debit = adjustBillingCredits(db,{userId:"user-3",amount:-40,description:"Correction",actorId:"admin-1",idempotencyKey:"debit-key-0002"});
  assert.equal(debit.balance,60);
  assert.equal(getBillingBalance(db,"user-3"),60);
  db.close();
});

test("account status and admin reporting expose only known application accounts", () => {
  const db = setup();
  touchBillingAccount(db,{id:"user-4",email:"member@example.test"});
  assert.deepEqual(listAdminUsers(db)[0].email,"member@example.test");
  setBillingAccountStatus(db,{userId:"user-4",status:"suspended"});
  assert.equal(getBillingOverview(db,"user-4").accountStatus,"suspended");
  const overview = getAdminOverview(db);
  assert.equal(overview.users.total,1);
  assert.equal(overview.users.suspended,1);
  assert.equal(overview.paymentCollectionEnabled,false);
  assert.throws(()=>setBillingAccountStatus(db,{userId:"user-4",status:"owner"}),e=>e.code==="BILLING_STATUS_INVALID");
  db.close();
});

test("model price references require a valid source URL and retain provenance",()=>{
  const db=setup();
  const price=saveBillingModelPrice(db,{provider:"fal",model:"fal-ai/seedance",capability:"video.generate",unit:"5-second 720p clip",priceMicros:35000,currency:"USD",sourceUrl:"https://fal.ai/pricing",verifiedAt:"2026-11-07"});
  assert.equal(price.priceMicros,35000);
  assert.equal(listBillingModelPrices(db).length,1);
  assert.throws(()=>saveBillingModelPrice(db,{provider:"fal",model:"x",capability:"video",unit:"clip",priceMicros:1,sourceUrl:"http://bad.example"}),e=>e.code==="BILLING_MODEL_PRICE_INVALID");
  db.close();
});
