import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.mjs";
import { ensureBillingWebhookSchema, createBillingPurchaseOrder } from "../billing-webhooks.mjs";
import {
  ensureBillingSchema,touchBillingAccount,listBillingPlans,saveBillingPlan,assignManualSubscription,
  getBillingOverview,getBillingBalance,getAdminOverview,listAdminUsers,adjustBillingCredits,
  setBillingAccountStatus,canUsePaidModels,saveBillingModelPrice,listBillingModelPrices,resolveBillingCreditCost,assertBillingStorageQuota,assertConcurrentJobCapacity,
  spendBillingCredits,refundBillingCredits,settleBillingSpend,applyDailyFreeCredits
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
  assert.equal(overview.oneTimeCreditTopupsEnabled,false);
  assert.equal(overview.recurringSubscriptionsEnabled,false);
  assert.throws(()=>setBillingAccountStatus(db,{userId:"user-4",status:"owner"}),e=>e.code==="BILLING_STATUS_INVALID");
  db.close();
});


test("provider credit settlement refunds only the unused estimate and is idempotent",()=>{
  const env={...process.env,BILLING_ENFORCEMENT_ENABLED:"true",CREDITS_DAILY_FREE:"20"};
  const db=setup();
  try{
    touchBillingAccount(db,{id:"settlement-refund-user",email:"settlement-refund@example.test"},{env});
    const spend=spendBillingCredits(db,{
      userId:"settlement-refund-user",capability:"video.generate",
      referenceId:"video-job-1",idempotencyKey:"generation-spend:video-job-1",env
    });
    assert.equal(spend.charged,15);
    const settlement=settleBillingSpend(db,{
      userId:"settlement-refund-user",spendIdempotencyKey:"generation-spend:video-job-1",
      settlementKey:"provider-settlement:task-001",actualCredits:9,
      evidence:{provider:"runway",evidenceType:"provider_task_receipt",evidenceId:"task-001",providerTaskId:"task-001"}
    });
    assert.equal(settlement.settled,true);
    assert.equal(settlement.replayed,false);
    assert.equal(settlement.estimatedCredits,15);
    assert.equal(settlement.actualCredits,9);
    assert.equal(settlement.adjustmentCredits,6);
    assert.equal(settlement.balance,11);
    const replay=settleBillingSpend(db,{
      userId:"settlement-refund-user",spendIdempotencyKey:"generation-spend:video-job-1",
      settlementKey:"provider-settlement:task-001",actualCredits:9,
      evidence:{provider:"runway",evidenceType:"provider_task_receipt",evidenceId:"task-001"}
    });
    assert.equal(replay.replayed,true);
    assert.equal(replay.balance,11);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM billing_credit_settlements").get().count,1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM billing_credit_ledger WHERE idempotency_key='billing-settlement:provider-settlement:task-001'").get().count,1);
  }finally{db.close();}
});

test("provider settlement debits an estimate shortfall exactly once and rejects conflicting replays",()=>{
  const env={...process.env,BILLING_ENFORCEMENT_ENABLED:"true",CREDITS_DAILY_FREE:"20"};
  const db=setup();
  try{
    touchBillingAccount(db,{id:"settlement-debit-user",email:"settlement-debit@example.test"},{env});
    spendBillingCredits(db,{
      userId:"settlement-debit-user",capability:"image.generate",
      referenceId:"image-job-1",idempotencyKey:"generation-spend:image-job-1",env
    });
    const result=settleBillingSpend(db,{
      userId:"settlement-debit-user",spendIdempotencyKey:"generation-spend:image-job-1",
      settlementKey:"provider-settlement:image-001",actualCredits:7,
      evidence:{provider:"fal",evidenceType:"provider_invoice",evidenceId:"invoice-001",invoiceReference:"invoice-001"}
    });
    assert.equal(result.adjustmentCredits,-4);
    assert.equal(result.balance,13);
    assert.throws(()=>settleBillingSpend(db,{
      userId:"settlement-debit-user",spendIdempotencyKey:"generation-spend:image-job-1",
      settlementKey:"provider-settlement:image-001",actualCredits:8,
      evidence:{provider:"fal",evidenceType:"provider_invoice",evidenceId:"invoice-001"}
    }),error=>error.code==="BILLING_SETTLEMENT_CONFLICT"&&error.status===409);
    assert.throws(()=>settleBillingSpend(db,{
      userId:"settlement-debit-user",spendIdempotencyKey:"generation-spend:image-job-1",
      settlementKey:"provider-settlement:image-002",actualCredits:7,
      evidence:{provider:"fal",evidenceType:"provider_invoice",evidenceId:"invoice-002"}
    }),error=>error.code==="BILLING_SETTLEMENT_CONFLICT"&&error.status===409);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM billing_credit_settlements").get().count,1);
    assert.equal(getBillingBalance(db,"settlement-debit-user"),13);
  }finally{db.close();}
});

