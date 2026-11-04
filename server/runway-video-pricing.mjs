const SOURCE="https://docs.dev.runwayml.com/guides/pricing/";
const fail=(message,code)=>Object.assign(new Error(message),{code});

function finiteDuration(value,label,{allowZero=false,max=1800}={}) {
  if(typeof value!=="number"||!Number.isFinite(value)||(allowZero?value<0:value<=0)||value>max) {
    throw fail(label+" must be "+(allowZero?"a non-negative":"a positive")+" finite number no greater than "+max+".","RUNWAY_PRICE_INVALID_INPUT");
  }
  return value;
}
function count(value,label,{max=100}={}) {
  if(value===undefined)return 0;
  if(!Number.isSafeInteger(value)||value<0||value>max)throw fail(label+" must be a non-negative integer no greater than "+max+".","RUNWAY_PRICE_INVALID_INPUT");
  return value;
}
function resolution(value,allowed) {
  if(typeof value!=="string"||!allowed.includes(value))throw fail("A supported resolution is required: "+allowed.join(", ")+".","RUNWAY_PRICE_INPUT_REQUIRED");
  return value;
}
function audio(value) {
  if(typeof value!=="boolean")throw fail("Audio must be explicitly set for this model's price calculation.","RUNWAY_PRICE_INPUT_REQUIRED");
  return value;
}

/**
 * Calculate a conservative, versioned Runway Dev credit estimate from the
 * published pricing table. This is not a quote, invoice or settlement receipt.
 * pricingDate is explicit so jobs retain the exact pricing snapshot used.
 */
