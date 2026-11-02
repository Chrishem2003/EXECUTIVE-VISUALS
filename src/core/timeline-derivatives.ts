import type { EditorialTimeline } from "./timeline";

export interface DerivativeAsset {
  id:string;
  derivativeOf?:string|null;
  sha256?:string;
  mediaType?:string;
  metadata?:Record<string,unknown>;
}
export interface DerivativeEligibility {
  eligible:boolean;
  reason:string;
}

/** A derivative is selectable only when its parent and independently verified processing evidence agree. */
export function assessDerivativeEligibility(asset:DerivativeAsset, sourceAssetId:string):DerivativeEligibility {
  if(!asset.id||asset.derivativeOf!==sourceAssetId)return {eligible:false,reason:"Derivative does not identify this clip's current source as its parent."};
  const source=asset.metadata?.sourceAsset as {mediaType?:string}|undefined;
  if(source?.mediaType&&asset.mediaType&&source.mediaType.split("/")[0]!==asset.mediaType.split("/")[0])return {eligible:false,reason:"Derivative media family does not match its source."};
  const processing=asset.metadata?.processing;
  if(!processing||typeof processing!=="object"||Array.isArray(processing))return {eligible:false,reason:"Processing provenance is missing."};
  const evidence=processing as Record<string,unknown>;
  const sourceHash=asset.metadata?.sourceSha256;
  const outputHash=evidence.outputSha256;
  if(evidence.sourceAssetId!==sourceAssetId)return {eligible:false,reason:"Processing source asset does not match the derivative parent."};
  if(typeof sourceHash!=="string"||!/^[a-f0-9]{64}$/i.test(sourceHash)||evidence.inputSha256!==sourceHash)return {eligible:false,reason:"Source checksum evidence is missing or inconsistent."};
  if(typeof asset.sha256!=="string"||!/^[a-f0-9]{64}$/i.test(asset.sha256)||outputHash!==asset.sha256)return {eligible:false,reason:"Output checksum does not match the persisted asset checksum."};
  if(evidence.dimensionsVerified!==true)return {eligible:false,reason:"Output dimensions have not been verified."};
  if(evidence.decoderVerified!==true)return {eligible:false,reason:"Output decoder verification has not passed."};
  if(evidence.qualityReview!=="reviewed_pass")return {eligible:false,reason:evidence.qualityReview==="reviewed_fail"?"Derivative was rejected during quality review.":"Independent quality review is still pending."};
  return {eligible:true,reason:"Parent, checksums, dimensions, decoder and independent quality review are verified."};
}

/** Swap only the media reference. Editorial timing, creative intent and clip identity remain unchanged. */
export function replaceTimelineClipAsset(timeline:EditorialTimeline,trackId:string,clipId:string,replacementAssetId:string):EditorialTimeline {
  const track=timeline.tracks.find(item=>item.id===trackId);
  if(!track)throw new Error("Track not found.");
  if(track.locked)throw new Error("Track is locked.");
  const clip=track.clips.find(item=>item.id===clipId);
  if(!clip)throw new Error("Clip not found.");
  if(!replacementAssetId)throw new Error("Replacement asset is required.");
  if(replacementAssetId===clip.assetId)return timeline;
  const updated={...timeline,revision:timeline.revision+1,updatedAt:new Date().toISOString(),tracks:timeline.tracks.map(item=>item.id===trackId?{...item,clips:item.clips.map(candidate=>candidate.id===clipId?{...candidate,assetId:replacementAssetId}:candidate)}:item)};
  return updated;
}
