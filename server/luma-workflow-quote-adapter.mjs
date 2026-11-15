import { estimateLumaRay32Cost } from "./luma-video-pricing.mjs";

const fail=(message,code)=>Object.assign(new Error(message),{code});
const RATE=/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/;

/**
 * Non-billable Luma quote adapter. It validates the exact Ray 3.2 request
 * contract locally and estimates published credits at the account's configured
 * USD-per-credit rate. It never uploads files or calls Luma's network API.
 */
export function createLumaWorkflowQuoteAdapter({client,usdPerCredit,now=()=>new Date()}={}){
 if(!client||typeof client.prepareInput!=="function")throw new TypeError("Luma workflow quote adapter requires a Ray 3.2 request validator.");
 const rateText=String(usdPerCredit??"").trim();
 if(!RATE.test(rateText)||Number(rateText)<=0||Number(rateText)>1000)throw fail("LUMA_USD_PER_CREDIT must be an explicit positive account/contract rate.","LUMA_BILLING_RATE_REQUIRED");
 if(typeof now!=="function")throw new TypeError("Luma quote clock must be a function.");
 async function prepareInput(input,{job}={}){
  if(!input||typeof input!=="object"||Array.isArray(input)||input.provider!=="luma"||input.model!=="ray-3.2")
   throw fail("Luma workflow quote requires the exact provider/model contract.","VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE");
  const prepared={...input,user_id:job?.owner_id};
  if(input.startFrameAssetId){
   if(typeof input.startFrameAssetId!=="string")throw fail("Luma first-frame asset ID is invalid.","VIDEO_WORKFLOW_CLOUD_ASSET_INVALID");
   prepared.startFrame={file_id:input.startFrameAssetId};
  }
  if(input.endFrameAssetId){
   if(typeof input.endFrameAssetId!=="string")throw fail("Luma last-frame asset ID is invalid.","VIDEO_WORKFLOW_CLOUD_ASSET_INVALID");
   prepared.endFrame={file_id:input.endFrameAssetId};
  }
  return client.prepareInput(prepared);
 }
 async function preflight(prepared){
  if(!prepared||prepared.model!=="ray-3.2"||prepared.type!=="video"||!prepared.video)
   throw fail("Luma quote input did not normalize to a Ray 3.2 video request.","VIDEO_WORKFLOW_QUOTE_INVALID");
  const duration=Number(String(prepared.video.duration||"").replace(/s$/,""));
  const resolution=prepared.video.resolution;
  const estimate=estimateLumaRay32Cost({operation:"video",resolution,durationSeconds:duration,pricingDate:new Date(now()).toISOString().slice(0,10)});
  const estimatedUsd=Number((estimate.credits*Number(rateText)).toFixed(6));
  if(!Number.isSafeInteger(estimate.credits)||estimate.credits<=0||!Number.isFinite(estimatedUsd)||estimatedUsd<=0)
   throw fail("Luma quote could not be converted using the configured account rate.","VIDEO_WORKFLOW_QUOTE_INVALID");
  return Object.freeze({
   provider:"luma",model:"ray-3.2",estimatedCredits:estimate.credits,estimatedUsd,
   currency:"USD",billable:false,configId:"ray-3.2",
   pricingSource:estimate.pricingSource,pricingDate:estimate.pricingDate,
   pricingFormula:estimate.pricingFormula,creditToUsdRate:rateText,
   pricingStatus:estimate.pricingStatus
  });
 }
 return Object.freeze({prepareInput,preflight});
}
