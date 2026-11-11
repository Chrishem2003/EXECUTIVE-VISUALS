const MAX_PRICING_RECORDS=100;
const MAX_DURATION_SECONDS=180;
const RESOLUTIONS=new Set(["provider_default","480p","720p","1080p","1440p","2160p","1k","2k","4k"]);
const ISO_CURRENCY=/^[A-Z]{3}$/;
const roundMoney=value=>Math.round((value+Number.EPSILON)*1e6)/1e6;
const finite=(value,min=0,max=1e6)=>typeof value==="number"&&Number.isFinite(value)&&value>=min&&value<=max;
function validDate(value){return typeof value==="string"&&Number.isFinite(Date.parse(value));}
function normalizePricingRecord(record){
 if(!record||typeof record!=="object"||Array.isArray(record))return null;
 const {provider,model,currency,sourceUrl,observedAt,expiresAt}=record;
 if(typeof provider!=="string"||!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider))return null;
 if(typeof model!=="string"||!model.trim()||model.length>160)return null;
 if(typeof currency!=="string"||!ISO_CURRENCY.test(currency))return null;
 if(typeof sourceUrl!=="string")return null;
 try{const url=new URL(sourceUrl);if(url.protocol!=="https:"||url.username||url.password)return null;}catch{return null;}
 if(!validDate(observedAt)||!validDate(expiresAt)||Date.parse(expiresAt)<=Date.parse(observedAt))return null;
 if(!record.ratesPerSecond||typeof record.ratesPerSecond!=="object"||Array.isArray(record.ratesPerSecond))return null;
 const ratesPerSecond={};
 for(const [resolution,rate] of Object.entries(record.ratesPerSecond)){
  if(!RESOLUTIONS.has(resolution)||!finite(rate))return null;
  ratesPerSecond[resolution]=rate;
 }
 if(!Object.keys(ratesPerSecond).length)return null;
 const optionalNumbers=["minimumCharge","audioSurchargePerSecond","referenceImageFee","billingIncrementSeconds"];
 for(const key of optionalNumbers)if(record[key]!=null&&!finite(record[key],key==="billingIncrementSeconds"?0.001:0,key==="billingIncrementSeconds"?180:1e6))return null;
 return Object.freeze({
  provider,model:model.trim(),currency,sourceUrl,observedAt,expiresAt,
  ratesPerSecond:Object.freeze(ratesPerSecond),
  minimumCharge:record.minimumCharge??0,
  audioSurchargePerSecond:record.audioSurchargePerSecond??0,
  referenceImageFee:record.referenceImageFee??0,
  billingIncrementSeconds:record.billingIncrementSeconds??1
 });
}
export function parseVideoPricingCatalog(raw){
 if(typeof raw!=="string"||!raw.trim())return Object.freeze({records:Object.freeze([]),rejectedCount:0,configured:false});
 let parsed;try{parsed=JSON.parse(raw);}catch{return Object.freeze({records:Object.freeze([]),rejectedCount:1,configured:false});}
 if(!Array.isArray(parsed)||parsed.length>MAX_PRICING_RECORDS)return Object.freeze({records:Object.freeze([]),rejectedCount:1,configured:false});
 const records=[],seen=new Set();let rejectedCount=0;
 for(const item of parsed){
  const normalized=normalizePricingRecord(item),key=normalized?normalized.provider+"\0"+normalized.model:null;
  if(!normalized||seen.has(key)){rejectedCount++;continue;}
  seen.add(key);records.push(normalized);
 }
 return Object.freeze({records:Object.freeze(records),rejectedCount,configured:records.length>0});
}
export function estimateVideoGenerationCost(request,pricingCatalog,{now=()=>new Date()}={}){
 const unavailable=(reason)=>Object.freeze({available:false,estimated:false,reason});
 if(!request||typeof request!=="object"||Array.isArray(request))return unavailable("A valid generation request is required.");
 const provider=typeof request.provider==="string"?request.provider:"";
 const model=typeof request.model==="string"?request.model:"";
 if(!provider||!model)return unavailable("Select an exact provider and model before estimating cost.");
 if(!Number.isInteger(request.durationSeconds)||!finite(request.durationSeconds,1,MAX_DURATION_SECONDS))return unavailable("Duration must be a whole number between 1 and 180 seconds.");
 const resolution=request.resolution??"provider_default";
 if(!RESOLUTIONS.has(resolution))return unavailable("The requested resolution is invalid.");
 const audioMode=request.audioMode??"provider_default";
 if(!["provider_default","generated","none","reference"].includes(audioMode))return unavailable("The requested audio mode is invalid.");
 const referenceImageCount=request.referenceImageCount??0;
 if(!Number.isInteger(referenceImageCount)||referenceImageCount<0||referenceImageCount>12)return unavailable("Reference image count must be between 0 and 12.");
 const sourceRecords=Array.isArray(pricingCatalog)?pricingCatalog:pricingCatalog?.records;
 if(!Array.isArray(sourceRecords))return unavailable("No verified pricing schedule is configured.");
 const records=sourceRecords.map(normalizePricingRecord).filter(Boolean);
 const record=records.find(item=>item.provider===provider&&item.model===model);
 if(!record)return unavailable("No pricing schedule matches this exact provider and model.");
 const current=now(),currentMs=current instanceof Date?current.getTime():Date.parse(current);
 if(!Number.isFinite(currentMs))return unavailable("The pricing clock is invalid.");
 if(!validDate(record.observedAt)||!validDate(record.expiresAt)||Date.parse(record.observedAt)>currentMs||Date.parse(record.expiresAt)<=currentMs)return unavailable("The pricing schedule is expired or not yet valid; refresh its source before quoting.");
 const rate=resolution==="provider_default"?record.ratesPerSecond?.provider_default:record.ratesPerSecond?.[resolution];
 if(!finite(rate))return unavailable("The selected resolution has no verified price.");
 const increment=record.billingIncrementSeconds??1;
 if(!finite(increment,0.001,180))return unavailable("The pricing billing increment is invalid.");
 const billableSeconds=Math.ceil(request.durationSeconds/increment)*increment;
 const video=roundMoney(rate*billableSeconds);
 const audio=audioMode==="generated"?roundMoney((record.audioSurchargePerSecond??0)*billableSeconds):0;
 const references=roundMoney((record.referenceImageFee??0)*referenceImageCount);
 const subtotal=roundMoney(video+audio+references);
 const minimum=record.minimumCharge??0;
 const total=roundMoney(Math.max(subtotal,minimum));
 return Object.freeze({
  available:true,estimated:true,provider,model,currency:record.currency,
  amount:total,billableSeconds,
  breakdown:Object.freeze({video,audio,references,minimumApplied:total>subtotal?roundMoney(total-subtotal):0}),
  pricing:Object.freeze({sourceUrl:record.sourceUrl,observedAt:record.observedAt,expiresAt:record.expiresAt}),
  disclaimer:"Estimate only. Provider taxes, account discounts, retries, moderation charges and billing changes may affect the final charge."
 });
}

