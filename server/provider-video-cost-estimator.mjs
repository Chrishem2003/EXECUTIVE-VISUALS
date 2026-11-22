const RESOLUTIONS = new Set(["360p","480p","540p","720p","1080p","1440p","4k"]);
const DIMENSION_KEYS = new Set([
  "minimumGenerationMinor","referenceVideoSecondMinor","audioSurchargeSecondMinor",
  "audioIncluded","inputVideoSecondMinor","inputVideoBillingMode","inputImageMinor",
  ...[...RESOLUTIONS].flatMap(value=>[
    "videoSecondMinor_"+value,
    "referenceVideoSecondMinor_"+value,
    "inputVideoSecondMinor_"+value
  ])
]);
const fail=(code,message)=>Object.assign(new Error(message),{code});
function seconds(value,label,{required=false,max=600}={}){
  if(value===undefined||value===null||value===""){
    if(required)fail("PROVIDER_VIDEO_QUANTITY_REQUIRED",label+" is required.");
    return 0;
  }
  const number=Number(value);
  if(!Number.isFinite(number)||number<0||number>max)fail("PROVIDER_VIDEO_QUANTITY_INVALID",label+" must be between 0 and "+max+" seconds.");
  return number;
}
function count(value,label,{required=false,max=100}={}){
  if(value===undefined||value===null||value===""){
    if(required)fail("PROVIDER_VIDEO_QUANTITY_REQUIRED",label+" is required.");
    return 0;
  }
  if(!Number.isSafeInteger(value)||value<0||value>max)fail("PROVIDER_VIDEO_QUANTITY_INVALID",label+" must be a bounded non-negative integer.");
  return value;
}
function costFor(rate,quantity){
  const micros=BigInt(Math.ceil(quantity*1_000_000));
  const amount=(micros*BigInt(rate)+999_999n)/1_000_000n;
  if(amount>BigInt(Number.MAX_SAFE_INTEGER))fail("PROVIDER_VIDEO_COST_OVERFLOW","Estimated provider cost exceeds safe integer bounds.");
  return Number(amount);
}
function positiveRate(value,label,{allowZero=false}={}){
  if(!Number.isSafeInteger(value)||(allowZero?value<0:value<1)||value>9_000_000_000_000)
    fail("PROVIDER_VIDEO_RATE_CARD_INVALID",label+" must be a "+(allowZero?"non-negative":"positive")+" integer in currency minor units.");
  return value;
}

/**
 * Forecasts a model-specific video request from one immutable, currently
 * effective provider rate card. This is deliberately not a provider quote,
 * actual usage record, customer-credit quote or ledger operation.
 *
 * Supported numeric pricingDimensions:
 * - minimumGenerationMinor
 * - referenceVideoSecondMinor (+ optional resolution-specific override)
 * - audioSurchargeSecondMinor OR audioIncluded=1 when audio is requested
 * - inputVideoSecondMinor (+ inputVideoBillingMode=1 to bill max(input, output))
 * - inputImageMinor
 * - videoSecondMinor_<resolution> for resolution-specific output rates
 */
