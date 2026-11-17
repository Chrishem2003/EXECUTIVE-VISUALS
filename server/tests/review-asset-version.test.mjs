import test from "node:test";
import assert from "node:assert/strict";
import {captureReviewAssetVersion,reviewAssetVersionStatus} from "../review-asset-version.mjs";

const hash="a".repeat(64);
const other="b".repeat(64);

test("captures the immutable asset checksum for a review",()=>{
  assert.equal(captureReviewAssetVersion({id:"asset-1",sha256:hash.toUpperCase()}),hash);
});

test("accepts a client fingerprint only when it matches the current asset",()=>{
  assert.equal(captureReviewAssetVersion({sha256:hash},hash),hash);
});

test("rejects stale review forms before creating a comment or approval",()=>{
  assert.throws(()=>captureReviewAssetVersion({sha256:other},hash),error=>error.code==="REVIEW_ASSET_VERSION_STALE"&&error.status===409);
});

test("rejects malformed stored and supplied fingerprints",()=>{
  assert.throws(()=>captureReviewAssetVersion({sha256:"not-a-hash"}),error=>error.code==="REVIEW_ASSET_VERSION_UNAVAILABLE");
  assert.throws(()=>captureReviewAssetVersion({sha256:hash},"not-a-hash"),error=>error.code==="REVIEW_ASSET_VERSION_INVALID"&&error.status===400);
});

test("reports legacy unbound reviews without inventing a version",()=>{
  assert.equal(reviewAssetVersionStatus(null,hash),"unbound");
});

test("reports a deleted or unavailable asset distinctly",()=>{
  assert.equal(reviewAssetVersionStatus(hash,null),"unavailable");
});

test("detects content replacement while preserving the original review fingerprint",()=>{
  assert.equal(reviewAssetVersionStatus(hash,other),"changed");
  assert.equal(reviewAssetVersionStatus(hash,hash.toUpperCase()),"current");
});