test("provider settlement rejects missing spend, unsupported evidence and invalid actual credits",()=>{
  const db=setup();
  try{
    touchBillingAccount(db,{id:"settlement-invalid-user",email:"settlement-invalid@example.test"});
    const input={
      userId:"settlement-invalid-user",spendIdempotencyKey:"generation-spend:missing",
      settlementKey:"provider-settlement:missing",actualCredits:0,
      evidence:{provider:"runway",evidenceType:"provider_cancelled_no_charge",evidenceId:"cancel-001"}
    };
    assert.throws(()=>settleBillingSpend(db,input),error=>error.code==="BILLING_SETTLEMENT_SPEND_NOT_FOUND");
    assert.throws(()=>settleBillingSpend(db,{...input,actualCredits:-1}),error=>error.code==="BILLING_SETTLEMENT_INVALID");
    assert.throws(()=>settleBillingSpend(db,{...input,evidence:{provider:"runway",evidenceType:"unverified_guess",evidenceId:"x"}}),error=>error.code==="BILLING_SETTLEMENT_INVALID");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM billing_credit_settlements").get().count,0);
  }finally{db.close();}
});

test("model price references require a valid source URL and retain provenance",()=>{
  const db=setup();
  const price=saveBillingModelPrice(db,{provider:"fal",model:"fal-ai/seedance",capability:"video.generate",unit:"5-second 720p clip",priceMicros:35000,currency:"USD",sourceUrl:"https://fal.ai/pricing",verifiedAt:"2026-11-07"});
  assert.equal(price.priceMicros,35000);
  assert.equal(listBillingModelPrices(db).length,1);
  assert.throws(()=>saveBillingModelPrice(db,{provider:"fal",model:"x",capability:"video",unit:"clip",priceMicros:1,sourceUrl:"http://bad.example"}),e=>e.code==="BILLING_MODEL_PRICE_INVALID");
  db.close();
});


test("generation credits use the canonical billing ledger with daily refills and idempotent refunds",()=>{
  const env={...process.env,BILLING_ENFORCEMENT_ENABLED:"true",CREDITS_DAILY_FREE:"20"};
  const db=setup();
  try{
    touchBillingAccount(db,{id:"generation-user",email:"generation@example.test"},{env});
    assert.equal(getBillingBalance(db,"generation-user"),20);
    const spend=spendBillingCredits(db,{userId:"generation-user",capability:"image.generate",referenceId:"job-1:node-1",idempotencyKey:"generation-spend:job-1:node-1",env});
    assert.equal(spend.charged,3);
    assert.equal(spend.balance,17);
    const replay=spendBillingCredits(db,{userId:"generation-user",capability:"image.generate",referenceId:"job-1:node-1",idempotencyKey:"generation-spend:job-1:node-1",env});
    assert.equal(replay.replayed,true);
    assert.equal(replay.balance,17);
    const refund=refundBillingCredits(db,{userId:"generation-user",spendIdempotencyKey:"generation-spend:job-1:node-1"});
    assert.equal(refund.refunded,3);
    assert.equal(refund.balance,20);
    const refundReplay=refundBillingCredits(db,{userId:"generation-user",spendIdempotencyKey:"generation-spend:job-1:node-1"});
    assert.equal(refundReplay.replayed,true);
    assert.equal(refundReplay.balance,20);
    const nextDay=applyDailyFreeCredits(db,"generation-user",{now:Date.now()+86400000,env});
    assert.equal(nextDay.granted,20);
    assert.equal(nextDay.balance,20);
  }finally{
    db.close();
  }
});

