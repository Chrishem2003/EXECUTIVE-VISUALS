const SHA256=/^[a-f0-9]{64}$/i;

function fail(code,message,status=409){
  const error=new Error(message);
  error.code=code;
  error.status=status;
  return error;
}

/**
 * Capture the immutable content fingerprint at review creation.
 * A caller may supply the fingerprint they saw to reject stale review forms.
 */
export function captureReviewAssetVersion(asset,requestedSha256){
  if(!asset||typeof asset!=="object"||Array.isArray(asset))throw fail("REVIEW_ASSET_REQUIRED","A review asset record is required.",400);
  const current=String(asset.sha256||"").toLowerCase();
  if(!SHA256.test(current))throw fail("REVIEW_ASSET_VERSION_UNAVAILABLE","The review asset has no valid SHA-256 fingerprint.");
  if(requestedSha256!==undefined&&requestedSha256!==null){
    if(typeof requestedSha256!=="string"||!SHA256.test(requestedSha256))throw fail("REVIEW_ASSET_VERSION_INVALID","The supplied asset fingerprint is invalid.",400);
    if(requestedSha256.toLowerCase()!==current)throw fail("REVIEW_ASSET_VERSION_STALE","The asset changed after this review was opened. Refresh the asset before commenting or approving.",409);
  }
  return current;
}

/** Compare a review's immutable content binding with the currently accessible asset. */
export function reviewAssetVersionStatus(snapshotSha256,currentSha256){
  if(typeof snapshotSha256!=="string"||!SHA256.test(snapshotSha256))return "unbound";
  if(typeof currentSha256!=="string"||!SHA256.test(currentSha256))return "unavailable";
  return snapshotSha256.toLowerCase()===currentSha256.toLowerCase()?"current":"changed";
}
