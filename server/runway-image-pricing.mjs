const SOURCE="https://docs.dev.runwayml.com/guides/pricing/";
const fail=(message,code)=>Object.assign(new Error(message),{code});
const TABLE=Object.freeze({
  "1K":{
    "1:1":{low:2,medium:3,high:11},
    "4:5":{low:1,medium:2,high:8},
    "3:4":{low:1,medium:2,high:7},
    "2:3":{low:1,medium:2,high:6},
    "9:16":{low:1,medium:2,high:5},
    "21:9":{low:1,medium:1,high:4}
  },
  "2K":{
    "1:1":{low:2,medium:4,high:16},
    "4:5":{low:2,medium:3,high:11},
    "3:4":{low:2,medium:3,high:10},
    "2:3":{low:1,medium:2,high:8},
    "9:16":{low:1,medium:2,high:6},
    "21:9":{low:1,medium:2,high:5}
  },
  "4K":{
    "1:1":{low:3,medium:5,high:19},
    "4:5":{low:2,medium:4,high:15},
    "3:4":{low:2,medium:4,high:14},
    "2:3":{low:2,medium:4,high:13},
    "9:16":{low:2,medium:3,high:11},
    "21:9":{low:1,medium:2,high:7}
  }
});
const ratioCategory=value=>{
  if(value==="auto")return "1:1";
  if(typeof value!=="string"||!/^[0-9]{2,5}:[0-9]{2,5}$/.test(value))throw fail("ratio must be auto or a documented width:height value.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  const [w,h]=value.split(":").map(Number),r=w/h;
  const categories=[["1:1",1],["4:5",0.8],["3:4",0.75],["2:3",2/3],["9:16",9/16],["21:9",21/9]];
  let best=null,distance=Infinity;
  for(const [name,base] of categories)for(const candidate of [base,1/base]){
    const d=Math.abs(r-candidate);
    if(d<distance){distance=d;best=name;}
  }
  if(distance>0.02)throw fail("ratio is outside the supported GPT Image 2.6 aspect-ratio set.","RUNWAY_IMAGE_PRICE_UNSUPPORTED_OPTION");
  return best;
};
export function estimateRunwayImageCredits(options={}){
  if(!options||typeof options!=="object"||Array.isArray(options))throw fail("Pricing options must be an object.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  const allowed=new Set(["model","resolution","ratio","quality","outputCount","referenceImageCount","pricingDate"]);
  const unknown=Object.keys(options).filter(key=>!allowed.has(key));
  if(unknown.length)throw fail("Unsupported pricing options: "+unknown.join(", "),"RUNWAY_IMAGE_PRICE_UNSUPPORTED_OPTION");
  const {model,resolution="1K",ratio="auto",quality="high",outputCount=1,referenceImageCount=0,pricingDate}=options;
  if(!["gpt_image_2_6_flare","gpt_image_2_6_sunburst"].includes(model))throw fail("No verified image pricing formula exists for this model.","RUNWAY_IMAGE_PRICE_UNSUPPORTED_MODEL");
  if(!Object.hasOwn(TABLE,resolution))throw fail("resolution must be 1K, 2K or 4K.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  if(!["low","medium","high"].includes(quality))throw fail("quality must be low, medium or high.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  if(!Number.isSafeInteger(outputCount)||outputCount<1||outputCount>10)throw fail("outputCount must be an integer from 1 to 10.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  if(!Number.isSafeInteger(referenceImageCount)||referenceImageCount<0||referenceImageCount>16)throw fail("referenceImageCount must be an integer from 0 to 16.","RUNWAY_IMAGE_PRICE_INVALID_INPUT");
  if(typeof pricingDate!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(pricingDate)||Number.isNaN(Date.parse(pricingDate+"T00:00:00Z"))||new Date(pricingDate+"T00:00:00Z").toISOString().slice(0,10)!==pricingDate)throw fail("pricingDate must be a valid explicit YYYY-MM-DD value.","RUNWAY_IMAGE_PRICE_INPUT_REQUIRED");
  const category=ratioCategory(ratio);
  const upfrontTier=ratio==="auto"?"4K":resolution;
  const perImage=TABLE[upfrontTier][category][quality];
  const credits=(perImage+referenceImageCount)*outputCount;
  return Object.freeze({
    provider:"runway",model,pricingDate,source:SOURCE,
    estimatedCredits:credits,estimatedUsd:Math.round(credits*0.01*10000)/10000,
    currency:"USD",resolution:upfrontTier,ratioCategory:category,quality,outputCount,referenceImageCount,
    formula:"("+perImage+" credits/image + "+referenceImageCount+" reference-image credits/output) × "+outputCount+" outputs",
    autoResolutionReserve:ratio==="auto",
    evidenceType:"published_price_estimate",billable:false,settlementEligible:false
  });
}
