import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiSignedUrlResolver } from "../google-gemini-signed-url-resolver.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const origin = "https://private-project.supabase.co";
const sha256 = "a".repeat(64);
const asset = {
  id: assetId, ownerId, projectId, mediaType: "video/mp4",
  size: 1024, sha256, storageBucket: "executive-visuals-media"
};
function harness({ signedUrl = origin + "/storage/v1/object/sign/executive-visuals-media/" + projectId + "/" + assetId + "/clip.mp4?token=secret",
  returnedAsset = asset, error } = {}) {
  const calls = [];
  const assets = {
    async createSignedUrl(args) {
      calls.push(args);
      if (error) throw error;
      return { asset: returnedAsset, url: signedUrl };
    }
  };
  return { calls, resolver: createGoogleGeminiSignedUrlResolver({
    url: origin, assets, expiresIn: 600, now: () => 1000000
  }) };
}

test("creates a short-lived signed URL for an authorized private video without downloading bytes", async () => {
  const h = harness();
  const result = await h.resolver.resolveAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" });
  assert.equal(result.sourceType, "signed_url");
  assert.equal(result.uri, origin + "/storage/v1/object/sign/executive-visuals-media/" + projectId + "/" + assetId + "/clip.mp4?token=secret");
  assert.equal(result.mediaType, "video/mp4");
  assert.equal(result.sizeBytes, 1024);
  assert.equal(result.expiresAt, "1970-01-01T00:26:40.000Z");
  assert.deepEqual(h.calls, [{ ownerId, assetId, expiresIn: 600 }]);
});

test("rejects project mismatch, wrong owner for personal assets, unsupported MIME and oversized assets", async () => {
  const wrongProject = harness({ returnedAsset: { ...asset, projectId: "44444444-4444-4444-8444-444444444444" } });
  await assert.rejects(() => wrongProject.resolver.resolveAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" }),
    error => error.code === "GEMINI_SIGNED_URL_ASSET_INVALID");

  const personal = harness({ returnedAsset: { ...asset, projectId: null, ownerId: "99999999-9999-4999-8999-999999999999" } });
  await assert.rejects(() => personal.resolver.resolveAsset({ assetId, ownerId, projectId: null, mediaType: "video/mp4" }),
    error => error.code === "GEMINI_SIGNED_URL_ASSET_INVALID");

  const oversized = harness({ returnedAsset: { ...asset, size: 100 * 1024 * 1024 + 1 } });
  await assert.rejects(() => oversized.resolver.resolveAsset({ assetId, ownerId, projectId, mediaType: "video/mp4" }),
    error => error.code === "GEMINI_SIGNED_URL_ASSET_INVALID");

  await assert.rejects(() => harness().resolver.resolveAsset({ assetId, ownerId, projectId, mediaType: "audio/mpeg" }),
    error => error.code === "GEMINI_SIGNED_URL_ASSET_INVALID");
});

test("rejects signed URLs from other hosts, buckets, paths, or unsafe URL components", async () => {
  const unsafe = [
    "https://attacker.example/storage/v1/object/sign/executive-visuals-media/a?token=x",
    origin + "/storage/v1/object/sign/other-bucket/a?token=x",
    origin + "/storage/v1/object/public/executive-visuals-media/a?token=x",
    origin + "/storage/v1/object/sign/executive-visuals-media/a?token=x&download=1",
    origin + "/storage/v1/object/sign/executive-visuals-media/a?token=x#fragment"
  ];
  for (const signedUrl of unsafe) {
    await assert.rejects(() => harness({ signedUrl }).resolver.resolveAsset({
      assetId, ownerId, projectId, mediaType: "video/mp4"
    }), error => error.code === "GEMINI_SIGNED_URL_RESPONSE_INVALID");
  }
});

test("fails closed when storage authorization fails and bounds URL expiry configuration", async () => {
  await assert.rejects(() => harness({ error: new Error("denied") }).resolver.resolveAsset({
    assetId, ownerId, projectId, mediaType: "video/mp4"
  }), error => error.code === "GEMINI_SIGNED_URL_ASSET_FORBIDDEN");
  assert.throws(() => createGoogleGeminiSignedUrlResolver({
    url: origin, assets: { createSignedUrl: async () => ({}) }, expiresIn: 30
  }));
  assert.throws(() => createGoogleGeminiSignedUrlResolver({
    url: origin, assets: { createSignedUrl: async () => ({}) }, maxBytes: 101 * 1024 * 1024
  }));
});
