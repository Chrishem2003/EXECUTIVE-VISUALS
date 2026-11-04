import test from "node:test";
import assert from "node:assert/strict";
import { createRunwayPrivateAssetResolver } from "../runway-private-asset-resolver.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const assetId = "323e4567-e89b-42d3-a456-426614174000";
const bytes = Buffer.alloc(512, 7);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
const asset = {
  id: assetId, ownerId, projectId, isPrivate: true,
  filename: "first-frame.png", contentType: "image/png", bytes
};
function jsonResponse(status, value) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(value) };
}

test("loads only the scoped private image, creates a Runway ephemeral upload and returns its runway URI", async () => {
  const calls = [], loaded = [];
  const resolve = createRunwayPrivateAssetResolver({
    env: { RUNWAY_API_KEY: "server-test-key" },
    loadPrivateAsset: async scope => { loaded.push(scope); return asset; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === "https://api.dev.runwayml.com/v1/uploads") {
        return jsonResponse(200, {
          uploadUrl: "https://upload.runway.example.test/signed?token=opaque",
          fields: { key: "ephemeral/first-frame.png", policy: "signed-policy" },
          runwayUri: "runway://uploads/private-frame-1"
        });
      }
      return { status: 204, ok: true, text: async () => "" };
    }
  });
  const uri = await resolve({ assetId, ownerId, projectId });
  assert.equal(uri, "runway://uploads/private-frame-1");
  assert.deepEqual(loaded, [{ assetId, ownerId, projectId }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.authorization, "Bearer server-test-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), { filename: "first-frame.png", type: "ephemeral" });
  assert.equal(calls[1].url, "https://upload.runway.example.test/signed?token=opaque");
  assert.equal(calls[1].options.headers, undefined);
  assert.equal(calls[1].options.redirect, "error");
  const form = calls[1].options.body;
  assert.equal(form.get("key"), "ephemeral/first-frame.png");
  assert.equal(form.get("policy"), "signed-policy");
  assert.equal(form.get("file").name, "first-frame.png");
  assert.equal(form.get("file").type, "image/png");
});

test("rejects cross-owner, cross-project and non-private assets before contacting Runway", async () => {
  for (const returned of [
    { ...asset, ownerId: "other-owner", projectId: null },
    { ...asset, projectId: "other-project" },
    { ...asset, isPrivate: false }
  ]) {
    let requests = 0;
    const resolve = createRunwayPrivateAssetResolver({
      env: { RUNWAY_API_KEY: "server-test-key" },
      loadPrivateAsset: async () => returned,
      fetchImpl: async () => { requests++; return jsonResponse(200, {}); }
    });
    await assert.rejects(resolve({ assetId, ownerId, projectId }), error => error.code === "RUNWAY_IMAGE_ASSET_SCOPE_INVALID");
    assert.equal(requests, 0);
  }
});

test("rejects unsupported image formats, undersized files and invalid filenames", async () => {
  const cases = [
    { ...asset, contentType: "image/gif", filename: "first-frame.gif" },
    { ...asset, bytes: Buffer.alloc(511) },
    { ...asset, filename: "../first-frame.png" },
    { ...asset, bytes: Buffer.alloc(512, 7) }
  ];
  for (const returned of cases) {
    const resolve = createRunwayPrivateAssetResolver({
      env: { RUNWAY_API_KEY: "server-test-key" },
      loadPrivateAsset: async () => returned,
      fetchImpl: async () => { throw new Error("must not upload"); }
    });
    await assert.rejects(resolve({ assetId, ownerId, projectId }));
  }
});

test("fails closed when Runway credentials are missing or upload creation fails", async () => {
  const noKey = createRunwayPrivateAssetResolver({
    env: {},
    loadPrivateAsset: async () => asset,
    fetchImpl: async () => { throw new Error("must not contact Runway"); }
  });
  await assert.rejects(noKey({ assetId, ownerId, projectId }), error => error.code === "RUNWAY_CONFIG_INVALID");

  let calls = 0;
  const failed = createRunwayPrivateAssetResolver({
    env: { RUNWAY_API_KEY: "server-test-key" },
    loadPrivateAsset: async () => asset,
    fetchImpl: async () => { calls++; return jsonResponse(503, { message: "private detail" }); }
  });
  await assert.rejects(failed({ assetId, ownerId, projectId }), error =>
    error.code === "RUNWAY_ASSET_UPLOAD_REJECTED" && !error.message.includes("private detail"));
  assert.equal(calls, 1);
});

test("allows a project-scoped private asset shared with an authorized project member", async()=>{
  const collaboratorId="423e4567-e89b-42d3-a456-426614174000";
  const sharedAsset={...asset,ownerId,projectId};
  const resolve=createRunwayPrivateAssetResolver({
    env:{RUNWAY_API_KEY:"server-test-key"},
    loadPrivateAsset:async scope=>{
      assert.deepEqual(scope,{assetId,ownerId:collaboratorId,projectId});
      return sharedAsset;
    },
    fetchImpl:async url=>{
      if(String(url)==="https://api.dev.runwayml.com/v1/uploads")return jsonResponse(200,{
        uploadUrl:"https://upload.runway.example.test/signed?token=opaque",
        fields:{key:"ephemeral/shared.png"},runwayUri:"runway://uploads/shared-project-frame"
      });
      return {status:204,ok:true,text:async()=>" "};
    }
  });
  assert.equal(await resolve({assetId,ownerId:collaboratorId,projectId}),"runway://uploads/shared-project-frame");
});

test("still rejects project assets from a different project and personal assets owned by another user",async()=>{
  for(const returned of [
    {...asset,projectId:"523e4567-e89b-42d3-a456-426614174000"},
    {...asset,projectId:null,ownerId:"423e4567-e89b-42d3-a456-426614174000"}
  ]) {
    const resolve=createRunwayPrivateAssetResolver({
      env:{RUNWAY_API_KEY:"server-test-key"},loadPrivateAsset:async()=>returned,
      fetchImpl:async()=>{throw new Error("must not upload");}
    });
    await assert.rejects(resolve({assetId,ownerId,projectId}),e=>e.code==="RUNWAY_IMAGE_ASSET_SCOPE_INVALID");
  }
});
