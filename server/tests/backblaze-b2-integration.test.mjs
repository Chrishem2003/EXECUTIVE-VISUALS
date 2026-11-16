import test from "node:test";
import assert from "node:assert/strict";
import { createCloudAssetService } from "../cloud-asset-service.mjs";
import { createRunwaySourceAssetResolver } from "../runway-source-asset-resolver.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const REGION = "us-west-004";
const BUCKET = "executive-visuals-media";
const HOST = "https://s3." + REGION + ".backblazeb2.com";
const bytes = Buffer.from("private-b2-source-video");
const b2 = { region: REGION, accessKeyId: "0123456789abcdef", secretAccessKey: "s".repeat(40), bucket: BUCKET };

test("cloud asset service selects B2 only when explicitly configured", async () => {
  const service = createCloudAssetService({
    url: "https://db.example.supabase.co", serviceRoleKey: "server-only-test-value",
    storageProvider: "b2", b2,
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return "[]"; } }),
    storageFetchImpl: async (url, options) => {
      assert.equal(url, HOST + "/" + BUCKET);
      assert.equal(options.method, "HEAD");
      return { ok: true, status: 200 };
    },
    authorize: async () => true
  });
  assert.equal(service.storage.bucket, BUCKET);
  assert.equal(service.storage.endpoint, HOST);
  assert.deepEqual(await service.storage.checkReadiness(), {
    ready: true, storage: "private", provider: "backblaze-b2", bucket: BUCKET
  });
  assert.equal(typeof service.assets.createSignedUrl, "function");
});

test("Runway source resolver accepts only the configured private B2 region and bucket", async () => {
  const asset = {
    id: ASSET, ownerId: OWNER, projectId: PROJECT, name: "source.mp4",
    mediaType: "video/mp4", size: bytes.length, storageBucket: BUCKET,
    objectPath: PROJECT + "/" + ASSET + "/original.mp4"
  };
  const signedUrl = HOST + "/" + BUCKET + "/" + asset.objectPath + "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=private";
  const resolver = createRunwaySourceAssetResolver({
    assets: {
      async get({ ownerId, assetId }) { assert.equal(ownerId, OWNER); assert.equal(assetId, ASSET); return asset; },
      async createSignedUrl({ ownerId, assetId, expiresIn }) {
        assert.equal(ownerId, OWNER); assert.equal(assetId, ASSET); assert.equal(expiresIn, 300);
        return { asset, url: signedUrl };
      }
    },
    storageProvider: "b2", b2Region: REGION, b2Bucket: BUCKET,
    fetchImpl: async url => {
      assert.equal(new URL(url).origin, HOST);
      return new Response(bytes, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(bytes.length) } });
    },
    execFileImpl: (_path, _args, _options, callback) => callback(null, JSON.stringify({
      format: { duration: "1.5" },
      streams: [{ codec_type: "video", width: 1920, height: 1080, nb_read_frames: "45", avg_frame_rate: "30/1", r_frame_rate: "30/1" }]
    }))
  });
  const result = await resolver.prepare(
    { operation: "video-to-video", projectId: PROJECT, sourceVideoAssetId: ASSET },
    { job: { owner_id: OWNER } }
  );
  assert.deepEqual(result.sourceVideo.buffer, bytes);
});

test("Runway B2 resolver rejects signed URLs from another bucket or host before fetching", async () => {
  let fetched = false;
  const asset = {
    id: ASSET, ownerId: OWNER, projectId: PROJECT, name: "source.mp4",
    mediaType: "video/mp4", size: bytes.length, storageBucket: BUCKET,
    objectPath: PROJECT + "/" + ASSET + "/original.mp4"
  };
  const resolver = createRunwaySourceAssetResolver({
    assets: {
      async get() { return asset; },
      async createSignedUrl() { return { asset, url: "https://attacker.example/" + BUCKET + "/" + asset.objectPath }; }
    },
    storageProvider: "b2", b2Region: REGION, b2Bucket: BUCKET,
    fetchImpl: async () => { fetched = true; return new Response(bytes); }
  });
  await assert.rejects(
    () => resolver.prepare({ operation: "video-to-video", projectId: PROJECT, sourceVideoAssetId: ASSET }, { job: { owner_id: OWNER } }),
    error => error.code === "VIDEO_INPUT_ASSET_RESOLUTION_FAILED"
  );
  assert.equal(fetched, false);
});
