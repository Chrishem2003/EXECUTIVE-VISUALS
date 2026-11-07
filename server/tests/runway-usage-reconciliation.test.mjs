import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.mjs";
import { ensureBillingSchema, touchBillingAccount } from "../billing.mjs";
import {
  validateRunwayUsageWindow,
  normalizeRunwayOrganizationUsage,
  queryRunwayOrganizationUsage,
  loadRunwayBillingEstimates,
  reconcileRunwayDailyUsage
} from "../runway-usage-reconciliation.mjs";

test("Runway usage windows are UTC, exclusive-ended and limited to 90 days",()=>{
  assert.equal(validateRunwayUsageWindow({startDate:"2026-11-01",beforeDate:"2026-11-08"}).days,7);
  assert.throws(()=>validateRunwayUsageWindow({startDate:"2026-11-08",beforeDate:"2026-11-08"}),e=>e.code==="RUNWAY_USAGE_WINDOW_INVALID");
  assert.throws(()=>validateRunwayUsageWindow({startDate:"2026-11-01",beforeDate:"2027-02-01"}),e=>e.code==="RUNWAY_USAGE_WINDOW_INVALID");
  assert.throws(()=>validateRunwayUsageWindow({startDate:"2026-02-30",beforeDate:"2026-03-02"}),e=>e.code==="RUNWAY_USAGE_DATE_INVALID");
});

test("Runway aggregate usage normalizes negative provider debits by UTC day and model",()=>{
  const rows=normalizeRunwayOrganizationUsage({results:[
    {date:"2026-11-01",usedCredits:[{model:"gen4.5",amount:-12},{model:"gen4.5",amount:-3},{model:"kling_4_flash",amount:-7}]},
    {date:"2026-11-02",usedCredits:[{model:"gen4.5",amount:-2}]}
  ]});
  assert.deepEqual(rows,[
    {date:"2026-11-01",model:"gen4.5",actualCredits:15},
    {date:"2026-11-01",model:"kling_4_flash",actualCredits:7},
    {date:"2026-11-02",model:"gen4.5",actualCredits:2}
  ]);
  assert.throws(()=>normalizeRunwayOrganizationUsage({results:[{date:"2026-11-01",usedCredits:[{model:"gen4.5",amount:12}]}]}),e=>e.code==="RUNWAY_USAGE_RESPONSE_INVALID");
});

test("Runway organization usage client sends only bounded read-only date queries",async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});
    return new Response(JSON.stringify({results:[{date:"2026-11-01",usedCredits:[{model:"kling_4_flash",amount:-47}]}]}),{status:200});
  };
  const result=await queryRunwayOrganizationUsage({apiKey:"server-secret",startDate:"2026-11-01",beforeDate:"2026-11-08",fetchImpl});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,"https://api.dev.runwayml.com/v1/organization/usage");
  assert.equal(calls[0].options.method,"POST");
  assert.equal(calls[0].options.headers.authorization,"Bearer server-secret");
  assert.equal(calls[0].options.headers["X-Runway-Version"],"2024-11-06");
  assert.deepEqual(JSON.parse(calls[0].options.body),{startDate:"2026-11-01",beforeDate:"2026-11-08"});
  assert.equal(result.evidenceType,"provider_daily_model_aggregate");
  assert.equal(result.settlementEligible,false);
  assert.equal(result.totals[0].actualCredits,47);
});

test("Runway usage client fails closed on missing key and provider errors",async()=>{
  await assert.rejects(()=>queryRunwayOrganizationUsage({apiKey:"",startDate:"2026-11-01",beforeDate:"2026-11-02"}),e=>e.code==="RUNWAY_USAGE_KEY_REQUIRED");
  await assert.rejects(()=>queryRunwayOrganizationUsage({apiKey:"x",startDate:"2026-11-01",beforeDate:"2026-11-02",fetchImpl:async()=>new Response("no",{status:403})}),e=>e.code==="RUNWAY_USAGE_ACCESS_DENIED");
  await assert.rejects(()=>queryRunwayOrganizationUsage({apiKey:"x",startDate:"2026-11-01",beforeDate:"2026-11-02",fetchImpl:async()=>new Response("bad",{status:200})}),e=>e.code==="RUNWAY_USAGE_RESPONSE_INVALID");
  await assert.rejects(()=>queryRunwayOrganizationUsage({apiKey:"x",startDate:"2026-11-01",beforeDate:"2026-11-02",fetchImpl:async()=>new Response(JSON.stringify({results:[{date:"2026-11-02",usedCredits:[{model:"gen4.5",amount:-1}]}]}),{status:200})}),e=>e.code==="RUNWAY_USAGE_RESPONSE_INVALID");
});

test("local billing estimates aggregate from immutable ledger metadata without mutating it",()=>{
  const db=openDatabase(":memory:");
  try{
    ensureBillingSchema(db);
    touchBillingAccount(db,{id:"runway-audit-user",email:"audit@example.test"});
    const insert=db.prepare("INSERT INTO billing_credit_ledger(id,user_id,amount,event_type,description,idempotency_key,metadata_json,created_at) VALUES(?,?,?,'generation_spend',?,?,?,?)");
    insert.run("spend-one","runway-audit-user",-71,"video.generate","spend-one-key",JSON.stringify({costEstimate:{provider:"runway",model:"kling_4_flash",providerCostCredits:47}}),"2026-11-01T10:00:00.000Z");
    insert.run("spend-two","runway-audit-user",-53,"video.generate","spend-two-key",JSON.stringify({costEstimate:{provider:"runway",model:"gemini_omni_flash_1.2",providerCostCredits:35}}),"2026-11-01T11:00:00.000Z");
    insert.run("spend-other","runway-audit-user",-10,"video.generate","spend-other-key",JSON.stringify({costEstimate:{provider:"fal",model:"other",providerCostCredits:10}}),"2026-11-01T12:00:00.000Z");
    const estimates=loadRunwayBillingEstimates(db,{startDate:"2026-11-01",beforeDate:"2026-11-02"});
    assert.deepEqual(estimates,[
      {date:"2026-11-01",model:"gemini_omni_flash_1.2",estimatedCredits:35,jobCount:1},
      {date:"2026-11-01",model:"kling_4_flash",estimatedCredits:47,jobCount:1}
    ]);
  }finally{db.close();}
});

test("daily reconciliation reports variances and unmatched rows but never marks them settlement eligible",()=>{
  const rows=reconcileRunwayDailyUsage({
    actualUsage:[
      {date:"2026-11-01",model:"kling_4_flash",actualCredits:50},
      {date:"2026-11-01",model:"gen4.5",actualCredits:12}
    ],
    billingEstimates:[
      {date:"2026-11-01",model:"kling_4_flash",estimatedCredits:47,jobCount:1},
      {date:"2026-11-02",model:"gemini_omni_flash_1.2",estimatedCredits:35,jobCount:1}
    ]
  });
  const matched=rows.find(row=>row.model==="kling_4_flash");
  const providerOnly=rows.find(row=>row.model==="gen4.5");
  const platformOnly=rows.find(row=>row.model==="gemini_omni_flash_1.2");
  assert.equal(matched.varianceCredits,3);
  assert.equal(matched.variancePercent,6.38);
  assert.equal(matched.status,"aggregate_compared");
  assert.equal(matched.settlementEligible,false);
  assert.equal(providerOnly.status,"provider_usage_only");
  assert.equal(platformOnly.status,"platform_estimate_only");
});