export function estimateRunwayVideoCredits({
  model,durationSeconds,resolution:outputResolution,audio:hasAudio,
  inputVideoSeconds=0,referenceVideoSeconds=0,referenceImageCount=0,
  inputType="text",pricingDate
}={}) {
  const duration=finiteDuration(durationSeconds,"durationSeconds",{max:30});
  const inputVideo=finiteDuration(inputVideoSeconds,"inputVideoSeconds",{allowZero:true,max:30});
  const referenceVideo=finiteDuration(referenceVideoSeconds,"referenceVideoSeconds",{allowZero:true,max:30});
  const imageCount=count(referenceImageCount,"referenceImageCount");
  if(typeof pricingDate!=="string"||!/^(20\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(pricingDate)) {
    throw fail("pricingDate must be an explicit YYYY-MM-DD value.","RUNWAY_PRICE_INPUT_REQUIRED");
  }
  let credits,formula,pricingModel=model,discount=null;
  const perSecond=(rate)=>{credits=duration*rate;formula=duration+"s × "+rate+" credits/s";};
  const minimum=(rate,min)=>{credits=Math.max(min,duration*rate);formula="max("+min+" credit minimum, "+duration+"s × "+rate+" credits/s)";};
  const resolutionRate=(rates)=>rates[resolution(outputResolution,Object.keys(rates))];

  switch(model) {
    case "gen4.5": perSecond(12); break;
    case "gen4_turbo": case "act_two": perSecond(5); break;
    case "kling2.5_turbo_pro": perSecond(12); break;
    case "kling3.0_standard": perSecond(audio(hasAudio)?13:9); break;
    case "kling3.0_pro": perSecond(audio(hasAudio)?17:12); break;
    case "kling3.0_4k": case "klingO3_4k": perSecond(43); break;
    case "klingO3_standard": perSecond(13); break;
    case "klingO3_pro": perSecond(17); break;
    case "wan3": perSecond(resolutionRate({"480p":5,"720p":10,"1080p":20})); break;
    case "wan3_prime": perSecond(resolutionRate({"480p":6.8,"720p":14,"1080p":28})); break;
    case "seedance2":
      minimum(resolutionRate({"480p":14,"720p":30,"1080p":40,"4k":150}),56); break;
    case "seedance2_fast":
      minimum(resolutionRate({"480p":11,"720p":24}),44); break;
    case "seedance2_mini":
      minimum(resolutionRate({"480p":7,"720p":15}),28); break;
    case "seedance2_5": {
      const rates={
        "480p":{output:20,input:10}, "720p":{output:30,input:15}, "1080p":{output:68,input:34}
      };
      const rate=rates[resolution(outputResolution,Object.keys(rates))];
      const billableInput=Math.min(30,inputVideo+referenceVideo);
      credits=Math.max(80,duration*rate.output+billableInput*rate.input);
      formula="max(80 credit minimum, "+duration+"s × "+rate.output+" + min(30s, input+reference video) × "+rate.input+")";
      break;
    }
    case "grok_imagine_1_5":
      credits=duration*resolutionRate({"480p":10,"720p":16,"1080p":29})+imageCount;
      formula=duration+"s × resolution rate + "+imageCount+" image/audio references";
      break;
    case "grok_imagine_1_5_lite":
      credits=duration*resolutionRate({"480p":2,"720p":3,"1080p":14})+imageCount;
      formula=duration+"s × resolution rate + "+imageCount+" image-to-video start/reference images";
      break;
    case "h3_max": perSecond(resolutionRate({"480p":5,"768p":8})); break;
    case "hailuo3": {
      const rate=resolutionRate({"768p":10,"2k":15});
      const billableReferenceVideo=Math.min(15,referenceVideo);
      credits=duration*rate+imageCount*2+billableReferenceVideo*rate;
      formula=duration+"s × "+rate+" + "+imageCount+" reference images/keyframes × 2 + min(15s, reference video) × "+rate;
      break;
    }
    case "veo3.1": perSecond(audio(hasAudio)?40:20); break;
    case "veo3.1_fast": perSecond(audio(hasAudio)?15:10); break;
    case "happyhorse_1_0": perSecond(resolutionRate({"720p":15,"1080p":30})); break;
    case "gemini_omni_flash": {
      if(!["text","image","video"].includes(inputType))throw fail("inputType must be text, image or video.","RUNWAY_PRICE_INVALID_INPUT");
      if(inputType==="video") {
        credits=Math.min(10,inputVideo)*11+imageCount;
        formula="min(10s, input video) × 11 + "+imageCount+" reference images";
      } else {
        credits=duration*10+(inputType==="image"?1:0);
        formula=duration+"s × 10"+(inputType==="image"?" + 1 first-frame image":"");
      }
      break;
    }
    case "gemini_omni_flash_1.1": {
      const rate=resolutionRate({"360p":3.4,"720p":10,"1080p":15});
      credits=duration*rate+imageCount+inputVideo;
      formula=duration+"s × "+rate+" + "+imageCount+" reference images + "+inputVideo+"s input video";
      break;
    }
    case "kling_4": {
      const rates=resolution(outputResolution,["720p","1080p"]);
      const promo=pricingDate<="2026-11-30";
      const rate=rates==="720p"?(promo?12.56:15.7):(promo?18.8:23.5);
      if(inputVideo>0) {
        const inputRate=rates==="720p"?(promo?7.52:9.4):(promo?11.28:14.1);
        credits=duration*inputRate+Math.max(inputVideo,duration)*inputRate;
        formula=duration+"s output + max("+inputVideo+"s input, "+duration+"s output), each × "+inputRate;
      } else {
        credits=duration*rate;
        formula=duration+"s × "+rate+" credits/s";
      }
      if(promo)discount="20% promotion through 2026-11-30 UTC";
      break;
    }
    default:
      throw fail("No verified pricing formula is available for "+String(model)+".","RUNWAY_PRICE_UNSUPPORTED_MODEL");
  }
  if(!Number.isFinite(credits)||credits<0)throw fail("Pricing calculation produced an invalid result.","RUNWAY_PRICE_INVALID_RESULT");
  credits=Math.round(credits*100)/100;
  return Object.freeze({
    provider:"runway",model:pricingModel,pricingDate,source:SOURCE,
    estimatedCredits:credits,estimatedUsd:Math.round(credits*0.01*10000)/10000,
    currency:"USD",formula,discount,
    evidenceType:"published_price_estimate",billable:false,settlementEligible:false
  });
}
