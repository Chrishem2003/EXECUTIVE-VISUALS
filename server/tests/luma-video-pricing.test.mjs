import test from "node:test";
import assert from "node:assert/strict";
import { estimateLumaRay32Cost } from "../luma-video-pricing.mjs";

const date = "2026-11-04";

test("prices standard Ray 3.2 generation by resolution and duration", () => {
  const low=estimateLumaRay32Cost({resolution:"540p",durationSeconds:5,pricingDate:date});
  const medium=estimateLumaRay32Cost({resolution:"720p",durationSeconds:10,pricingDate:date});
  const high=estimateLumaRay32Cost({resolution:"1080p",durationSeconds:5,pricingDate:date});
  assert.deepEqual([low.credits,low.amount],[50,0.15]);
  assert.deepEqual([medium.credits,medium.amount],[300,0.90]);
  assert.deepEqual([high.credits,high.amount],[400,1.20]);
});

test("prices HDR and EXR generation only for documented 5-second 720p and 1080p combinations", () => {
  assert.equal(estimateLumaRay32Cost({resolution:"720p",durationSeconds:5,hdr:true,pricingDate:date}).amount,0.60);
  assert.equal(estimateLumaRay32Cost({resolution:"1080p",durationSeconds:5,hdr:true,exrExport:true,pricingDate:date}).amount,3.60);
  assert.throws(()=>estimateLumaRay32Cost({resolution:"540p",durationSeconds:5,hdr:true,pricingDate:date}),e=>e.code==="LUMA_PRICE_UNSUPPORTED_OPTION");
  assert.throws(()=>estimateLumaRay32Cost({resolution:"720p",durationSeconds:10,hdr:true,pricingDate:date}),e=>e.code==="LUMA_PRICE_UNSUPPORTED_OPTION");
  assert.throws(()=>estimateLumaRay32Cost({resolution:"720p",durationSeconds:5,exrExport:true,pricingDate:date}),e=>e.code==="LUMA_PRICE_UNSUPPORTED_OPTION");
});

test("prices video editing with distinct SDR, HDR and EXR rate tables", () => {
  assert.equal(estimateLumaRay32Cost({operation:"video_edit",resolution:"540p",durationSeconds:10,pricingDate:date}).amount,1.44);
  assert.equal(estimateLumaRay32Cost({operation:"video_edit",resolution:"720p",durationSeconds:5,hdr:true,pricingDate:date}).amount,2.16);
  assert.equal(estimateLumaRay32Cost({operation:"video_edit",resolution:"1080p",durationSeconds:10,hdr:true,exrExport:true,pricingDate:date}).amount,12.96);
});

test("extend is one fixed 5-second block and reframe is billed per second", () => {
  const extend=estimateLumaRay32Cost({operation:"video_extend",resolution:"720p",durationSeconds:10,pricingDate:date});
  assert.equal(extend.amount,0.30);
  assert.equal(extend.billedDurationSeconds,5);
  assert.equal(estimateLumaRay32Cost({operation:"video_reframe",resolution:"1080p",durationSeconds:10,pricingDate:date}).amount,3.60);
  assert.throws(()=>estimateLumaRay32Cost({operation:"video_reframe",resolution:"720p",durationSeconds:5,hdr:true,pricingDate:date}),e=>e.code==="LUMA_PRICE_UNSUPPORTED_OPTION");
});

test("fails closed for draft resolution, unsupported combinations and missing pricing evidence", () => {
  assert.throws(()=>estimateLumaRay32Cost({resolution:"360p",durationSeconds:5,pricingDate:date}),e=>e.code==="LUMA_PRICE_UNSUPPORTED_RESOLUTION");
  assert.throws(()=>estimateLumaRay32Cost({resolution:"720p",durationSeconds:7,pricingDate:date}));
  assert.throws(()=>estimateLumaRay32Cost({resolution:"720p",durationSeconds:5}),e=>e.code==="LUMA_PRICE_DATE_REQUIRED");
  assert.throws(()=>estimateLumaRay32Cost({resolution:"720p",durationSeconds:5,pricingDate:"2026-02-31"}),e=>e.code==="LUMA_PRICE_DATE_REQUIRED");
});

test("estimates are immutable and never marked billable or settlement eligible", () => {
  const estimate=estimateLumaRay32Cost({resolution:"720p",durationSeconds:5,pricingDate:date});
  assert.equal(estimate.billable,false);
  assert.equal(estimate.settlementEligible,false);
  assert.equal(estimate.currency,"USD");
  assert.equal(estimate.credits,100);
  assert.equal(estimate.creditToUsdRate,0.003);
  assert.equal(estimate.amount,0.30);
  assert.equal(estimate.basis,"default_list_rate_usd_per_credit");
  assert.equal(estimate.monetaryEstimateScope,"default_list_rate_only_account_plan_or_contract_rate_may_differ");
  assert.ok(Object.isFrozen(estimate));
});