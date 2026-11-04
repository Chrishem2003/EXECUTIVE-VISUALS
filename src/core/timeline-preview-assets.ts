export interface PreviewAssetCandidate {
  id:string;
  mediaType:string;
  size:number;
  sha256?:string;
  derivativeOf?:string|null;
  metadata?:Record<string,unknown>;
}
export interface PreviewAssetSelection {
  asset:PreviewAssetCandidate;
  mode:"proxy"|"original";
}

/** Select only a smaller, checksum-verified video proxy linked to the exact source asset. */
export function selectPreviewAsset(original:PreviewAssetCandidate,assets:PreviewAssetCandidate[]):PreviewAssetSelection {
  if(!original.mediaType.startsWith("video/")||!Number.isSafeInteger(original.size)||original.size<=0) {
    return {asset:original,mode:"original"};
  }
  const proxy=assets.filter(candidate=>
    candidate.derivativeOf===original.id&&
    candidate.metadata?.operation==="media.proxy"&&
    candidate.mediaType.startsWith("video/")&&
    Number.isSafeInteger(candidate.size)&&candidate.size>0&&candidate.size<original.size&&
    typeof candidate.sha256==="string"&&/^[a-f0-9]{64}$/i.test(candidate.sha256)
  ).sort((a,b)=>a.size-b.size||a.id.localeCompare(b.id))[0];
  return proxy?{asset:proxy,mode:"proxy"}:{asset:original,mode:"original"};
}
