import test from "node:test";
import assert from "node:assert/strict";
import { estimateRunwayImageCredits, listRunwayImageModels } from "../runway-image-pricing.mjs";

const date="2026-11-07";
test("GPT Image 2.6 pricing matches documented 1K quality/aspect-ratio tiers",()=>{
  assert.equal(estimateRunwayImageCredits({model:"gpt_image_2_6_flare",resolution:"1K",ratio:"1920:1920",quality:"low",pricingDate:date}).estimatedCredits,2);
  assert.equal(estimateRunwayImageCredits({model:"gpt_image_2_6_flare",resolution:"1K",ratio:"1920:1920",quality:"medium",pricingDate:date}).estimatedCredits,3);
  assert.equal(estimateRunwayImageCredits({model:"gpt_image_2_6_flare",resolution:"1K",ratio:"1920:1920",quality:"high",pricingDate:date}).estimatedCredits,11);
  assert.equal(estimateRunwayImageCredits({model:"gpt_image_2_6_sunburst",resolution:"1K",ratio:"1920:1088",quality:"high",pricingDate:date}).estimatedCredits,5);
  assert.equal(estimateRunwayImageCredits({model:"gpt_image_2_6_sunburst",resolution:"1K",ratio:"2048:880",quality:"high",pricingDate:date}).estimatedCredits,4);
});
test("GPT Image 2.6 pricing matches 2K and 4K tier tables",()=>{
  assert.equal(estimateRunwayImageCredits({model:"gpt_image_2_6_flare",resolution:"2K",ratio:"2560:2560",quality:"high",pricingDate:date}).estimatedCredits,16);
  assert.equal(estimateRunwayImageCredits({model:"gpt_image_2_6_flare",resolution:"4K",ratio:"2880:2880",quality:"high",pricingDate:date}).estimatedCredits,19);
  assert.equal(estimateRunwayImageCredits({model:"gpt_image_2_6_flare",resolution:"4K",ratio:"3840:1648",quality:"medium",pricingDate:date}).estimatedCredits,2);
});
test("reference images are charged once per generated output and output count is bounded",()=>{
  const result=estimateRunwayImageCredits({model:"gpt_image_2_6_flare",resolution:"1K",ratio:"1920:1920",quality:"medium",outputCount:4,referenceImageCount:3,pricingDate:date});
  assert.equal(result.estimatedCredits,(3+3)*4);
  assert.equal(result.billable,false);
  assert.equal(result.settlementEligible,false);
  assert.throws(()=>estimateRunwayImageCredits({model:"gpt_image_2_6_flare",outputCount:11,pricingDate:date}),e=>e.code==="RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  assert.throws(()=>estimateRunwayImageCredits({model:"gpt_image_2_6_flare",referenceImageCount:17,pricingDate:date}),e=>e.code==="RUNWAY_IMAGE_PRICE_INVALID_INPUT");
});
test("auto ratio reserves the 4K square rate and reports the reserve explicitly",()=>{
  const result=estimateRunwayImageCredits({model:"gpt_image_2_6_sunburst",ratio:"auto",resolution:"1K",quality:"high",pricingDate:date});
  assert.equal(result.resolution,"4K");
  assert.equal(result.estimatedCredits,19);
  assert.equal(result.autoResolutionReserve,true);
});
test("unsupported models, ratio values, quality and dates fail closed",()=>{
  assert.throws(()=>estimateRunwayImageCredits({model:"gpt_image_2_5_flare",pricingDate:date}),e=>e.code==="RUNWAY_IMAGE_PRICE_UNSUPPORTED_MODEL");
  assert.throws(()=>estimateRunwayImageCredits({model:"gpt_image_2_6_flare",ratio:"16:10",pricingDate:date}),e=>e.code==="RUNWAY_IMAGE_PRICE_UNSUPPORTED_OPTION");
  assert.throws(()=>estimateRunwayImageCredits({model:"gpt_image_2_6_flare",quality:"xhigh",pricingDate:date}),e=>e.code==="RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  assert.throws(()=>estimateRunwayImageCredits({model:"gpt_image_2_6_flare",pricingDate:"2026-02-31"}),e=>e.code==="RUNWAY_IMAGE_PRICE_INPUT_REQUIRED");
});

test("GPT Image 2.6 models are catalogued but cannot be selected for execution",()=>{
  const models=listRunwayImageModels();
  assert.deepEqual(models.map(model=>model.id),["gpt_image_2_6_flare","gpt_image_2_6_sunburst"]);
  for(const model of models){
    assert.equal(model.availability,"adapter_supported");
    assert.equal(model.executionAdapter,"runway-image-v1");
    assert.equal(model.promptMaxCharacters,32000);
    assert.equal(model.maxReferenceImages,16);
    assert.deepEqual(model.resolutions,["1K","2K","4K"]);
    assert.deepEqual(model.qualities,["low","medium","high"]);
    assert.deepEqual(model.backgrounds,["auto","opaque","transparent"]);
  }
});

test("GPT Image 2.6 accepts only the exact documented pixel dimensions and matching tiers",()=>{
  assert.equal(estimateRunwayImageCredits({model:"gpt_image_2_6_flare",ratio:"1088:1920",quality:"high",pricingDate:date}).ratioCategory,"9:16");
  assert.equal(estimateRunwayImageCredits({model:"gpt_image_2_6_flare",ratio:"1536:1920",quality:"high",pricingDate:date}).estimatedCredits,8);
  assert.throws(()=>estimateRunwayImageCredits({model:"gpt_image_2_6_flare",ratio:"1600:900",quality:"high",pricingDate:date}),e=>e.code==="RUNWAY_IMAGE_PRICE_UNSUPPORTED_OPTION");
  assert.throws(()=>estimateRunwayImageCredits({model:"gpt_image_2_6_flare",resolution:"1K",ratio:"2560:2560",quality:"high",pricingDate:date}),e=>e.code==="RUNWAY_IMAGE_PRICE_INVALID_INPUT");
});
test("reasoning effort and background are accepted but do not alter published image price",()=>{
  const base=estimateRunwayImageCredits({model:"gpt_image_2_6_flare",ratio:"1920:1920",quality:"high",pricingDate:date});
  const variant=estimateRunwayImageCredits({model:"gpt_image_2_6_flare",ratio:"1920:1920",quality:"high",reasoningEffort:"low",background:"transparent",pricingDate:date});
  assert.equal(variant.estimatedCredits,base.estimatedCredits);
  assert.equal(variant.reasoningEffort,"low");
  assert.equal(variant.background,"transparent");
});
