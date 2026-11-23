import test from "node:test";
import assert from "node:assert/strict";
import { estimateRunwayImageCredits, listRunwayImageModels } from "../runway-image-pricing.mjs";

const pricingDate = "2026-11-23";
const base = {
  model: "gpt_image_2_6_flare",
  pricingDate,
  ratio: "1920:1088",
  quality: "medium"
};

test("prices a documented 2K medium landscape image and per-output references", () => {
  const result = estimateRunwayImageCredits({
    ...base, ratio: "2560:1440", quality: "medium",
    outputCount: 3, referenceImageCount: 2
  });
  assert.equal(result.estimatedCredits, 21);
  assert.equal(result.estimatedUsd, 0.21);
  assert.equal(result.resolution, "2K");
  assert.equal(result.outputCount, 3);
  assert.equal(result.referenceImageCount, 2);
  assert.equal(result.billable, false);
  assert.equal(result.settlementEligible, false);
});

test("applies the two-credit minimum to a low-cost ultra-wide generation", () => {
  const result = estimateRunwayImageCredits({
    ...base, ratio: "2048:880", quality: "low", outputCount: 1
  });
  assert.equal(result.estimatedCredits, 2);
  assert.match(result.formula, /2-credit minimum per image/);
});

test("charges each reference image for each returned image", () => {
  const result = estimateRunwayImageCredits({
    ...base, ratio: "1920:1088", quality: "low",
    outputCount: 4, referenceImageCount: 3
  });
  assert.equal(result.estimatedCredits, 20);
  assert.equal(result.estimatedUsd, 0.2);
});

test("auto resolution reserves at the highest square 4K rate", () => {
  const result = estimateRunwayImageCredits({
    ...base, ratio: "auto", quality: "high", outputCount: 2
  });
  assert.equal(result.resolution, "4K");
  assert.equal(result.ratioCategory, "1:1");
  assert.equal(result.autoResolutionReserve, true);
  assert.equal(result.estimatedCredits, 38);
});

test("accepts the documented maximum output count of ten", () => {
  const result = estimateRunwayImageCredits({
    ...base, ratio: "1920:1088", quality: "medium", outputCount: 10
  });
  assert.equal(result.outputCount, 10);
  assert.equal(result.estimatedCredits, 40);
  assert.equal(listRunwayImageModels().every(model => model.outputCounts.max === 10), true);
});

test("keeps Flare and Sunburst pricing identical", () => {
  const flare = estimateRunwayImageCredits(base);
  const sunburst = estimateRunwayImageCredits({ ...base, model: "gpt_image_2_6_sunburst" });
  assert.equal(flare.estimatedCredits, sunburst.estimatedCredits);
  assert.equal(flare.estimatedUsd, sunburst.estimatedUsd);
});

test("rejects unsupported model, output count, reference count and missing evidence date", () => {
  assert.throws(() => estimateRunwayImageCredits({ ...base, model: "unknown-image-model" }), { code: "RUNWAY_IMAGE_PRICE_UNSUPPORTED_MODEL" });
  assert.throws(() => estimateRunwayImageCredits({ ...base, outputCount: 11 }), { code: "RUNWAY_IMAGE_PRICE_INVALID_INPUT" });
  assert.throws(() => estimateRunwayImageCredits({ ...base, referenceImageCount: 17 }), { code: "RUNWAY_IMAGE_PRICE_INVALID_INPUT" });
  assert.throws(() => estimateRunwayImageCredits({ model: base.model, ratio: base.ratio, quality: base.quality }), { code: "RUNWAY_IMAGE_PRICE_INPUT_REQUIRED" });
});

test("model catalogue accurately advertises supported output counts and reference limits", () => {
  const models = listRunwayImageModels();
  assert.equal(models.length, 2);
  for (const model of models) {
    assert.deepEqual(model.outputCounts, { min: 1, max: 10 });
    assert.equal(model.maxReferenceImages, 16);
    assert.deepEqual(model.qualities, ["low", "medium", "high"]);
  }
});


test("prices GIF animations by frame-count band and output count", () => {
  const twoToEight = estimateRunwayImageCredits({ ...base, ratio: "auto", outputFormat: "gif", frameCount: 8, outputCount: 3 });
  const nineToTwelve = estimateRunwayImageCredits({ ...base, ratio: "auto", outputFormat: "gif", frameCount: 9, quality: "medium" });
  const thirteenToSixteen = estimateRunwayImageCredits({ ...base, ratio: "auto", outputFormat: "gif", frameCount: 16, quality: "high", outputCount: 2 });
  assert.equal(twoToEight.estimatedCredits, 12);
  assert.equal(nineToTwelve.estimatedCredits, 7);
  assert.equal(thirteenToSixteen.estimatedCredits, 24);
  assert.equal(twoToEight.billable, false);
  assert.equal(twoToEight.settlementEligible, false);
});

test("prices SVG with a separate fifty-credit authoring charge per output", () => {
  const result = estimateRunwayImageCredits({
    ...base, outputFormat: "svg", ratio: "1920:1920", quality: "high", outputCount: 2
  });
  assert.equal(result.estimatedCredits, 122);
  assert.equal(result.authoringCredits, 100);
  assert.equal(result.estimatedUsd, 1.22);
  assert.match(result.formula, /50 SVG authoring credits/);
});

test("rejects GIF references, non-auto ratios and out-of-range frame counts", () => {
  assert.throws(() => estimateRunwayImageCredits({ ...base, ratio: "auto", outputFormat: "gif", referenceImageCount: 1 }), { code: "RUNWAY_IMAGE_PRICE_INVALID_INPUT" });
  assert.throws(() => estimateRunwayImageCredits({ ...base, outputFormat: "gif", ratio: "1920:1920" }), { code: "RUNWAY_IMAGE_PRICE_INVALID_INPUT" });
  assert.throws(() => estimateRunwayImageCredits({ ...base, ratio: "auto", outputFormat: "gif", frameCount: 17 }), { code: "RUNWAY_IMAGE_PRICE_INVALID_INPUT" });
});

test("rejects SVG references and frameCount on non-GIF output", () => {
  assert.throws(() => estimateRunwayImageCredits({ ...base, outputFormat: "svg", referenceImageCount: 1 }), { code: "RUNWAY_IMAGE_PRICE_INVALID_INPUT" });
  assert.throws(() => estimateRunwayImageCredits({ ...base, frameCount: 9 }), { code: "RUNWAY_IMAGE_PRICE_INVALID_INPUT" });
});
