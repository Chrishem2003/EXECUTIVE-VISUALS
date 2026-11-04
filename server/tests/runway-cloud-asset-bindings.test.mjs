import test from "node:test";
import assert from "node:assert/strict";
import { createRunwayCloudAssetBindings } from "../runway-cloud-asset-bindings.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";

test("Runway cloud bindings derive owner from authenticated context and authorize project scope", async () => {
  const calls = [];
  const assets = {
    list: async args => { calls.push(["list", args]); return []; },
    get: async args => {
      calls.push(["get", args]);
      return { id: assetId, ownerId, projectId, mediaType: "image/png" };
    },
    createSignedUrl: async args => {
      calls.push(["sign", args]);
      return { asset: { id: assetId }, url: "https://private.example.com/signed-image" };
    }
  };
  const bindings = createRunwayCloudAssetBindings({
    assets,
    getAuthenticatedOwnerId: async () => ownerId
  });
  assert.deepEqual(await bindings.getAuthorizedAssetContext({ projectId }), { ownerId, projectId });
  const resolved = await bindings.resolvePrivateAsset({ assetId, ownerId, projectId, mediaType: "image" });
  assert.equal(resolved.uri, "https://private.example.com/signed-image");
  assert.equal(resolved.expiresIn, 600);
  assert.deepEqual(calls.map(x => x[0]), ["list", "get", "sign"]);
  assert.equal(calls[0][1].ownerId, ownerId);
  assert.equal(calls[1][1].ownerId, ownerId);
  assert.equal(calls[2][1].expiresIn, 600);
});

test("Runway cloud bindings permit same-owner personal assets but deny cross-project and wrong media", async () => {
  const assets = {
    list: async () => [],
    get: async () => ({ id: assetId, ownerId, projectId: null, mediaType: "video/mp4" }),
    createSignedUrl: async () => ({ asset: { id: assetId }, url: "https://private.example.com/video" })
  };
  const bindings = createRunwayCloudAssetBindings({
    assets, getAuthenticatedOwnerId: async () => ownerId
  });
  const personal = await bindings.resolvePrivateAsset({ assetId, ownerId, projectId, mediaType: "video" });
  assert.equal(personal.uri, "https://private.example.com/video");
  await assert.rejects(() => bindings.resolvePrivateAsset({
    assetId, ownerId, projectId, mediaType: "image"
  }));
  const crossProject = createRunwayCloudAssetBindings({
    assets: {
      ...assets,
      get: async () => ({ id: assetId, ownerId, projectId: otherProjectId, mediaType: "image/png" })
    },
    getAuthenticatedOwnerId: async () => ownerId
  });
  await assert.rejects(() => crossProject.resolvePrivateAsset({
    assetId, ownerId, projectId, mediaType: "image"
  }));
});

test("Runway cloud bindings fail closed for missing identity and malformed URL receipts", async () => {
  const assets = {
    list: async () => [],
    get: async () => ({ id: assetId, ownerId, projectId, mediaType: "image/png" }),
    createSignedUrl: async () => ({ asset: { id: assetId }, url: "http://unsafe.example.com/media" })
  };
  const noIdentity = createRunwayCloudAssetBindings({
    assets, getAuthenticatedOwnerId: async () => null
  });
  await assert.rejects(() => noIdentity.getAuthorizedAssetContext({ projectId }));
  const invalidReceipt = createRunwayCloudAssetBindings({
    assets, getAuthenticatedOwnerId: async () => ownerId
  });
  await assert.rejects(() => invalidReceipt.resolvePrivateAsset({
    assetId, ownerId, projectId, mediaType: "image"
  }));
  assert.throws(() => createRunwayCloudAssetBindings({
    assets, getAuthenticatedOwnerId: async () => ownerId, signedUrlExpiresIn: 10
  }));
});