export function estimateVideoProductionCost(plan,pricingCatalog,options={}){
 const unavailable=(reason)=>Object.freeze({available:false,estimated:false,reason});
 if(!plan||typeof plan!=="object"||Array.isArray(plan)||!Array.isArray(plan.shots)||plan.shots.length<1||plan.shots.length>12)
  return unavailable("A production quote requires between 1 and 12 shots.");
 const ids=new Set();let totalDuration=0;
 for(const shot of plan.shots){
  if(!shot||typeof shot!=="object"||Array.isArray(shot))return unavailable("Every shot must be an object.");
  if(typeof shot.id!=="string"||!/^[a-zA-Z0-9_-]{1,48}$/.test(shot.id)||ids.has(shot.id))return unavailable("Every shot needs a unique, valid identifier.");
  ids.add(shot.id);
  if(!Number.isInteger(shot.durationSeconds)||!finite(shot.durationSeconds,1,MAX_DURATION_SECONDS))return unavailable("Every shot duration must be a whole number between 1 and 180 seconds.");
  totalDuration+=shot.durationSeconds;
  if(totalDuration>MAX_DURATION_SECONDS)return unavailable("The combined production duration cannot exceed 180 seconds.");
 }
 const quotes=[];
 for(const shot of plan.shots){
  const quote=estimateVideoGenerationCost(shot,pricingCatalog,options);
  if(!quote.available)return Object.freeze({available:false,estimated:false,reason:quote.reason,shotId:shot.id,shotIndex:quotes.length});
  quotes.push(Object.freeze({shotId:shot.id,durationSeconds:shot.durationSeconds,provider:quote.provider,model:quote.model,currency:quote.currency,amount:quote.amount,breakdown:quote.breakdown,pricing:quote.pricing}));
 }
 const currencies=new Set(quotes.map(quote=>quote.currency));
 if(currencies.size!==1)return unavailable("A production quote cannot combine different currencies; convert currencies using an explicitly sourced exchange rate first.");
 const sum=key=>roundMoney(quotes.reduce((total,quote)=>total+quote.breakdown[key],0));
 const amount=roundMoney(quotes.reduce((total,quote)=>total+quote.amount,0));
 return Object.freeze({
  available:true,estimated:true,shotCount:quotes.length,totalDurationSeconds:totalDuration,
  currency:quotes[0].currency,amount,
  breakdown:Object.freeze({video:sum("video"),audio:sum("audio"),references:sum("references"),minimumApplied:sum("minimumApplied")}),
  shots:Object.freeze(quotes),
  disclaimer:"Production estimate only. Each shot is priced independently; provider batch discounts, taxes, account discounts, retries, moderation charges and billing changes are not included. No generation jobs were submitted."
 });
}
