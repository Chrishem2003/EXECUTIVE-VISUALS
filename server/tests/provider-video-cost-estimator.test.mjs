import test from "node:test";
import assert from "node:assert/strict";
import {estimateProviderVideoCost} from "../provider-video-cost-estimator.mjs";

const card=(overrides={})=>({
 provider:"runway",model:"seedance-2.5",currency:"USD",rateCardVersion:"2026-11-v1",
 billingUnit:"video_second",videoSecondMinor:68,effectiveFrom:"2026-11-01T00:00:00Z",
 effectiveTo:null,sourceUrl:"https://dev.runway.com/pricing",
 sourceCheckedAt:"2026-11-20T10:00:00Z",verificationStatus:"source_linked",
 pricingDimensions:{referenceVideoSecondMinor:34,minimumGenerationMinor:80},
 ...overrides
});
const request=(overrides={})=>({outputSeconds:5,resolution:"1080p",...overrides});

test("estimates output, reference video and provider minimum with exact rate-card version",()=>{
 const result=estimateProviderVideoCost({rateCard:card(),request:request({referenceVideoSeconds:2})});
 assert.equal(result.estimateType,"provider_cost_forecast_not_actual");
 assert.equal(result.rateCardVersion,"2026-11-v1");
 assert.equal(result.costLines.find(x=>x.driver==="output_video_seconds").amountMinor,340);
 assert.equal(result.costLines.find(x=>x.driver==="reference_video_seconds").amountMinor,68);
 assert.equal(result.estimatedProviderCostMinor,408);
 assert.equal(result.currency,"USD");
});

test("applies resolution-specific rate and additive input-video and audio charges",()=>{
 const result=estimateProviderVideoCost({
  rateCard:card({pricingDimensions:{
   videoSecondMinor_720p:30,referenceVideoSecondMinor_720p:15,
   inputVideoSecondMinor_720p:10,inputVideoBillingMode:0,
   audioSurchargeSecondMinor:5,minimumGenerationMinor:0
  }}),
  request:request({resolution:"720p",inputVideoSeconds:3,referenceVideoSeconds:2,hasAudio:true})
 });
 assert.equal(result.costLines.find(x=>x.driver==="output_video_seconds").rateMinor,30);
 assert.equal(result.costLines.find(x=>x.driver==="input_video_seconds").amountMinor,30);
 assert.equal(result.costLines.find(x=>x.driver==="audio_output_seconds").amountMinor,25);
 assert.equal(result.estimatedProviderCostMinor,30*5+15*2+10*3+5*5);
});

test("uses max(input, output) duration when the rate card explicitly selects that formula",()=>{
 const result=estimateProviderVideoCost({
  rateCard:card({pricingDimensions:{inputVideoSecondMinor:20,inputVideoBillingMode:1}}),
  request:request({inputVideoSeconds:8})
 });
 assert.equal(result.costLines.find(x=>x.driver==="input_video_seconds").quantity,8);
 assert.equal(result.costLines.find(x=>x.driver==="input_video_seconds").amountMinor,160);
});

test("audio must be explicitly included or priced; it is never silently assumed free",()=>{
 assert.throws(()=>estimateProviderVideoCost({rateCard:card(),request:request({hasAudio:true})}),
  {code:"PROVIDER_VIDEO_AUDIO_PRICING_UNRESOLVED"});
 const included=estimateProviderVideoCost({
  rateCard:card({pricingDimensions:{audioIncluded:1}}),
  request:request({hasAudio:true})
 });
 assert.equal(included.estimatedProviderCostMinor,340);
});

test("fails closed for legacy, stale, future, unsupported and missing rate-card data",()=>{
 assert.throws(()=>estimateProviderVideoCost({rateCard:card({verificationStatus:"legacy_unverified"}),request:request()}),
  {code:"PROVIDER_VIDEO_RATE_CARD_UNVERIFIED"});
 assert.throws(()=>estimateProviderVideoCost({rateCard:card({effectiveTo:"2026-11-21T00:00:00Z"}),request:request(),now:"2026-11-22T00:00:00Z"}),
  {code:"PROVIDER_VIDEO_RATE_CARD_UNVERIFIED"});
 assert.throws(()=>estimateProviderVideoCost({rateCard:card({effectiveFrom:"2026-12-01T00:00:00Z"}),request:request()}),
  {code:"PROVIDER_VIDEO_RATE_CARD_UNVERIFIED"});
 assert.throws(()=>estimateProviderVideoCost({rateCard:card({pricingDimensions:{unsupportedFee:2}}),request:request()}),
  {code:"PROVIDER_VIDEO_RATE_CARD_INVALID"});
 assert.throws(()=>estimateProviderVideoCost({rateCard:card({videoSecondMinor:null}),request:request()}),
  {code:"PROVIDER_VIDEO_RATE_CARD_INVALID"});
});

test("requires explicit prices for requested input types and validates quantities",()=>{
 assert.throws(()=>estimateProviderVideoCost({rateCard:card(),request:request({inputImageCount:1})}),
  {code:"PROVIDER_VIDEO_RATE_MISSING"});
 assert.throws(()=>estimateProviderVideoCost({rateCard:card({pricingDimensions:{minimumGenerationMinor:80}}),request:request({referenceVideoSeconds:2})}),
  {code:"PROVIDER_VIDEO_RATE_MISSING"});
 assert.throws(()=>estimateProviderVideoCost({rateCard:card(),request:request({outputSeconds:0})}),
  {code:"PROVIDER_VIDEO_QUANTITY_INVALID"});
 assert.throws(()=>estimateProviderVideoCost({rateCard:card(),request:request({resolution:"8k"})}),
  {code:"PROVIDER_VIDEO_RESOLUTION_INVALID"});
});

test("applies input-image pricing and rounds fractional seconds upward in minor units",()=>{
 const result=estimateProviderVideoCost({
  rateCard:card({videoSecondMinor:3,pricingDimensions:{inputImageMinor:11,minimumGenerationMinor:0}}),
  request:request({outputSeconds:1.000001,inputImageCount:2,resolution:"720p"})
 });
 assert.equal(result.costLines.find(x=>x.driver==="output_video_seconds").amountMinor,4);
 assert.equal(result.costLines.find(x=>x.driver==="input_images").amountMinor,22);
 assert.equal(result.estimatedProviderCostMinor,26);
});
