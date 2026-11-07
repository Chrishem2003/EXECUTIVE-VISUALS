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
export function estimateRunwayVideoCredits(options={}) {
  if(!options||typeof options!=="object"||Array.isArray(options)) {
    throw fail("Pricing options must be an object.","RUNWAY_PRICE_INVALID_INPUT");
  }
  const allowed=new Set([
    "model","durationSeconds","resolution","audio","inputVideoSeconds","referenceVideoSeconds",
    "referenceImageCount","referenceAudioCount","hasStartFrame","outputFrames","sourceWidth",
    "sourceHeight","sourceDynamicRange","outputWidth","outputHeight","outputFormat","targetFramerate","inputType","durationAuto","pricingDate"
  ]);
  const unknown=Object.keys(options).filter(key=>!allowed.has(key));
  if(unknown.length) {
    throw fail("Unsupported pricing options: "+unknown.join(", "),"RUNWAY_PRICE_UNSUPPORTED_OPTION");
  }
  const {
    model,durationSeconds,resolution:outputResolution,audio:hasAudio,
    inputVideoSeconds:requestedInputVideoSeconds,referenceVideoSeconds=0,referenceImageCount=0,referenceAudioCount=0,
    hasStartFrame=false,outputFrames,sourceWidth,sourceHeight,sourceDynamicRange,outputWidth,outputHeight,outputFormat:requestedOutputFormat,targetFramerate,inputType="text",durationAuto=false,pricingDate
  }=options;
  const outputFormat=requestedOutputFormat??(model==="ruby"?"hdr10":"mp4");
  const durationLimit=model==="enhance_frame_rate"?300:model==="gemini_omni_flash_1.2"?15:model==="kling_4_flash"?20:30;
  if(typeof durationAuto!=="boolean")throw fail("durationAuto must be a boolean.","RUNWAY_PRICE_INVALID_INPUT");
  if(durationAuto&&model!=="gemini_omni_flash_1.2")throw fail("Automatic duration reservation is supported only for Gemini Omni 1.2 Flash.","RUNWAY_PRICE_UNSUPPORTED_OPTION");
  if(durationAuto&&durationSeconds!==undefined)throw fail("Provide either durationSeconds or durationAuto, not both.","RUNWAY_PRICE_INVALID_INPUT");
  const duration=durationAuto?15:finiteDuration(durationSeconds,"durationSeconds",{max:durationLimit});
  const inputVideoLimit=model==="enhance_frame_rate"?300:30;
  const inputVideo=finiteDuration(requestedInputVideoSeconds??(model==="enhance_frame_rate"?durationSeconds:0),"inputVideoSeconds",{allowZero:true,max:inputVideoLimit});
  if(model==="gen4.5"&&(duration<2||duration>10))throw fail("durationSeconds must be between 2 and 10 for Gen-4.5.","RUNWAY_PRICE_INVALID_INPUT");
  if(["kling_4_flash","gemini_omni_flash_1.2"].includes(model)&&duration<3) {
    throw fail("durationSeconds must be at least 3 for "+model+".","RUNWAY_PRICE_INVALID_INPUT");
  }
  const referenceVideo=finiteDuration(referenceVideoSeconds,"referenceVideoSeconds",{allowZero:true,max:30});
  if(!["text","image","video"].includes(inputType))throw fail("inputType must be text, image or video.","RUNWAY_PRICE_INVALID_INPUT");
  if(model==="ruby"&&sourceDynamicRange!=="sdr")throw fail("Ruby requires an explicitly verified SDR source video.","RUNWAY_PRICE_INPUT_REQUIRED");
  if(model!=="ruby"&&sourceDynamicRange!==undefined)throw fail("sourceDynamicRange is supported only by Ruby HDR pricing.","RUNWAY_PRICE_UNSUPPORTED_OPTION");
  const frameRates=new Set([24,25,30,48,50,60,120,"23_98","29_97","59_94"]);
  if(model==="enhance_frame_rate") {
    if(!frameRates.has(targetFramerate))throw fail("A documented targetFramerate is required for frame-rate enhancement.","RUNWAY_PRICE_INPUT_REQUIRED");
  } else if(targetFramerate!==undefined) {
    throw fail("targetFramerate is supported only by Enhance Frame Rate.","RUNWAY_PRICE_UNSUPPORTED_OPTION");
  }
  const imageCount=count(referenceImageCount,"referenceImageCount");
  const audioCount=count(referenceAudioCount,"referenceAudioCount");
  if(typeof hasStartFrame!=="boolean")throw fail("hasStartFrame must be a boolean.","RUNWAY_PRICE_INVALID_INPUT");
  const hasImageStartFrame=hasStartFrame||inputType==="image";
  const billableImageReferences=imageCount+(hasImageStartFrame?1:0);
  if(audioCount>0&&model!=="grok_imagine_1_5")throw fail("Reference audio pricing is only verified for Grok Imagine Video 1.5.","RUNWAY_PRICE_UNSUPPORTED_OPTION");
  if(model==="grok_imagine_1_5") {
    if(imageCount>7||audioCount>3||billableImageReferences>7)throw fail("Grok Imagine Video 1.5 accepts at most 7 image and 3 audio references.","RUNWAY_PRICE_INVALID_INPUT");
    if(audioCount>0&&billableImageReferences===0)throw fail("Grok Imagine Video 1.5 audio references require at least one image reference or start frame.","RUNWAY_PRICE_INPUT_REQUIRED");
  }
  if(model==="grok_imagine_1_5_lite"&&(imageCount>0||audioCount>0))throw fail("Grok Imagine Video 1.5 Lite does not support reference images or audio.","RUNWAY_PRICE_UNSUPPORTED_OPTION");
  if(model==="gemini_omni_flash"&&((inputType==="text"&&imageCount>0)||(inputType==="image"&&imageCount>0)||(inputType!=="video"&&audioCount>0)))throw fail("The selected Gemini Omni Flash input mode does not support the supplied reference counts.","RUNWAY_PRICE_UNSUPPORTED_OPTION");
  const dateShape=typeof pricingDate==="string"&&/^20[0-9]{2}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$/.test(pricingDate);
  const parsedDate=dateShape?new Date(pricingDate+"T00:00:00Z"):null;
  if(!parsedDate||Number.isNaN(parsedDate.getTime())||parsedDate.toISOString().slice(0,10)!==pricingDate) {
    throw fail("pricingDate must be a valid explicit YYYY-MM-DD value.","RUNWAY_PRICE_INPUT_REQUIRED");
  }
  let credits,formula,pricingModel=model,discount=null;
  const perSecond=(rate)=>{credits=duration*rate;formula=duration+"s × "+rate+" credits/s";};
  const minimum=(rate,min)=>{credits=Math.max(min,duration*rate);formula="max("+min+" credit minimum, "+duration+"s × "+rate+" credits/s)";};
  const resolutionRate=(rates)=>{
    const normalized=outputResolution==="2160p"&&Object.hasOwn(rates,"4k")?"4k":outputResolution;
    return rates[resolution(normalized,Object.keys(rates))];
  };
  const PROFESSIONAL_HDR_FORMATS=new Set([
    "hdr10","hlg","hdr_pq_12bit_master","hdr_prores","hdr_png_sequence",
    "hdr_exr_sequence","hdr_exr_acescg_sequence_1_3","hdr_exr_acescg_sequence_2_0"
  ]);
  const RUBY_HDR_FORMATS=new Set(["hdr10","hlg","hdr_prores","hdr_exr_sequence","hdr_exr_acescg_sequence_1_3","hdr_exr_acescg_sequence_2_0"]);
  const PROFESSIONAL_SDR_FORMATS=new Set(["sdr_rec709_10bit"]);
  const EDITORIAL_FORMATS=new Set(["prores","png_sequence"]);
  if(typeof outputFormat!=="string")throw fail("outputFormat must be a string.","RUNWAY_PRICE_INVALID_INPUT");
  if(outputFormat!=="mp4"&&outputFormat!=="mov"&&!EDITORIAL_FORMATS.has(outputFormat)&&
     !PROFESSIONAL_HDR_FORMATS.has(outputFormat)&&!PROFESSIONAL_SDR_FORMATS.has(outputFormat)) {
    throw fail("No verified pricing formula exists for outputFormat "+outputFormat+".","RUNWAY_PRICE_UNSUPPORTED_OPTION");
  }
  let outputSurcharge=0;
  if(model==="ruby") {
    if(!RUBY_HDR_FORMATS.has(outputFormat))throw fail("Ruby requires a documented HDR delivery profile.","RUNWAY_PRICE_UNSUPPORTED_OPTION");
  } else if(EDITORIAL_FORMATS.has(outputFormat)) {
    if(!["gen4.5","aleph2"].includes(model))throw fail("ProRes and PNG sequence outputs are supported only for Gen-4.5 and Aleph 2.0.","RUNWAY_PRICE_UNSUPPORTED_OPTION");
    outputSurcharge=5*duration;
  } else if(PROFESSIONAL_SDR_FORMATS.has(outputFormat)||PROFESSIONAL_HDR_FORMATS.has(outputFormat)) {
    if(!["gen4.5","aleph2"].includes(model)||
       (PROFESSIONAL_HDR_FORMATS.has(outputFormat)&&model!=="gen4.5")) {
      throw fail("The selected professional output format is not supported by this model.","RUNWAY_PRICE_UNSUPPORTED_OPTION");
    }
    if(!Number.isSafeInteger(outputWidth)||outputWidth<16||outputWidth>4096||
       !Number.isSafeInteger(outputHeight)||outputHeight<16||outputHeight>4096) {
      throw fail("outputWidth and outputHeight are required for 10-bit/HDR output pricing.","RUNWAY_PRICE_INPUT_REQUIRED");
    }
    const outputMegapixels=outputWidth*outputHeight/1000000;
    outputSurcharge=(outputMegapixels>4?40:20)*duration;
  } else if(outputFormat==="mov"&&model!=="seedance2_5") {
    throw fail("MOV output without a professional surcharge is supported only for Seedance 2.5.","RUNWAY_PRICE_UNSUPPORTED_OPTION");
  }

  switch(model) {
    case "gen4.5": perSecond(12); break;
    case "aleph2": minimum(28,56); break;
    case "gen4_turbo": case "act_two": perSecond(5); break;
    case "kling2.5_turbo_pro": perSecond(12); break;
    case "kling3.0_standard": perSecond(audio(hasAudio)?13:9); break;
    case "kling3.0_pro": perSecond(audio(hasAudio)?17:12); break;
    case "kling3.0_4k": perSecond(43); break;
    case "klingO3_standard":
      if(inputType==="video"&&inputVideo<=0)throw fail("inputVideoSeconds is required for Kling O3 video-to-video pricing.","RUNWAY_PRICE_INPUT_REQUIRED");
      credits=(inputType==="video"?inputVideo:duration)*13;
      formula=(inputType==="video"?inputVideo+"s input video":duration+"s output")+" × 13 credits/s";
      break;
    case "klingO3_pro":
      if(inputType==="video"&&inputVideo<=0)throw fail("inputVideoSeconds is required for Kling O3 video-to-video pricing.","RUNWAY_PRICE_INPUT_REQUIRED");
      credits=(inputType==="video"?inputVideo:duration)*17;
      formula=(inputType==="video"?inputVideo+"s input video":duration+"s output")+" × 17 credits/s";
      break;
    case "klingO3_4k":
      if(inputType==="video"&&inputVideo<=0)throw fail("inputVideoSeconds is required for Kling O3 video-to-video pricing.","RUNWAY_PRICE_INPUT_REQUIRED");
      credits=(inputType==="video"?inputVideo:duration)*43;
      formula=(inputType==="video"?inputVideo+"s input video":duration+"s output")+" × 43 credits/s";
      break;
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
      credits=duration*resolutionRate({"480p":10,"720p":16,"1080p":29})+billableImageReferences+audioCount;
      formula=duration+"s × resolution rate + "+billableImageReferences+" image references (including start frame) + "+audioCount+" audio references";
      break;
    case "grok_imagine_1_5_lite":
      credits=duration*resolutionRate({"480p":2,"720p":3,"1080p":14})+(hasImageStartFrame?1:0);
      formula=duration+"s × resolution rate + "+(hasImageStartFrame?1:0)+" image-to-video start frame";
      break;
    case "h3_max": perSecond(resolutionRate({"480p":5,"768p":8})); break;
    case "hailuo3": {
      const rate=resolutionRate({"768p":10,"2k":15});
      const billableReferenceVideo=Math.min(15,inputVideo+referenceVideo);
      credits=duration*rate+billableImageReferences*2+billableReferenceVideo*rate;
      formula=duration+"s × "+rate+" + "+billableImageReferences+" reference images/keyframes (including start frame) × 2 + min(15s, input/reference video combined) × "+rate;
      break;
    }
    case "veo3.1": perSecond(audio(hasAudio)?40:20); break;
    case "veo3.1_fast": perSecond(audio(hasAudio)?15:10); break;
    case "happyhorse_1_0": perSecond(resolutionRate({"720p":15,"1080p":30})); break;
    case "gemini_omni_flash": {
      if(!["text","image","video"].includes(inputType))throw fail("inputType must be text, image or video.","RUNWAY_PRICE_INVALID_INPUT");
      if(inputType==="video") {
        credits=Math.min(10,inputVideo)*11+billableImageReferences;
        formula="min(10s, input video) × 11 + "+billableImageReferences+" reference images";
      } else {
        credits=duration*10+(hasImageStartFrame?1:0);
        formula=duration+"s × 10"+(hasImageStartFrame?" + 1 first-frame image":"");
      }
      break;
    }

    case "kling_4_flash": {
      resolution(outputResolution,["720p"]);
      if(billableImageReferences>10)throw fail("Kling 4.0 Flash accepts at most 10 images including the first frame.","RUNWAY_PRICE_INVALID_INPUT");
      if(inputType==="video"&&inputVideo<=0)throw fail("inputVideoSeconds is required for Kling 4.0 Flash video-to-video pricing.","RUNWAY_PRICE_INPUT_REQUIRED");
      const billableInputVideo=Math.min(20,inputVideo+referenceVideo);
      const raw=billableInputVideo>0
        ? duration*6.3+Math.max(billableInputVideo,duration)*6.3
        : duration*9.4;
      credits=Math.max(29,Math.ceil(raw));
      formula=billableInputVideo>0
        ? "max(29, ceil("+duration+"s output × 6.3 + max("+billableInputVideo+"s combined input/reference video, "+duration+"s output) × 6.3))"
        : "max(29, ceil("+duration+"s output × 9.4))";
      break;
    }
    case "gemini_omni_flash_1.2": {
      const rate=resolutionRate({"360p":2,"720p":7,"1080p":10,"4k":21});
      const maxImages=inputType==="image"?2:5;
      if(imageCount>maxImages||billableImageReferences>maxImages)throw fail("Gemini Omni 1.2 Flash accepts at most "+maxImages+" images/keyframes for this input mode.","RUNWAY_PRICE_INVALID_INPUT");
      if(inputType==="video"&&inputVideo<=0)throw fail("inputVideoSeconds is required for Gemini Omni 1.2 video-to-video pricing.","RUNWAY_PRICE_INPUT_REQUIRED");
      credits=Math.max(6,Math.ceil(duration*rate+billableImageReferences+inputVideo+referenceVideo));
      formula="max(6, ceil("+duration+"s output × "+rate+" + "+billableImageReferences+" image references/keyframes + "+(inputVideo+referenceVideo)+"s input/reference video))";
      break;
    }
    case "gemini_omni_flash_1.1": {
      const rate=resolutionRate({"360p":3.4,"720p":10,"1080p":15,"4k":30});
      credits=duration*rate+billableImageReferences+inputVideo;
      formula=duration+"s × "+rate+" + "+billableImageReferences+" reference images (including start frame) + "+inputVideo+"s input video";
      break;
    }
    case "kling_4": {
      const tier=resolution(outputResolution,["720p","1080p"]);
      const promo=pricingDate<="2026-11-30";
      const listRate=tier==="720p"?15.7:23.5;
      const listInputRate=tier==="720p"?9.4:14.1;
      const billableInputVideo=Math.min(30,inputVideo+referenceVideo);
      const listCharge=Math.ceil(billableInputVideo>0
        ? duration*listInputRate+Math.max(billableInputVideo,duration)*listInputRate
        : duration*listRate);
      credits=promo?Math.ceil(listCharge*0.8):listCharge;
      formula=billableInputVideo>0
        ? "ceil(list price: "+duration+"s output + max("+billableInputVideo+"s combined input/reference video, "+duration+"s output), each × "+listInputRate+"); then "+(promo?"ceil(80% of list charge)":"list charge")
        : "ceil("+duration+"s × "+listRate+" list credits/s)"+(promo?"; then ceil(80% of list charge)":"");
      if(promo)discount="20% promotion through 2026-11-30 UTC";
      break;
    }
    case "magnific_video_upscaler_creative": {
      if(!Number.isSafeInteger(outputFrames)||outputFrames<1||outputFrames>1000000) {
        throw fail("outputFrames must be an explicit positive frame count for video upscaling.","RUNWAY_PRICE_INPUT_REQUIRED");
      }
      const tier=resolution(outputResolution,["720p","1k","2k","4k"]);
      const rate=tier==="720p"||tier==="1k"?0.007:tier==="2k"?0.009:0.012;
      credits=Math.max(1,Math.ceil(outputFrames*rate/0.01));
      formula="ceil("+outputFrames+" output frames × $"+rate.toFixed(3)+" per frame ÷ $0.01 per credit)";
      break;
    }
    case "enhance_frame_rate":
      if(inputVideo<=0)throw fail("inputVideoSeconds is required for frame-rate pricing.","RUNWAY_PRICE_INPUT_REQUIRED");
      credits=Math.ceil(inputVideo/2);
      formula="ceil("+inputVideo+" input seconds ÷ 2) credits";
      break;
    case "ruby": {
      if(!Number.isSafeInteger(sourceWidth)||sourceWidth<16||sourceWidth>4096||!Number.isSafeInteger(sourceHeight)||sourceHeight<16||sourceHeight>4096) {
        throw fail("sourceWidth and sourceHeight are required to determine the Ruby HDR rate tier.","RUNWAY_PRICE_INPUT_REQUIRED");
      }
      const megapixels=sourceWidth*sourceHeight/1000000;
      const rate=megapixels>4?40:20;
      perSecond(rate);
      formula=duration+"s × "+rate+" credits/s ("+megapixels.toFixed(2)+" MP source)";
      break;
    }
    default:
      throw fail("No verified pricing formula is available for "+String(model)+".","RUNWAY_PRICE_UNSUPPORTED_MODEL");
  }
  if(!Number.isFinite(credits)||credits<0)throw fail("Pricing calculation produced an invalid result.","RUNWAY_PRICE_INVALID_RESULT");
  credits=Math.round((credits+outputSurcharge)*100)/100;
  if(outputSurcharge>0)formula+=" + "+outputSurcharge+" professional output surcharge credits ("+outputFormat+")";
  return Object.freeze({
    provider:"runway",model:pricingModel,pricingDate,source:SOURCE,
    estimatedCredits:credits,estimatedUsd:Math.round(credits*0.01*10000)/10000,
    currency:"USD",formula,discount,
    durationAutoReservationSeconds:durationAuto?15:null,
    evidenceType:"published_price_estimate",billable:false,settlementEligible:false
  });
}
