import test from "node:test";
import assert from "node:assert/strict";
import { estimateVideoGenerationCost } from "../video-generation-cost-estimator.mjs";

test("shared preflight estimates Runway using the existing dated credit contract", () => {
  const result = estimateVideoGenerationCost({ provider: "runway", model: "gen4.5", durationSeconds: 5 });
  assert.equal(result.provider, "runway");
  assert.equal(result.currency, "USD");
  assert.equal(result.amount, 0.6);
  assert.equal(result.billable, false);
  assert.equal(result.settlementEligible, false);
});

test("Kling 4.0 Flash estimates published 720p rates and its 29-credit minimum", () => {
  const text = estimateVideoGenerationCost({
    provider: "runway", model: "kling_4_flash", durationSeconds: 5,
    resolution: "720p", inputType: "text", pricingDate: "2026-11-16"
  });
  assert.equal(text.credits, 47);
  assert.equal(text.amount, 0.47);
  assert.equal(text.billable, false);
  const edit = estimateVideoGenerationCost({
    provider: "runway", model: "kling_4_flash", durationSeconds: 5,
    resolution: "720p", inputType: "video", inputVideoSeconds: 8,
    pricingDate: "2026-11-16"
  });
  assert.equal(edit.credits, 82);
  assert.equal(edit.amount, 0.82);
});

test("shared preflight applies current Kling 4.0 list pricing, input-video billing and HDR",()=>{
  const text=estimateVideoGenerationCost({
    provider:"runway",model:"kling_4",durationSeconds:10,resolution:"1080p",pricingDate:"2026-11-22"
  });
  assert.equal(text.credits,235);
  assert.equal(text.amount,2.35);
  assert.equal(Object.hasOwn(text,"discount"),false);
  const edit=estimateVideoGenerationCost({
    provider:"runway",model:"kling_4",durationSeconds:10,resolution:"1080p",
    inputType:"video",inputVideoSeconds:6,pricingDate:"2026-11-22"
  });
  assert.equal(edit.credits,376);
  assert.equal(edit.amount,3.76);
  const hdr=estimateVideoGenerationCost({
    provider:"runway",model:"kling_4",durationSeconds:10,resolution:"4k",hdr:true,pricingDate:"2026-11-22"
  });
  assert.equal(hdr.credits,627);
  assert.equal(hdr.amount,6.27);
  assert.equal(hdr.billable,false);
  assert.equal(hdr.settlementEligible,false);
});

test("shared preflight supports Luma Ray 3.2 published generation and edit prices", () => {
  const generation = estimateVideoGenerationCost({
    provider: "luma", model: "ray-3.2", operation: "video", resolution: "720p", durationSeconds: 5
  });
  assert.equal(generation.amount, 0.3);
  assert.equal(generation.credits, 100);
  assert.equal(generation.creditToUsdRate, 0.003);
  assert.equal(generation.basis, "default_list_rate_usd_per_credit");
  assert.equal(generation.currency, "USD");
  assert.equal(generation.provider, "luma");
  assert.match(generation.pricingDate, /^20\d{2}-\d{2}-\d{2}$/);
  assert.equal(generation.billable, false);
  assert.equal(generation.settlementEligible, false);

  const edit = estimateVideoGenerationCost({
    provider: "luma", model: "ray-3.2", operation: "video_edit",
    resolution: "1080p", durationSeconds: 10, hdr: true, exrExport: true
  });
  assert.equal(edit.amount, 12.96);
  assert.equal(edit.operation, "video_edit");
});

test("shared preflight prices Luma fixed extension and duration-based reframe", () => {
  const extend = estimateVideoGenerationCost({
    provider: "luma", model: "ray-3.2", operation: "video_extend", resolution: "1080p"
  });
  assert.equal(extend.amount, 1.2);
  assert.equal(extend.durationSeconds, undefined);

  const reframe = estimateVideoGenerationCost({
    provider: "luma", model: "ray-3.2", operation: "video_reframe",
    resolution: "720p", durationSeconds: 12.5
  });
  assert.equal(reframe.amount, 1.5);
});

test("shared preflight rejects unknown providers, models and unsupported Luma combinations", () => {
  assert.throws(
    () => estimateVideoGenerationCost({ provider: "luma", model: "other", resolution: "720p", durationSeconds: 5 }),
    error => error.code === "VIDEO_PRICE_UNVERIFIED"
  );
  const draft = estimateVideoGenerationCost({ provider: "luma", model: "ray-3.2", resolution: "360p", durationSeconds: 5 });
  assert.equal(draft.amount, 0.06);
  assert.equal(draft.credits, 20);
  assert.equal(draft.resolution, "360p");
  assert.throws(
    () => estimateVideoGenerationCost({ provider: "luma", model: "ray-3.2", resolution: "720p", durationSeconds: 10, hdr: true }),
    error => error.code === "LUMA_PRICE_UNSUPPORTED_OPTION"
  );
  assert.throws(
    () => estimateVideoGenerationCost({ provider: "unknown", model: "unknown" }),
    error => error.code === "VIDEO_PRICE_UNVERIFIED"
  );
});

test("preflight estimates are immutable and never authorize provider execution", () => {
  const result = estimateVideoGenerationCost({
    provider: "luma", model: "ray-3.2", resolution: "540p", durationSeconds: 5
  });
  assert.ok(Object.isFrozen(result));
  assert.equal(result.billable, false);
  assert.equal(result.settlementEligible, false);
  assert.equal(result.pricingStatus, "subject_to_change_before_general_availability");
});

test("shared preflight prices the November 2026 Runway Flash video models without treating estimates as settlement",()=>{
  const kling=estimateVideoGenerationCost({provider:"runway",model:"kling_4_flash",durationSeconds:5,resolution:"720p"});
  assert.equal(kling.credits,47);
  assert.equal(kling.amount,0.47);
  assert.equal(kling.billable,false);
  assert.equal(kling.settlementEligible,false);
  const gemini=estimateVideoGenerationCost({provider:"runway",model:"gemini_omni_flash_1.2",durationSeconds:5,resolution:"720p"});
  assert.equal(gemini.credits,35);
  assert.equal(gemini.amount,0.35);
  assert.equal(gemini.billable,false);
  assert.equal(gemini.settlementEligible,false);
});