export function estimateProviderVideoCost({rateCard,request,now=new Date()}={}){
  if(!rateCard||typeof rateCard!=="object"||Array.isArray(rateCard)||!request||typeof request!=="object"||Array.isArray(request))
    fail("PROVIDER_VIDEO_ESTIMATE_INVALID","A trusted rate card and video request are required.");
  const provider=String(rateCard.provider||"").trim().toLowerCase();
  const model=String(rateCard.model||"").trim();
  const currency=String(rateCard.currency||"").trim().toUpperCase();
  const version=String(rateCard.rateCardVersion||rateCard.rate_card_version||"").trim();
  const billingUnit=String(rateCard.billingUnit||rateCard.billing_unit||"");
  const verificationStatus=String(rateCard.verificationStatus||rateCard.verification_status||"");
  const sourceUrl=String(rateCard.sourceUrl||rateCard.source_url||"");
  const sourceCheckedAt=rateCard.sourceCheckedAt||rateCard.source_checked_at||null;
  const effectiveFrom=rateCard.effectiveFrom||rateCard.effective_from;
  const effectiveTo=rateCard.effectiveTo??rateCard.effective_to??null;
  const clock=now instanceof Date?now.getTime():Date.parse(now);
  const from=Date.parse(effectiveFrom||"");
  const to=effectiveTo?Date.parse(effectiveTo):Infinity;
  if(!new Set(["source_linked","contract_attested","admin_attested"]).has(verificationStatus))
    fail("PROVIDER_VIDEO_RATE_CARD_UNVERIFIED","A currently effective, governed rate card with matching evidence is required.");
  if(provider.length<2||provider.length>80||!model||model.length>160||!/^[A-Z]{3}$/.test(currency)||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(version)||!["video_second","mixed"].includes(billingUnit)||
    !["source_linked","contract_attested","admin_attested"].includes(verificationStatus)||
    !Number.isFinite(from)||!Number.isFinite(clock)||from>clock||to<=clock||
    (verificationStatus==="source_linked"&&(!/^https:\/\//.test(sourceUrl)||!sourceCheckedAt||!Number.isFinite(Date.parse(sourceCheckedAt)))))
    fail("PROVIDER_VIDEO_RATE_CARD_UNVERIFIED","A currently effective, governed rate card with matching evidence is required.");
  const dimensions=rateCard.pricingDimensions??rateCard.pricing_dimensions??{};
  if(!dimensions||typeof dimensions!=="object"||Array.isArray(dimensions)||
    Object.entries(dimensions).some(([key,value])=>!DIMENSION_KEYS.has(key)||typeof value!=="number"||!Number.isSafeInteger(value)||value<0))
    fail("PROVIDER_VIDEO_RATE_CARD_INVALID","Rate-card pricing dimensions contain unsupported or invalid fields.");
  const resolution=String(request.resolution||"").trim().toLowerCase();
  if(!RESOLUTIONS.has(resolution))fail("PROVIDER_VIDEO_RESOLUTION_INVALID","Choose a supported output resolution.");
  const outputSeconds=seconds(request.outputSeconds,"outputSeconds",{required:true,max:60});
  if(outputSeconds<=0)fail("PROVIDER_VIDEO_QUANTITY_INVALID","outputSeconds must be greater than zero.");
  const referenceVideoSeconds=seconds(request.referenceVideoSeconds,"referenceVideoSeconds");
  const inputVideoSeconds=seconds(request.inputVideoSeconds,"inputVideoSeconds");
  const inputImageCount=count(request.inputImageCount,"inputImageCount");
  if(request.hasAudio!==undefined&&typeof request.hasAudio!=="boolean")
    fail("PROVIDER_VIDEO_AUDIO_INVALID","hasAudio must be a boolean.");
  const hasAudio=request.hasAudio===true;
  if(hasAudio&&!Object.hasOwn(dimensions,"audioIncluded")&&!Object.hasOwn(dimensions,"audioSurchargeSecondMinor"))
    fail("PROVIDER_VIDEO_AUDIO_PRICING_UNRESOLVED","Audio was requested but the rate card does not state whether audio is included or separately priced.");
  if(inputImageCount>0&&!Object.hasOwn(dimensions,"inputImageMinor"))
    fail("PROVIDER_VIDEO_RATE_MISSING","This rate card does not price input images.");
  if(referenceVideoSeconds>0&&!Object.hasOwn(dimensions,"referenceVideoSecondMinor")&&!Object.hasOwn(dimensions,"referenceVideoSecondMinor_"+resolution))
    fail("PROVIDER_VIDEO_RATE_MISSING","This rate card does not price reference-video seconds.");
  const baseRate=rateCard.videoSecondMinor??rateCard.video_second_minor;
  const outputRate=dimensions["videoSecondMinor_"+resolution]??baseRate;
  positiveRate(outputRate,"videoSecondMinor");
  const lines=[];
  const add=(driver,quantity,rate)=>{if(quantity<=0)return;positiveRate(rate,driver);lines.push({driver,quantity,rateMinor:rate,amountMinor:costFor(rate,quantity)});};
  add("output_video_seconds",outputSeconds,outputRate);
  if(referenceVideoSeconds>0){
    const rate=dimensions["referenceVideoSecondMinor_"+resolution]??dimensions.referenceVideoSecondMinor;
    if(rate===undefined)fail("PROVIDER_VIDEO_RATE_MISSING","This rate card does not price reference-video seconds.");
    add("reference_video_seconds",referenceVideoSeconds,rate);
  }
  if(inputVideoSeconds>0){
    if(!Object.hasOwn(dimensions,"inputVideoSecondMinor")&&!Object.hasOwn(dimensions,"inputVideoSecondMinor_"+resolution))
      fail("PROVIDER_VIDEO_RATE_MISSING","This rate card does not price input-video seconds.");
    const rate=dimensions["inputVideoSecondMinor_"+resolution]??dimensions.inputVideoSecondMinor;
    if(rate===undefined)fail("PROVIDER_VIDEO_RATE_MISSING","This rate card does not price input-video seconds.");
    const mode=dimensions.inputVideoBillingMode??0;
    if(mode!==0&&mode!==1)fail("PROVIDER_VIDEO_RATE_CARD_INVALID","inputVideoBillingMode must be 0 (input duration) or 1 (maximum input/output duration).");
    add("input_video_seconds",mode===1?Math.max(inputVideoSeconds,outputSeconds):inputVideoSeconds,rate);
  }
  if(inputImageCount>0){
    if(dimensions.inputImageMinor===undefined)fail("PROVIDER_VIDEO_RATE_MISSING","This rate card does not price input images.");
    add("input_images",inputImageCount,dimensions.inputImageMinor);
  }
  if(hasAudio){
    if(dimensions.audioIncluded===1){
      // Audio is included in the output rate.
    }else if(dimensions.audioSurchargeSecondMinor!==undefined){
      add("audio_output_seconds",outputSeconds,dimensions.audioSurchargeSecondMinor);
    }else{
      fail("PROVIDER_VIDEO_AUDIO_PRICING_UNRESOLVED","Audio was requested but the rate card does not state whether audio is included or separately priced.");
    }
  }
  let subtotal=lines.reduce((sum,line)=>sum+line.amountMinor,0);
  if(!Number.isSafeInteger(subtotal))fail("PROVIDER_VIDEO_COST_OVERFLOW","Estimated provider cost exceeds safe integer bounds.");
  const minimum=dimensions.minimumGenerationMinor===undefined?0:positiveRate(dimensions.minimumGenerationMinor,"minimumGenerationMinor",{allowZero:true});
  const minimumAdjustment=Math.max(0,minimum-subtotal);
  if(minimumAdjustment>0)lines.push({driver:"minimum_generation_adjustment",quantity:1,rateMinor:minimumAdjustment,amountMinor:minimumAdjustment});
  const total=Math.max(subtotal,minimum);
  return Object.freeze({
    estimateType:"provider_cost_forecast_not_actual",
    provider,model,currency,rateCardVersion:version,billingUnit,verificationStatus,
    source:{url:sourceUrl||null,checkedAt:sourceCheckedAt||null,fingerprint:rateCard.sourceFingerprint||rateCard.source_fingerprint||null},
    effectiveFrom:new Date(from).toISOString(),effectiveTo:Number.isFinite(to)?new Date(to).toISOString():null,
    request:{outputSeconds,referenceVideoSeconds,inputVideoSeconds,inputImageCount,resolution,hasAudio},
    costLines:Object.freeze(lines.map(line=>Object.freeze(line))),
    estimatedProviderCostMinor:total,
    limitations:Object.freeze([
      "Forecast only; not a provider quote, invoice, actual usage record or guaranteed charge.",
      "Only billing dimensions explicitly represented in this rate card are included.",
      "Provider-side minimums, promotions, taxes and contract discounts must be reflected in the effective rate-card version.",
      "Customer credits and subscription allowances are intentionally not calculated by this provider-cost estimator."
    ])
  });
}