test("insufficient billing credits fail closed before a paid provider request",()=>{
  const env={...process.env,BILLING_ENFORCEMENT_ENABLED:"true",CREDITS_DAILY_FREE:"0"};
  const db=setup();
  try{
    touchBillingAccount(db,{id:"empty-generation-user",email:"empty@example.test"},{env});
    assert.throws(()=>spendBillingCredits(db,{userId:"empty-generation-user",capability:"video.generate",idempotencyKey:"generation-spend:empty:video",env}),error=>error.code==="BILLING_INSUFFICIENT_CREDITS"&&error.status===402);
    assert.equal(getBillingBalance(db,"empty-generation-user"),0);
  }finally{
    db.close();
  }
});

test("verified provider prices convert to credits using configured value and margin",()=>{
  const db=setup();
  const price=saveBillingModelPrice(db,{
    provider:"runway",model:"seedance2_5",capability:"video.generate",
    unit:"second",priceMicros:300000,currency:"USD",
    sourceUrl:"https://dev.runway.com/pricing",verifiedAt:"2026-11-07T00:00:00.000Z"
  });
  assert.equal(price.active,true);
  const estimate=resolveBillingCreditCost(db,{
    provider:"runway",model:"seedance2_5",capability:"video.generate",
    unit:"second",quantity:5,
    env:{BILLING_CREDIT_VALUE_MICROS:"10000",BILLING_COST_MARKUP_BPS:"5000"}
  });
  assert.equal(estimate.source,"verified_model_price");
  assert.equal(estimate.rawCostMicros,1500000);
  assert.equal(estimate.markedCostMicros,2250000);
  assert.equal(estimate.credits,225);
  db.close();
});

test("unverified, missing or non-USD model prices never override conservative fallback credits",()=>{
  const db=setup();
  saveBillingModelPrice(db,{
    provider:"runway",model:"unverified",capability:"video.generate",
    unit:"second",priceMicros:1,currency:"USD",sourceUrl:"https://example.com/pricing"
  });
  const estimate=resolveBillingCreditCost(db,{
    provider:"runway",model:"unverified",capability:"video.generate",
    unit:"second",quantity:5,
    env:{BILLING_CREDIT_VALUE_MICROS:"10000"}
  });
  assert.equal(estimate.source,"flat_capability_fallback");
  assert.equal(estimate.credits,15);
  const noConfig=resolveBillingCreditCost(db,{
    provider:"runway",model:"unverified",capability:"video.generate",
    unit:"second",quantity:5,env:{}
  });
  assert.equal(noConfig.credits,15);
  db.close();
});

test("dynamic billing estimates reject overflow rather than silently undercharging",()=>{
  const db=setup();
  saveBillingModelPrice(db,{
    provider:"runway",model:"overflow",capability:"video.generate",
    unit:"second",priceMicros:Number.MAX_SAFE_INTEGER,currency:"USD",
    sourceUrl:"https://example.com/pricing",verifiedAt:"2026-11-07T00:00:00.000Z"
  });
  assert.throws(()=>resolveBillingCreditCost(db,{
    provider:"runway",model:"overflow",capability:"video.generate",
    unit:"second",quantity:2,
    env:{BILLING_CREDIT_VALUE_MICROS:"1",BILLING_COST_MARKUP_BPS:"50000"}
  }),error=>error.code==="BILLING_COST_ESTIMATE_INVALID");
  db.close();
});


test("invalid finance pricing configuration fails closed instead of falling back",()=>{
  const db=setup();
  assert.throws(()=>resolveBillingCreditCost(db,{
    capability:"video.generate",provider:"runway",model:"seedance2_5",unit:"second",quantity:5,
    env:{BILLING_CREDIT_VALUE_MICROS:"not-a-number"}
  }),error=>error.code==="BILLING_COST_CONFIG_INVALID");
  assert.throws(()=>resolveBillingCreditCost(db,{
    capability:"video.generate",provider:"runway",model:"seedance2_5",unit:"second",quantity:5,
    env:{BILLING_CREDIT_VALUE_MICROS:"10000",BILLING_COST_MARKUP_BPS:"999999"}
  }),error=>error.code==="BILLING_COST_CONFIG_INVALID");
  db.close();
});


