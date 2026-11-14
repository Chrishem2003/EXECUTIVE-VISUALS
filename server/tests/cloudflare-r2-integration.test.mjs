import test from "node:test";
import assert from "node:assert/strict";
import { createCloudAssetService } from "../cloud-asset-service.mjs";
import { createCloudTimelineService } from "../cloud-timeline-service.mjs";
import { createRunwaySourceAssetResolver } from "../runway-source-asset-resolver.mjs";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const bytes = Buffer.from("private-r2-source-video");
const signedUrl = "https://" + ACCOUNT + ".r2.cloudflarestorage.com/executive-visuals-media/" +
  PROJECT + "/" + ASSET + "/original.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=private";
const r2 = {
  accountId: ACCOUNT,
  accessKeyId: "0123456789abcdef",
  secretAccessKey: "s".repeat(40),
  bucket: "executive-visuals-media"
};

test("cloud asset service selects R2 only when explicitly configured", () => {
  const service = createCloudAssetService({
    url: "https://db.example.supabase.co",
    serviceRoleKey: "server-only-test-value",
    storageProvider: "r2",
    r2,
    fetchImpl: async () => { throw new Error("metadata fetch should not run during composition"); }
  });
  assert.equal(service.storage.bucket, "executive-visuals-media");
  assert.equal(service.storage.endpoint, "https://" + ACCOUNT + ".r2.cloudflarestorage.com");
  assert.equal(typeof service.storage.uploadFile, "function");
  assert.equal(typeof service.assets.createSignedUrl, "function");
});

test("cloud timeline service exposes the same private storage adapter as its asset repository", () => {
  const assetService = {
    assets: { get: async () => null, createSignedUrl: async () => null },
    storage: { checkReadiness: async () => ({ ready: true, provider: "cloudflare-r2" }) }
  };
  const service = createCloudTimelineService({
    url: "https://db.example.supabase.co",
    serviceRoleKey: "server-only-test-value",
    assetService,
    authorize: async () => true,
    fetchImpl: async () => { throw new Error("database fetch should not run during composition"); }
  });
  assert.equal(service.assets, assetService.assets);
  assert.equal(service.storage, assetService.storage);
});

test("Runway resolver accepts only the configured private R2 endpoint and bucket path", async () => {
  const asset = {
    id: ASSET, ownerId: OWNER, projectId: PROJECT, name: "source.mp4",
    mediaType: "video/mp4", size: bytes.length, storageBucket: "executive-visuals-media",
    objectPath: PROJECT + "/" + ASSET + "/original.mp4"
  };
  const resolver = createRunwaySourceAssetResolver({
    assets: {
      async get({ ownerId, assetId }) { assert.equal(ownerId, OWNER); assert.equal(assetId, ASSET); return asset; },
      async createSignedUrl() { return { asset, url: signedUrl }; }
    },
    storageProvider: "r2", r2AccountId: ACCOUNT, r2Bucket: "executive-visuals-media",
    fetchImpl: async url => {
      assert.equal(new URL(url).origin, "https://" + ACCOUNT + ".r2.cloudflarestorage.com");
      return new Response(bytes, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(bytes.length) } });
    }
  });
  const prepared = await resolver.prepare({ operation: "video-to-video", projectId: PROJECT, sourceVideoAssetId: ASSET }, { job: { owner_id: OWNER } });
  assert.deepEqual(prepared.sourceVideo.buffer, bytes);
});

test("Runway resolver rejects a different R2 bucket path before downloading", async () => {
  const asset = {
    id: ASSET, ownerId: OWNER, projectId: PROJECT, name: "source.mp4",
    mediaType: "video/mp4", size: bytes.length, storageBucket: "executive-visuals-media",
    objectPath: PROJECT + "/" + ASSET + "/original.mp4"
  };
  let fetched = false;
  const resolver = createRunwaySourceAssetResolver({
    assets: {
      async get() { return asset; },
      async createSignedUrl() { return { asset, url: signedUrl.replace("/executive-visuals-media/", "/other-private-bucket/") }; }
    },
    storageProvider: "r2", r2AccountId: ACCOUNT, r2Bucket: "executive-visuals-media",
    fetchImpl: async () => { fetched = true; return new Response(bytes); }
  });
  await assert.rejects(
    () => resolver.prepare({ operation: "video-to-video", projectId: PROJECT, sourceVideoAssetId: ASSET }, { job: { owner_id: OWNER } }),
    error => error.code === "VIDEO_INPUT_ASSET_RESOLUTION_FAILED"
  );
  assert.equal(fetched, false);
});
