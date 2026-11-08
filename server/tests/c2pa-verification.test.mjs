import test from "node:test";
import assert from "node:assert/strict";
import { inspectC2paAsset } from "../c2pa-verification.mjs";

function sdkFor(store, embedded = true) {
  return {
    Context: class Context { constructor(settings) { this.settings = settings; } },
    Reader: {
      async fromAsset(asset, context) {
        assert.equal(asset.mimeType, "image/jpeg");
        assert.equal(context.settings.verify.verifyAfterReading, true);
        assert.equal(context.settings.verify.remoteManifestFetch, false);
        return { json: () => store, isEmbedded: () => embedded };
      }
    }
  };
}

const active = { title: "camera-original.jpg", claim_generator: "fixture" };

test("reports trusted only when the CAI SDK explicitly returns Trusted", async () => {
  const result = await inspectC2paAsset({
    path: "/private/media/asset.jpg",
    mimeType: "image/jpeg",
    sdkLoader: async () => sdkFor({ active_manifest: "urn:manifest:1", manifests: { "urn:manifest:1": active }, validation_state: "Trusted", validation_status: [] })
  });
  assert.equal(result.status, "trusted");
  assert.equal(result.validationState, "Trusted");
  assert.equal(result.activeManifest, "urn:manifest:1");
});

test("keeps a cryptographically valid but untrusted manifest separate", async () => {
  const result = await inspectC2paAsset({
    path: "/private/media/asset.jpg",
    mimeType: "image/jpeg",
    sdkLoader: async () => sdkFor({ active_manifest: "urn:manifest:1", manifests: { "urn:manifest:1": active }, validation_state: "Valid", validation_status: [] })
  });
  assert.equal(result.status, "valid");
  assert.notEqual(result.status, "trusted");
});

test("reports invalid manifests and bounded validation findings", async () => {
  const result = await inspectC2paAsset({
    path: "/private/media/asset.jpg",
    mimeType: "image/jpeg",
    sdkLoader: async () => sdkFor({
      active_manifest: "urn:manifest:1",
      manifests: { "urn:manifest:1": active },
      validation_state: "Invalid",
      validation_status: [{ code: "claimHash.mismatch", explanation: "Claim hash mismatch", severity: "error" }]
    })
  });
  assert.equal(result.status, "invalid");
  assert.equal(result.findings[0].code, "claimHash.mismatch");
});

test("does not infer validity when validation state is absent", async () => {
  const result = await inspectC2paAsset({
    path: "/private/media/asset.jpg",
    mimeType: "image/jpeg",
    sdkLoader: async () => sdkFor({ active_manifest: "urn:manifest:1", manifests: { "urn:manifest:1": active } })
  });
  assert.equal(result.status, "indeterminate");
  assert.equal(result.validationState, null);
});

test("distinguishes a file without embedded C2PA", async () => {
  const result = await inspectC2paAsset({
    path: "/private/media/asset.jpg",
    mimeType: "image/jpeg",
    sdkLoader: async () => sdkFor({ manifests: {} }, false)
  });
  assert.equal(result.status, "not_found");
});

test("returns an explicit unavailable state when the optional SDK is absent", async () => {
  const result = await inspectC2paAsset({
    path: "/private/media/asset.jpg",
    mimeType: "image/jpeg",
    sdkLoader: async () => { throw Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" }); }
  });
  assert.equal(result.status, "not_available");
  assert.equal(result.configured, false);
});

test("rejects missing server asset paths and MIME types", async () => {
  await assert.rejects(() => inspectC2paAsset({ path: "", mimeType: "image/jpeg" }), /server-controlled asset path/);
  await assert.rejects(() => inspectC2paAsset({ path: "/private/media/a", mimeType: "bad" }), /MIME type/);
});
