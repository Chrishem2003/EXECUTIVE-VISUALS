import { createHash } from "node:crypto";

const SHA256=/^[a-f0-9]{64}$/i;
const plain=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const fail=(message,code)=>{throw Object.assign(new Error(message),{code});};
const stable=value=>Array.isArray(value)?"["+value.map(stable).join(",")+"]":plain(value)?"{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stable(value[key])).join(",")+"}":JSON.stringify(value);
const hash=value=>createHash("sha256").update(stable(value)).digest("hex");
const seconds=time=>{const value=Number(time?.value),rate=Number(time?.rate);if(!Number.isFinite(value)||!Number.isFinite(rate)||rate<=0)fail("Timeline contains an invalid time value.","RENDER_MANIFEST_INVALID_TIMELINE");return Math.max(0,Math.min(86400,value/rate));};

/**
 * Build a deterministic, revision-pinned receipt for a render input snapshot.
 * Source bytes must already have been verified by the asset materializer.
 */
export function createRenderManifest({timeline,assets,timelineRevision,output={}}={}){
 if(!plain(timeline)||!Array.isArray(timeline.tracks)||!(assets instanceof Map))fail("Render manifest requires a timeline and materialized asset map.","RENDER_MANIFEST_INVALID_INPUT");
 if(!(typeof timelineRevision==="string"&&timelineRevision.trim()&&timelineRevision.length<=160)&&!(Number.isSafeInteger(timelineRevision)&&timelineRevision>=0))fail("A valid timeline revision is required to pin a render.","RENDER_MANIFEST_REVISION_REQUIRED");
 const referenced=new Map();
 for(const track of timeline.tracks){
  if(track?.enabled===false)continue;
  for(const clip of track?.clips||[]){
   if(clip?.enabled===false)continue;
   const assetId=String(clip?.assetId||"");
   if(!assetId)fail("Every enabled render clip must reference an asset.","RENDER_MANIFEST_ASSET_REFERENCE_INVALID");
   const entry=assets.get(assetId),asset=entry?.asset;
   if(!entry||typeof entry.path!=="string"||!plain(asset))fail("A render source asset is missing or inaccessible.","SOURCE_ASSET_NOT_FOUND");
   const sha256=String(asset.sha256||asset.metadata?.sha256||"").toLowerCase();
   if(!SHA256.test(sha256))fail("Every render source must have a verified SHA-256 checksum before a revision-pinned render.","RENDER_MANIFEST_SOURCE_UNVERIFIED");
   const duration=seconds(clip.duration),start=seconds(clip.timelineStart);
   if(duration<=0)fail("Render clips must have a positive duration.","RENDER_MANIFEST_INVALID_CLIP");
   const sourceRange=clip.sourceRange?{start:seconds(clip.sourceRange.start),duration:clip.sourceRange.duration?seconds(clip.sourceRange.duration):null}:null;
   const existing=referenced.get(assetId);
   if(existing&&existing.sha256!==sha256)fail("A source asset resolved to conflicting checksums.","RENDER_MANIFEST_SOURCE_CONFLICT");
   if(!existing){
    const derivativeOf=typeof asset.derivativeOf==="string"?asset.derivativeOf:typeof asset.derivative_of==="string"?asset.derivative_of:null;
    const metadata=plain(asset.metadata)?asset.metadata:plain(asset.metadata_json)?asset.metadata_json:{};
    const processing=plain(metadata.processing)?metadata.processing:null;
    if(processing?.sourceAssetId&&derivativeOf&&processing.sourceAssetId!==derivativeOf)fail("Derivative provenance does not match the recorded parent asset.","RENDER_MANIFEST_LINEAGE_INVALID");
    const inputSha256=processing?.inputSha256||processing?.sourceSha256||null;
    if(inputSha256!==null&&!SHA256.test(String(inputSha256)))fail("Derivative provenance contains an invalid source checksum.","RENDER_MANIFEST_LINEAGE_INVALID");
    const lineage=derivativeOf?{
     parentAssetId:derivativeOf,
     operation:typeof metadata.operation==="string"?metadata.operation.slice(0,100):null,
     sourceSha256:inputSha256?String(inputSha256).toLowerCase():null,
     processingFingerprint:processing?hash(processing):null,
     engine:typeof processing?.engine==="string"?processing.engine.slice(0,100):null,
     model:typeof processing?.model==="string"?processing.model.slice(0,160):null,
     modelVersion:typeof processing?.modelVersion==="string"?processing.modelVersion.slice(0,200):null,
     qualityReview:typeof processing?.qualityReview==="string"?processing.qualityReview.slice(0,40):null,
     aiInferencePerformed:processing?.aiInferencePerformed===true||metadata.operation==="media.ai-upscale"
    }:null;
    referenced.set(assetId,{assetId,sha256,mediaType:String(asset.mediaType||asset.media_type||""),size:Number.isSafeInteger(asset.size)?asset.size:null,...(lineage?{lineage}:{})});
   }
  }
 }
 const sources=[...referenced.values()].sort((a,b)=>a.assetId.localeCompare(b.assetId));
 const snapshot={schemaVersion:1,timelineRevision:String(timelineRevision),timeline,output,sources};
 const manifestSha256=hash(snapshot);
 return Object.freeze({...snapshot,manifestSha256});
}

export function verifyRenderManifest(manifest){
 if(!plain(manifest)||manifest.schemaVersion!==1||typeof manifest.manifestSha256!=="string"||!SHA256.test(manifest.manifestSha256))return false;
 const {manifestSha256,...snapshot}=manifest;
 return hash(snapshot)===manifestSha256;
}
