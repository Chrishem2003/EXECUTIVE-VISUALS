import test from "node:test";
import assert from "node:assert/strict";
import { createCloudRunwayPrivateAssetResolver } from "../cloud-runway-asset-resolver.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const assetId = "323e4567-e89b-42d3-a456-426614174000";
const bytes = Buffer.alloc(512, 3);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
const asset = {
  id: assetId, ownerId, projectId, name: "frame.png",
  mediaType: "image/png", size: 512, storageBucket: "executive-visuals-media"
};

test("bridges authorized private Cloud Assets through a scoped signed URL into Runway ephemeral upload", async () => {
  const calls = [], scopes = [];
  const assets = {
    async get(scope) { scopes.push(["get", scope]); return asset; },
    async createSignedUrl(scope) {
      scopes.push(["sign", scope]);
      return { asset, url: "https://supabase.example.test/storage/v1/object/sign/executive-visuals-media/project/frame.png?token=opaque" };
    }
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith("https://supabase.example.test/storage/")) {
      return new Response(bytes, { status: 200, headers: { "content-type": "image/png", "content-length": "512" } });
    }
    if (url === "https://api.dev.runwayml.com/v1/uploads") {
      return new Response(JSON.stringify({
        uploadUrl: "https://upload.runway.example.test/form?token=opaque",
        fields: { key: "ephemeral/frame.png" },
        runwayUri: "runway://uploads/frame-1"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(null, { status: 204 });
  };
  const resolve = createCloudRunwayPrivateAssetResolver({
    assets, supabaseUrl: "https://supabase.example.test",
    fetchImpl, runwayEnv: { RUNWAY_API_KEY: "runway-test-key" }
  });
  const uri = await resolve({ assetId, ownerId, projectId });
  assert.equal(uri, "runway://uploads/frame-1");
  assert.deepEqual(scopes, [
    ["get", { ownerId, assetId }],
    ["sign", { ownerId, assetId, expiresIn: 300 }]
  ]);
  assert.equal(calls[0].url.startsWith("https://supabase.example.test/storage/"), true);
  assert.equal(calls[1].url, "https://api.dev.runwayml.com/v1/uploads");
  assert.equal(calls[2].url, "https://upload.runway.example.test/form?token=opaque");
});

test("rejects cross-project assets and signed URLs outside the configured Supabase origin", async () => {
  let fetches = 0;
  const otherProject = {
    async get() { return { ...asset, projectId: "other-project" }; },
    async createSignedUrl() { throw new Error("must not sign"); }
  };
  const resolveOtherProject = createCloudRunwayPrivateAssetResolver({
    assets: otherProject, supabaseUrl: "https://supabase.example.test",
    fetchImpl: async () => { fetches++; throw new Error("must not fetch"); },
    runwayEnv: { RUNWAY_API_KEY: "key" }
  });
  await assert.rejects(resolveOtherProject({ assetId, ownerId, projectId }), error => error.code === "RUNWAY_IMAGE_ASSET_SCOPE_INVALID");

  const wrongOrigin = {
    async get() { return asset; },
    async createSignedUrl() { return { asset, url: "https://attacker.example.test/object?token=secret" }; }
  };
  const resolveWrongOrigin = createCloudRunwayPrivateAssetResolver({
    assets: wrongOrigin, supabaseUrl: "https://supabase.example.test",
    fetchImpl: async () => { fetches++; throw new Error("must not fetch"); },
    runwayEnv: { RUNWAY_API_KEY: "key" }
  });
  await assert.rejects(resolveWrongOrigin({ assetId, ownerId, projectId }), error => error.code === "RUNWAY_IMAGE_ASSET_READ_FAILED");
  assert.equal(fetches, 0);
});

test("rejects downloaded bytes whose media type or size differs from private asset metadata", async () => {
  const assets = {
    async get() { return asset; },
    async createSignedUrl() { return { asset, url: "https://supabase.example.test/signed" }; }
  };
  const mismatch = createCloudRunwayPrivateAssetResolver({
    assets, supabaseUrl: "https://supabase.example.test",
    fetchImpl: async () => new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg", "content-length": "512" } }),
    runwayEnv: { RUNWAY_API_KEY: "key" }
  });
  await assert.rejects(mismatch({ assetId, ownerId, projectId }), error => error.code === "RUNWAY_IMAGE_ASSET_TYPE_UNSUPPORTED");

  const wrongSize = createCloudRunwayPrivateAssetResolver({
    assets, supabaseUrl: "https://supabase.example.test",
    fetchImpl: async () => new Response(Buffer.alloc(513), { status: 200, headers: { "content-type": "image/png", "content-length": "513" } }),
    runwayEnv: { RUNWAY_API_KEY: "key" }
  });
  await assert.rejects(wrongSize({ assetId, ownerId, projectId }), error => error.code === "RUNWAY_IMAGE_ASSET_SIZE_INVALID" || error.code === "RUNWAY_IMAGE_ASSET_INVALID");
});
