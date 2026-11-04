const fail=(message,code)=>Object.assign(new Error(message),{code});
const ROUTER_SLUG=/^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_ID=/^[a-z][a-zA-Z0-9._-]{0,95}$/;
const RESOLUTIONS=new Set(["720p","1080p"]);
const RATIOS=new Set(["16:9","9:16","1:1","4:3","3:4","21:9"]);
const RUNWAY_ASSET_URI=/^runway:\/\/[A-Za-z0-9._~:/-]{1,4980}$/;

function positiveInteger(value,label,{allowZero=false}={}) {
  if(!Number.isSafeInteger(value)||(allowZero?value<0:value<1)) {
    throw fail(label+" must be a "+(allowZero?"non-negative":"positive")+" safe integer.","RUNWAY_ROUTER_INVALID_INPUT");
  }
  return value;
}

/**
 * Build a local, versioned router policy. This is not the Runway REST
 * configuration payload and never creates or mutates a remote router.
 */
export function buildRunwayVideoRouterConfig({
  slug,name,modelIds,maxCreditsPerGeneration,optimizeFor="cost"
}={}) {
  if(typeof slug!=="string"||!ROUTER_SLUG.test(slug)) throw fail("Router slug must be a lowercase URL-safe identifier.","RUNWAY_ROUTER_INVALID_INPUT");
  if(typeof name!=="string"||!name.trim()||name.trim().length>255) throw fail("Router name must contain 1 to 255 characters.","RUNWAY_ROUTER_INVALID_INPUT");
  if(!Array.isArray(modelIds)||modelIds.length<1||modelIds.length>60||
     modelIds.some(id=>typeof id!=="string"||!MODEL_ID.test(id))||new Set(modelIds).size!==modelIds.length) {
    throw fail("Router modelIds must be a non-empty unique list of valid model IDs.","RUNWAY_ROUTER_INVALID_INPUT");
  }
  positiveInteger(maxCreditsPerGeneration,"maxCreditsPerGeneration");
  if(!["cost","latency","quality"].includes(optimizeFor)) throw fail("Router optimizeFor must be cost, latency, or quality.","RUNWAY_ROUTER_INVALID_INPUT");
  return Object.freeze({
    slug,name:name.trim(),
    settings:Object.freeze({
      schemaVersion:1,
      models:Object.freeze({mode:"allowlist_only",ids:Object.freeze([...modelIds])}),
      maxCreditsPerGeneration:Object.freeze({video:maxCreditsPerGeneration}),
      optimizeFor,
      fallback:Object.freeze({onCapacity:false})
    })
  });
}

/**
 * Build a no-charge video routing preview. Reference media must already have
 * been resolved and uploaded server-side; browser-supplied HTTPS URLs and data
 * URIs are intentionally rejected by this private-asset boundary.
 */
