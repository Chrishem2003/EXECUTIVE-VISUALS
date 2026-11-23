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

test("source-linked pricing evidence older than 45 days is not accepted for a new forecast",()=>{
 assert.throws(()=>estimateProviderVideoCost({
  rateCard:card({sourceCheckedAt:"2026-10-01T00:00:00Z"}),
  request:request(),now:"2026-11-22T00:00:00Z"
 }),{code:"PROVIDER_VIDEO_RATE_CARD_UNVERIFIED"});
});

test("an explicit zero-cost surcharge is accepted and remains visible in the itemization",()=>{
 const result=estimateProviderVideoCost({
  rateCard:card({pricingDimensions:{audioSurchargeSecondMinor:0,minimumGenerationMinor:0}}),
  request:request({hasAudio:true})
 });
 assert.equal(result.costLines.find(x=>x.driver==="audio_output_seconds").amountMinor,0);
 assert.equal(result.estimatedProviderCostMinor,340);
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


test("models published Runway Seedance 2.5 resolution pricing and reference-video charges",()=>{
 const rateCard=card({
  model:"seedance2_5",rateCardVersion:"runway-seedance2_5-2026-11-21",
  sourceUrl:"https://dev.runway.com/learn/seedance-2-5-api",
  sourceCheckedAt:"2026-11-23T00:00:00Z",
  videoSecondMinor:30,
  pricingDimensions:{
   videoSecondMinor_480p:20,
   videoSecondMinor_720p:30,
   videoSecondMinor_1080p:68,
   referenceVideoSecondMinor_480p:10,
   referenceVideoSecondMinor_720p:15,
   referenceVideoSecondMinor_1080p:34,
   minimumGenerationMinor:80
  }
 });
 const fiveSecond480=estimateProviderVideoCost({rateCard,request:request({resolution:"480p",outputSeconds:5})});
 const fiveSecond720=estimateProviderVideoCost({rateCard,request:request({resolution:"720p",outputSeconds:5})});
 const fiveSecond1080=estimateProviderVideoCost({rateCard,request:request({resolution:"1080p",outputSeconds:5})});
 const referenced1080=estimateProviderVideoCost({rateCard,request:request({resolution:"1080p",outputSeconds:5,referenceVideoSeconds:2})});
 assert.equal(fiveSecond480.estimatedProviderCostMinor,100);
 assert.equal(fiveSecond720.estimatedProviderCostMinor,150);
 assert.equal(fiveSecond1080.estimatedProviderCostMinor,340);
 assert.equal(referenced1080.estimatedProviderCostMinor,408);
 assert.equal(referenced1080.costLines.find(x=>x.driver==="reference_video_seconds").amountMinor,68);
});

test("applies the published Seedance 2.5 minimum charge to short generations",()=>{
 const rateCard=card({
  model:"seedance2_5",rateCardVersion:"runway-seedance2_5-2026-11-21",
  sourceUrl:"https://dev.runway.com/learn/seedance-2-5-api",
  sourceCheckedAt:"2026-11-23T00:00:00Z",videoSecondMinor:20,
  pricingDimensions:{videoSecondMinor_480p:20,minimumGenerationMinor:80}
 });
 const result=estimateProviderVideoCost({rateCard,request:request({resolution:"480p",outputSeconds:1})});
 assert.equal(result.estimatedProviderCostMinor,80);
 assert.equal(result.costLines.find(x=>x.driver==="minimum_generation_adjustment").amountMinor,60);
});


test("models Seedance 2.5 4K output and combined input/reference video billing",()=>{
 const rateCard=card({
  model:"seedance2_5",rateCardVersion:"runway-seedance2_5-2026-11-23",
  sourceUrl:"https://dev.runway.com/learn/seedance-2-5-api",
  sourceCheckedAt:"2026-11-23T00:00:00Z",
  videoSecondMinor:110,
  pricingDimensions:{
   videoSecondMinor_480p:20,videoSecondMinor_720p:30,
   videoSecondMinor_1080p:68,videoSecondMinor_4k:110,
   inputVideoSecondMinor_480p:10,inputVideoSecondMinor_720p:15,
   inputVideoSecondMinor_1080p:34,inputVideoSecondMinor_4k:57,
   inputVideoBillingMode:2,combinedVideoInputMaxSeconds:30,
   referenceVideoPaddingThresholdSeconds:2,referenceVideoPaddedSeconds:4.25,
   minimumGenerationMinor:80
  }
 });
 const fourK=estimateProviderVideoCost({rateCard,request:request({resolution:"4k",outputSeconds:5})});
 assert.equal(fourK.estimatedProviderCostMinor,550);
 const padded=estimateProviderVideoCost({rateCard,request:request({
  resolution:"1080p",outputSeconds:5,inputVideoSeconds:3,referenceVideoSeconds:2.5
 })});
 const line=padded.costLines.find(x=>x.driver==="combined_input_reference_video_seconds");
 assert.equal(line.quantity,7.25);
 assert.equal(line.rateMinor,34);
 assert.equal(line.amountMinor,247);
 assert.equal(padded.estimatedProviderCostMinor,587);
});

test("caps combined Seedance input and reference video billing at thirty seconds",()=>{
 const rateCard=card({
  model:"seedance2_5",rateCardVersion:"runway-seedance2_5-2026-11-23",
  sourceUrl:"https://dev.runway.com/learn/seedance-2-5-api",
  sourceCheckedAt:"2026-11-23T00:00:00Z",
  pricingDimensions:{
   inputVideoSecondMinor_720p:15,inputVideoBillingMode:2,
   combinedVideoInputMaxSeconds:30,minimumGenerationMinor:80
  }
 });
 assert.throws(()=>estimateProviderVideoCost({
  rateCard,request:request({resolution:"720p",inputVideoSeconds:20,referenceVideoSeconds:11})
 }),{code:"PROVIDER_VIDEO_QUANTITY_INVALID"});
});

test("uses the published padded reference duration at the two-to-under-four-second boundary",()=>{
 const rateCard=card({
  model:"seedance2_5",rateCardVersion:"runway-seedance2_5-2026-11-23",
  sourceUrl:"https://dev.runway.com/learn/seedance-2-5-api",
  sourceCheckedAt:"2026-11-23T00:00:00Z",
  pricingDimensions:{
   inputVideoSecondMinor_480p:10,inputVideoBillingMode:2,
   combinedVideoInputMaxSeconds:30,referenceVideoPaddingThresholdSeconds:2,
   referenceVideoPaddedSeconds:4.25,minimumGenerationMinor:0
  }
 });
 const below=estimateProviderVideoCost({rateCard,request:request({resolution:"480p",outputSeconds:5,referenceVideoSeconds:1.99})});
 const boundary=estimateProviderVideoCost({rateCard,request:request({resolution:"480p",outputSeconds:5,referenceVideoSeconds:2})});
 const upper=estimateProviderVideoCost({rateCard,request:request({resolution:"480p",outputSeconds:5,referenceVideoSeconds:3.99})});
 const atFour=estimateProviderVideoCost({rateCard,request:request({resolution:"480p",outputSeconds:5,referenceVideoSeconds:4})});
 assert.equal(below.costLines.find(x=>x.driver==="combined_input_reference_video_seconds").quantity,1.99);
 assert.equal(boundary.costLines.find(x=>x.driver==="combined_input_reference_video_seconds").quantity,4.25);
 assert.equal(upper.costLines.find(x=>x.driver==="combined_input_reference_video_seconds").quantity,4.25);
 assert.equal(atFour.costLines.find(x=>x.driver==="combined_input_reference_video_seconds").quantity,4);
});