test("stale or future provider prices fail closed until re-verified",()=>{
  const db=setup();
  saveBillingModelPrice(db,{
    provider:"runway",model:"stale",capability:"video.generate",unit:"second",
    priceMicros:300000,currency:"USD",sourceUrl:"https://dev.runway.com/pricing",
    verifiedAt:"2025-01-01T00:00:00.000Z"
  });
  assert.throws(()=>resolveBillingCreditCost(db,{
    provider:"runway",model:"stale",capability:"video.generate",unit:"second",quantity:5,
    env:{BILLING_CREDIT_VALUE_MICROS:"10000"}
  }),error=>error.code==="BILLING_MODEL_PRICE_STALE"&&error.status===503);
  db.close();
});


test("admin finance overview separates verified gross receipts from committed monthly recurring value",()=>{
  const db=setup();
  ensureBillingWebhookSchema(db);
  touchBillingAccount(db,{id:"finance-one",email:"finance-one@example.test"});
  touchBillingAccount(db,{id:"finance-two",email:"finance-two@example.test"});
  const topup=saveBillingPlan(db,{
    code:"ugx-topup",name:"UGX Top-up",amountMinor:50000,currency:"UGX",
    interval:"one_time",creditsPerPeriod:1000
  });
  const order=createBillingPurchaseOrder(db,{userId:"finance-one",planId:topup.id});
  db.prepare("UPDATE billing_payment_orders SET status='paid',verified_at=? WHERE id=?").run(new Date().toISOString(),order.id);
  db.prepare(`INSERT INTO billing_refund_events
    (id,provider,refund_id,payment_id,amount_minor,currency,created_at,user_id,reconciliation_required,reconciliation_note)
    VALUES('refund-pending-1','dodo','ref_pending_001','pay_pending_001',600,'USD',?,'finance-one',1,'Needs manual review')`)
    .run(new Date().toISOString());
  const timestamp=new Date().toISOString();
  db.prepare(`INSERT INTO billing_provider_events
    (id,provider,event_id,event_type,payload_hash,payload_json,processed_at,created_at)
    VALUES('dodo-event-1','dodo','subscription.renewed:payment-1','subscription.renewed','hash',?,?,?)`)
    .run(JSON.stringify({type:"subscription.renewed",data:{payment_id:"payment-1",currency:"USD",recurring_pre_tax_amount:1200}}),timestamp,timestamp);
  const monthly=saveBillingPlan(db,{
    code:"monthly-finance",name:"Monthly Finance",amountMinor:1200,currency:"USD",
    interval:"month",creditsPerPeriod:100
  });
  const annual=saveBillingPlan(db,{
    code:"annual-finance",name:"Annual Finance",amountMinor:12000,currency:"USD",
    interval:"year",creditsPerPeriod:100
  });
  assignManualSubscription(db,{userId:"finance-one",planId:monthly.id,periodDays:30,status:"active",actorId:"admin"});
  assignManualSubscription(db,{userId:"finance-two",planId:annual.id,periodDays:365,status:"active",actorId:"admin"});
  const overview=getAdminOverview(db);
  assert.deepEqual(overview.verifiedGrossReceipts30d,[{currency:"UGX",amountMinor:50000},{currency:"USD",amountMinor:1200}]);
  assert.deepEqual(overview.committedMrrByCurrency,[{currency:"USD",amountMinor:2200}]);
  assert.equal(overview.usage30d.estimatedCostMicros>=0,true);
  assert.equal(overview.pendingRefundReconciliation,1);
  db.close();
});


test("storage quotas reject uploads beyond the current plan allowance",()=>{
  assert.deepEqual(assertBillingStorageQuota({limitBytes:100,usedBytes:40,incomingBytes:60}),
    {allowed:true,limitBytes:100,usedBytes:40,incomingBytes:60,remainingBytes:0});
  assert.throws(()=>assertBillingStorageQuota({limitBytes:100,usedBytes:40,incomingBytes:61}),
    error=>error.code==="BILLING_STORAGE_QUOTA_EXCEEDED"&&error.status===413&&error.remainingBytes===60);
  assert.throws(()=>assertBillingStorageQuota({limitBytes:0,usedBytes:0,incomingBytes:1}),
    error=>error.code==="BILLING_STORAGE_QUOTA_EXCEEDED");
  assert.equal(assertBillingStorageQuota({limitBytes:null,usedBytes:999,incomingBytes:1}).unlimited,true);
});