export function buildRunwayVideoRouterDryRun({configId,input}={}) {
  if(typeof configId!=="string"||!ROUTER_SLUG.test(configId)) throw fail("Router configId must be a lowercase URL-safe identifier.","RUNWAY_ROUTER_INVALID_INPUT");
  if(!input||typeof input!=="object"||Array.isArray(input)) throw fail("Router input must be an object.","RUNWAY_ROUTER_INVALID_INPUT");
  const promptText=typeof input.promptText==="string"?input.promptText.trim():"";
  if(!promptText||promptText.length>26000) throw fail("Router promptText must contain 1 to 26000 characters.","RUNWAY_ROUTER_INVALID_INPUT");
  const normalized={promptText};
  if(input.negativePrompt!==undefined) {
    if(typeof input.negativePrompt!=="string"||input.negativePrompt.length>1000) throw fail("Router negativePrompt cannot exceed 1000 characters.","RUNWAY_ROUTER_INVALID_INPUT");
    normalized.negativePrompt=input.negativePrompt;
  }
  if(input.aspectRatio!==undefined) {
    if(!RATIOS.has(input.aspectRatio)) throw fail("Router aspectRatio is unsupported.","RUNWAY_ROUTER_INVALID_INPUT");
    normalized.aspectRatio=input.aspectRatio;
  }
  if(input.resolution!==undefined) {
    if(!RESOLUTIONS.has(input.resolution)) throw fail("Router resolution must be 720p or 1080p.","RUNWAY_ROUTER_INVALID_INPUT");
    normalized.resolution=input.resolution;
  }
  if(input.duration!==undefined) {
    if(!Number.isInteger(input.duration)||input.duration<2||input.duration>30) throw fail("Router duration must be a whole number from 2 to 30 seconds.","RUNWAY_ROUTER_INVALID_INPUT");
    normalized.duration=input.duration;
  }
  if(input.audio!==undefined) {
    if(typeof input.audio!=="boolean") throw fail("Router audio must be a boolean.","RUNWAY_ROUTER_INVALID_INPUT");
    normalized.audio=input.audio;
  }
  if(input.referenceImages!==undefined) {
    if(!Array.isArray(input.referenceImages)||input.referenceImages.length<1||input.referenceImages.length>4) {
      throw fail("Router referenceImages must contain between 1 and 4 server-uploaded images.","RUNWAY_ROUTER_INVALID_INPUT");
    }
    normalized.referenceImages=input.referenceImages.map((reference,index)=>{
      if(!reference||typeof reference!=="object"||Array.isArray(reference)||
         typeof reference.uri!=="string"||!RUNWAY_ASSET_URI.test(reference.uri)) {
        throw fail("Router reference image "+index+" must use a server-resolved Runway upload URI.","RUNWAY_ROUTER_INVALID_INPUT");
      }
      const item={uri:reference.uri};
      if(reference.role!==undefined) {
        if(reference.role!=="first") throw fail("Only the documented first-frame reference role is supported by this contract.","RUNWAY_ROUTER_INVALID_INPUT");
        item.role="first";
      }
      if(reference.view!==undefined) {
        if(!["front","side","back"].includes(reference.view)) throw fail("Router reference image view is unsupported.","RUNWAY_ROUTER_INVALID_INPUT");
        item.view=reference.view;
      }
      const unknown=Object.keys(reference).filter(key=>!["uri","role","view"].includes(key));
      if(unknown.length) throw fail("Unsupported reference image fields: "+unknown.join(", "),"RUNWAY_ROUTER_INVALID_INPUT");
      return Object.freeze(item);
    });
  }
  const allowed=new Set(["promptText","negativePrompt","aspectRatio","resolution","duration","audio","referenceImages"]);
  const unknown=Object.keys(input).filter(key=>!allowed.has(key));
  if(unknown.length) throw fail("Unsupported router input fields: "+unknown.join(", "),"RUNWAY_ROUTER_INVALID_INPUT");
  if(input.referenceImages!==undefined) Object.freeze(normalized.referenceImages);
  return Object.freeze({configId,dryRun:true,input:Object.freeze(normalized)});
}

/**
 * Validate the documented dry-run routing metadata. The returned credits are
 * estimates only; this object must never be used as a settlement receipt.
 */
export function readRunwayVideoRouterDryRun(payload,{configId,maxApprovedCredits}={}) {
  positiveInteger(maxApprovedCredits,"maxApprovedCredits");
  if(!payload||typeof payload!=="object"||Array.isArray(payload)||!payload.routing||typeof payload.routing!=="object") {
    throw fail("Runway router returned an invalid dry-run response.","RUNWAY_ROUTER_INVALID_RESPONSE");
  }
  const routing=payload.routing;
  const credits=routing.estimatedCost?.credits;
  if(typeof routing.model!=="string"||!routing.model||routing.configId!==configId||
     !Number.isFinite(credits)||credits<0||!routing.resolvedSettings||
     typeof routing.resolvedSettings.optimizeFor!=="string") {
    throw fail("Runway router dry-run metadata is incomplete or inconsistent.","RUNWAY_ROUTER_INVALID_RESPONSE");
  }
  if(credits>maxApprovedCredits) throw fail("Runway router estimate exceeds the approved credit ceiling.","RUNWAY_ROUTER_BUDGET_EXCEEDED");
  return Object.freeze({
    configId:routing.configId,model:routing.model,
    ...(typeof routing.provider==="string"?{provider:routing.provider}:{}),
    optimizeFor:routing.resolvedSettings.optimizeFor,
    estimatedCredits:credits,evidenceType:"preflight_estimate",
    billable:false,settlementEligible:false
  });
}
