import { estimateRunwayVideoCredits } from "./runway-video-pricing.mjs";

const PRICING_SOURCE="https://docs.dev.runwayml.com/guides/pricing/";

/**
 * Shared preflight estimator used by the cloud budget reservation boundary.
 * Prices are server-dated estimates only; they are never settlement evidence.
 */
export function estimateVideoGenerationCost({
  provider,model,durationSeconds,outputFormat,
  resolution,audio,inputVideoSeconds,referenceVideoSeconds,referenceImageCount,
  referenceAudioCount,hasStartFrame,outputFrames,sourceWidth,sourceHeight,
  sourceDynamicRange,outputWidth,outputHeight,targetFramerate,inputType
}={}) {
  if(provider!=="runway") {
    const error=new Error("No verified video price is configured for this provider/model.");
    error.code="VIDEO_PRICE_UNVERIFIED";
    throw error;
  }
  const pricingDate=new Date().toISOString().slice(0,10);
  const effectiveOutputFormat=outputFormat??(model==="ruby"?"hdr10":"mp4");
  let estimate;
  try {
    estimate=estimateRunwayVideoCredits({
      model,durationSeconds,outputFormat,resolution,audio,inputVideoSeconds,
      referenceVideoSeconds,referenceImageCount,referenceAudioCount,hasStartFrame,
      outputFrames,sourceWidth,sourceHeight,sourceDynamicRange,outputWidth,
      outputHeight,targetFramerate,inputType,pricingDate
    });
  } catch(error) {
    const durationInvalid=error?.message?.startsWith("durationSeconds");
    const mapped=Object.assign(new Error(durationInvalid?"Video duration is outside the verified pricing bounds.":error?.message||"Runway pricing estimate failed."),{
      code:error?.code==="RUNWAY_PRICE_UNSUPPORTED_MODEL"?"VIDEO_PRICE_UNVERIFIED":
        error?.code==="RUNWAY_PRICE_INPUT_REQUIRED"?"VIDEO_PRICE_INPUT_REQUIRED":
        error?.code==="RUNWAY_PRICE_UNSUPPORTED_OPTION"?"VIDEO_PRICE_UNSUPPORTED_OPTION":
        error?.code==="RUNWAY_PRICE_INVALID_RESULT"?"VIDEO_PRICE_INVALID_RESULT":
        durationInvalid?"VIDEO_PRICE_DURATION_INVALID":"VIDEO_PRICE_INPUT_INVALID"
    });
    throw mapped;
  }
  return Object.freeze({
    provider,model,durationSeconds,outputFormat:effectiveOutputFormat,
    credits:estimate.estimatedCredits,currency:estimate.currency,
    amount:Number(estimate.estimatedUsd.toFixed(6)),
    basis:"provider_list_price_estimate",
    pricingSource:PRICING_SOURCE,pricingDate:estimate.pricingDate,
    pricingFormula:estimate.formula,
    evidenceType:estimate.evidenceType,billable:false,settlementEligible:false
  });
}