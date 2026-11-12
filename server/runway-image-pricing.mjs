const SOURCE="https://docs.dev.runwayml.com/guides/pricing/";
const fail=(message,code)=>Object.assign(new Error(message),{code});
const TIERS=Object.freeze({
  "1K":Object.freeze({
    "1920:1920":"1:1","1536:1920":"4:5","1920:1536":"4:5",
    "1440:1920":"3:4","1920:1440":"3:4","1280:1920":"2:3","1920:1280":"2:3",
    "1088:1920":"9:16","1920:1088":"9:16","2048:880":"21:9"
  }),
  "2K":Object.freeze({
    "2560:2560":"1:1","2048:2560":"4:5","2560:2048":"4:5",
    "1920:2560":"3:4","2560:1920":"3:4","1712:2560":"2:3","2560:1712":"2:3",
    "1440:2560":"9:16","2560:1440":"9:16","2912:1248":"21:9"
  }),
  "4K":Object.freeze({
    "2880:2880":"1:1","2560:3200":"4:5","3200:2560":"4:5",
    "2448:3264":"3:4","3264:2448":"3:4","2336:3504":"2:3","3504:2336":"2:3",
    "2160:3840":"9:16","3840:2160":"9:16","3840:1648":"21:9"
  })
});
const TABLE=Object.freeze({
  "1K":{
    "1:1":{low:2,medium:3,high:11},"4:5":{low:1,medium:2,high:8},
    "3:4":{low:1,medium:2,high:7},"2:3":{low:1,medium:2,high:6},
    "9:16":{low:1,medium:2,high:5},"21:9":{low:1,medium:1,high:4}
  },
  "2K":{
    "1:1":{low:2,medium:4,high:16},"4:5":{low:2,medium:3,high:11},
    "3:4":{low:2,medium:3,high:10},"2:3":{low:1,medium:2,high:8},
    "9:16":{low:1,medium:2,high:6},"21:9":{low:1,medium:2,high:5}
  },
  "4K":{
    "1:1":{low:3,medium:5,high:19},"4:5":{low:2,medium:4,high:15},
    "3:4":{low:2,medium:4,high:14},"2:3":{low:2,medium:4,high:13},
    "9:16":{low:2,medium:3,high:11},"21:9":{low:1,medium:2,high:7}
  }
});
function resolveSize(ratio){
  if(ratio==="auto")return {resolution:"4K",ratioCategory:"1:1",auto:true};
  if(typeof ratio!=="string"||!/^[0-9]{2,5}:[0-9]{2,5}$/.test(ratio))throw fail("ratio must be auto or one of the exact documented pixel width:height sizes.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  for(const [resolution,sizes] of Object.entries(TIERS)){
    if(Object.hasOwn(sizes,ratio))return {resolution,ratioCategory:sizes[ratio],auto:false};
  }
  throw fail("ratio is not one of the 30 documented GPT Image 2.6 pixel sizes.","RUNWAY_IMAGE_PRICE_UNSUPPORTED_OPTION");
}
export function estimateRunwayImageCredits(options={}){
  if(!options||typeof options!=="object"||Array.isArray(options))throw fail("Pricing options must be an object.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  const allowed=new Set(["model","resolution","ratio","quality","reasoningEffort","background","outputCount","referenceImageCount","pricingDate"]);
  const unknown=Object.keys(options).filter(key=>!allowed.has(key));
  if(unknown.length)throw fail("Unsupported pricing options: "+unknown.join(", "),"RUNWAY_IMAGE_PRICE_UNSUPPORTED_OPTION");
  const {model,resolution,ratio="auto",quality="high",reasoningEffort="high",background="auto",outputCount=1,referenceImageCount=0,pricingDate}=options;
  if(!["gpt_image_2_6_flare","gpt_image_2_6_sunburst"].includes(model))throw fail("No verified image pricing formula exists for this model.","RUNWAY_IMAGE_PRICE_UNSUPPORTED_MODEL");
  if(!["low","medium","high"].includes(quality))throw fail("quality must be low, medium or high.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  if(!["low","medium","high"].includes(reasoningEffort))throw fail("reasoningEffort must be low, medium or high.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  if(!["auto","opaque","transparent"].includes(background))throw fail("background must be auto, opaque or transparent.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  if(!Number.isSafeInteger(outputCount)||outputCount<1||outputCount>10)throw fail("outputCount must be an integer from 1 to 10.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  if(!Number.isSafeInteger(referenceImageCount)||referenceImageCount<0||referenceImageCount>16)throw fail("referenceImageCount must be an integer from 0 to 16.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  if(typeof pricingDate!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(pricingDate)||Number.isNaN(Date.parse(pricingDate+"T00:00:00Z"))||new Date(pricingDate+"T00:00:00Z").toISOString().slice(0,10)!==pricingDate)throw fail("pricingDate must be a valid explicit YYYY-MM-DD value.","RUNWAY_IMAGE_PRICE_INPUT_REQUIRED");
  const size=resolveSize(ratio);
  if(resolution!==undefined&&!size.auto&&resolution!==size.resolution)throw fail("resolution does not match the selected exact pixel ratio size.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  const perImage=TABLE[size.resolution][size.ratioCategory][quality];
  const credits=(perImage+referenceImageCount)*outputCount;
  return Object.freeze({
    provider:"runway",model,pricingDate,source:SOURCE,
    estimatedCredits:credits,estimatedUsd:Math.round(credits*0.01*10000)/10000,
    currency:"USD",resolution:size.resolution,ratio,ratioCategory:size.ratioCategory,quality,reasoningEffort,background,outputCount,referenceImageCount,
    formula:"("+perImage+" credits/image + "+referenceImageCount+" reference-image credits/output) × "+outputCount+" outputs",
    autoResolutionReserve:size.auto,
    evidenceType:"published_price_estimate",billable:false,settlementEligible:false
  });
}
export function listRunwayImageModels(){
  return ["gpt_image_2_6_flare","gpt_image_2_6_sunburst"].map(id=>Object.freeze({
    id,provider:"runway",availability:"adapter_supported",executionAdapter:"runway-image-v1",
    promptMaxCharacters:32000,maxReferenceImages:16,resolutions:Object.freeze(["1K","2K","4K"]),outputCounts:Object.freeze({min:1,max:1}),
    sizeTiers:Object.freeze(Object.keys(TIERS)),supportedPixelSizes:Object.freeze(Object.fromEntries(Object.entries(TIERS).map(([tier,sizes])=>[tier,Object.freeze(Object.keys(sizes))]))),
    qualities:Object.freeze(["low","medium","high"]),reasoningEfforts:Object.freeze(["low","medium","high"]),
    backgrounds:Object.freeze(["auto","opaque","transparent"]),outputFormat:"png",
    pricingSource:SOURCE
  }));
}