test("concurrent job limits count queued, running and review jobs but release terminal slots",()=>{
  const db=setup();
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("job-limit-user","jobs@example.test");
  db.prepare("INSERT INTO jobs(id,owner_id,job_type,status,input_json) VALUES(?,?,?,?,?)")
    .run("job-queued","job-limit-user","media.probe","queued","{}");
  assert.throws(()=>assertConcurrentJobCapacity(db,{userId:"job-limit-user",limit:1}),
    error=>error.code==="BILLING_CONCURRENT_JOB_LIMIT"&&error.status===429&&error.used===1);
  assert.equal(assertConcurrentJobCapacity(db,{userId:"job-limit-user",limit:2}).allowed,true);
  db.prepare("UPDATE jobs SET status='succeeded' WHERE id='job-queued'").run();
  assert.deepEqual(assertConcurrentJobCapacity(db,{userId:"job-limit-user",limit:1}),
    {allowed:true,limit:1,used:0});
  db.close();
});

test("Runway Model Router image preflight estimates are converted into marked-up customer credits",()=>{
  const db=setup();
  try{
    const estimate=resolveBillingCreditCost(db,{
      provider:"runway",model:"gpt_image_2_6_flare",capability:"image.generate",
      unit:"image",quantity:3,runwayRouterEstimateCredits:42,
      env:{BILLING_CREDIT_VALUE_MICROS:"10000",BILLING_COST_MARKUP_BPS:"5000"}
    });
    assert.equal(estimate.source,"runway_model_router_preflight_estimate");
    assert.equal(estimate.providerCostCredits,42);
    assert.equal(estimate.providerCostUsd,0.42);
    assert.equal(estimate.credits,63);
    assert.equal(estimate.settlementEligible,false);
    assert.throws(()=>resolveBillingCreditCost(db,{
      provider:"runway",model:"model-router",capability:"image.generate",
      unit:"image",quantity:2,runwayRouterEstimateCredits:-1,
      env:{BILLING_CREDIT_VALUE_MICROS:"10000"}
    }),error=>error.code==="BILLING_RUNWAY_PRICING_INVALID");
  }finally{db.close();}
});

test("Runway image and video reservations use exact published model pricing before platform markup",()=>{
  const db=setup();
  try{
    const image=resolveBillingCreditCost(db,{
      provider:"runway",model:"gpt_image_2_6_flare",capability:"image.generate",
      unit:"image",quantity:1,
      runwayPricing:{ratio:"1920:1920",quality:"high",reasoningEffort:"high",background:"auto",outputCount:1,referenceImageCount:2},
      env:{BILLING_CREDIT_VALUE_MICROS:"10000",BILLING_COST_MARKUP_BPS:"5000"}
    });
    assert.equal(image.source,"runway_published_price_estimate");
    assert.equal(image.providerCostCredits,13);
    assert.equal(image.providerCostUsd,0.13);
    assert.equal(image.credits,20);
    assert.equal(image.settlementEligible,false);

    const kling=resolveBillingCreditCost(db,{
      provider:"runway",model:"kling_4_flash",capability:"video.generate",
      unit:"second",quantity:5,
      runwayPricing:{durationSeconds:5,resolution:"720p",inputType:"text",hasStartFrame:false,referenceImageCount:0,audio:true},
      env:{BILLING_CREDIT_VALUE_MICROS:"10000",BILLING_COST_MARKUP_BPS:"5000"}
    });
    assert.equal(kling.providerCostCredits,47);
    assert.equal(kling.credits,71);

    const gemini=resolveBillingCreditCost(db,{
      provider:"runway",model:"gemini_omni_flash_1.2",capability:"video.generate",
      unit:"second",quantity:5,
      runwayPricing:{durationSeconds:5,resolution:"720p",inputType:"text",hasStartFrame:false,referenceImageCount:0,audio:true},
      env:{BILLING_CREDIT_VALUE_MICROS:"10000",BILLING_COST_MARKUP_BPS:"5000"}
    });
    assert.equal(gemini.providerCostCredits,35);
    assert.equal(gemini.credits,53);
    assert.equal(gemini.settlementEligible,false);
  }finally{db.close();}
});
