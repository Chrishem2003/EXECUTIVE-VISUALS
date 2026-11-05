const MAX_IMAGE_BYTES=30*1024*1024;
const IMAGE_TYPES=new Set(["image/jpeg","image/png","image/webp","image/gif"]);
const fail=(message,code)=>Object.assign(new Error(message),{code});
const validId=value=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function safeSignedUrl(value){
 let url;try{url=new URL(value);}catch{throw fail("Private asset storage returned an invalid signed URL.","KIE_VIDEO_INPUT_ASSET_URL_INVALID");}
 if(url.protocol!=="https:"||url.username||url.password||url.port||url.hash||!url.hostname.includes(".")||url.hostname==="localhost"||url.hostname.endsWith(".local")||url.hostname.endsWith(".internal")||/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)||url.hostname.startsWith("["))throw fail("Private asset storage returned an unsafe signed URL.","KIE_VIDEO_INPUT_ASSET_URL_INVALID");
 return url.toString();
}

/**
 * Resolve only private, owner/project-authorized image assets into short-lived
 * signed URLs that Kie can fetch. Arbitrary caller-provided URLs are rejected.
 */
export function createKiePrivateAssetResolver({assets,expiresIn=3600}={}){
 if(!assets||typeof assets.createSignedUrl!=="function")throw new Error("Kie private input resolution requires the private cloud asset repository.");
 if(!Number.isInteger(expiresIn)||expiresIn<300||expiresIn>3600)throw new Error("Kie signed input URL expiry must be between 5 and 60 minutes.");
 return async function prepareKieInput(input,{job}={}){
  if(!input||typeof input!=="object"||Array.isArray(input)||input.provider!=="kie"||input.model!=="bytedance/seedance-2")throw fail("Kie private input scope is invalid.","KIE_VIDEO_INPUT_SCOPE_INVALID");
  if(!job||!validId(job.owner_id)||(job.project_id!==null&&job.project_id!==undefined&&!validId(job.project_id)))throw fail("Kie private input requires an owned cloud job.","KIE_VIDEO_INPUT_SCOPE_INVALID");
  if(input.firstFrameUrl||input.lastFrameUrl||input.referenceImageUrls||input.referenceVideoUrls||input.referenceAudioUrls)throw fail("Kie accepts only private asset IDs; direct URLs are not allowed.","KIE_VIDEO_INPUT_DIRECT_URL_REJECTED");
  if(["referenceVideoAssetIds","referenceAudioAssetIds"].some(key=>Array.isArray(input[key])&&input[key].length>0))throw fail("This Kie resolver release supports image references only.","KIE_VIDEO_CAPABILITY_UNSUPPORTED");
  const ownerId=job.owner_id,projectId=job.project_id||null;
  const referenceIds=input.referenceAssetIds===undefined?[]:input.referenceAssetIds;
  if(!Array.isArray(referenceIds)||referenceIds.length>9)throw fail("Kie accepts at most nine reference images.","KIE_VIDEO_INPUT_INVALID");
  if(new Set(referenceIds).size!==referenceIds.length||referenceIds.some(id=>!validId(id)))throw fail("Kie reference asset IDs must be unique UUIDs.","KIE_VIDEO_INPUT_INVALID");
  const firstId=input.startFrameAssetId||null,lastId=input.endFrameAssetId||null;
  if(lastId&&!firstId)throw fail("A last frame requires a first frame.","KIE_VIDEO_INPUT_INVALID");
  if((firstId||lastId)&&referenceIds.length)throw fail("First/last-frame mode cannot be combined with reference images.","KIE_VIDEO_INPUT_MODE_CONFLICT");
  for(const id of [firstId,lastId])if(id&&!validId(id))throw fail("Kie frame asset ID is invalid.","KIE_VIDEO_INPUT_INVALID");
  async function resolveImage(assetId){
   const result=await assets.createSignedUrl({ownerId,assetId,expiresIn});
   const asset=result?.asset;
   if(!asset||asset.id!==assetId||asset.ownerId!==ownerId||(asset.projectId!==null&&asset.projectId!==projectId)||!IMAGE_TYPES.has(asset.mediaType)||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>MAX_IMAGE_BYTES)throw fail("Kie image input must be a private owner/project asset of a supported type and no more than 30 MB.","KIE_VIDEO_INPUT_ASSET_INVALID");
   return safeSignedUrl(result.url);
  }
  const [firstFrameUrl,lastFrameUrl]=await Promise.all([firstId?resolveImage(firstId):null,lastId?resolveImage(lastId):null]);
  const referenceImageUrls=[];
  for(const id of referenceIds)referenceImageUrls.push(await resolveImage(id));
  return Object.freeze({...input,
   ...(firstFrameUrl?{firstFrameUrl}:{}),
   ...(lastFrameUrl?{lastFrameUrl}:{}),
   ...(referenceImageUrls.length?{referenceImageUrls}:{})
  });
 };
}
