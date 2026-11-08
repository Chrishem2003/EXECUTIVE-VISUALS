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
        assert.equal(context.settings.trust.verifyTrustList, true);
        return store === null ? null : { json: () => store, isEmbedded: () => embedded };
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
      validation_status: [{ code: "claimHash.mismatch", explanation: "Claim hash mismatch", success: false }]
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

test("handles the official SDK null return for assets without a manifest", async () => {
  const result = await inspectC2paAsset({
    path: "/private/media/plain.jpg",
    mimeType: "image/jpeg",
    sdkLoader: async () => sdkFor(null, false)
  });
  assert.equal(result.status, "not_found");
  assert.equal(result.configured, true);
  assert.equal(result.validationState, null);
});

test("does not infer Invalid from validation finding text when SDK state is absent", async () => {
  const result = await inspectC2paAsset({
    path: "/private/media/asset.jpg",
    mimeType: "image/jpeg",
    sdkLoader: async () => sdkFor({
      active_manifest: "urn:manifest:1",
      manifests: { "urn:manifest:1": active },
      validation_status: [{ code: "claimHash.mismatch", explanation: "Claim hash mismatch" }]
    })
  });
  assert.equal(result.status, "indeterminate");
  assert.equal(result.validationState, null);
});

test("preserves an explicit Invalid state even when the active manifest is unavailable", async () => {
  const result = await inspectC2paAsset({
    path: "/private/media/broken.jpg",
    mimeType: "image/jpeg",
    sdkLoader: async () => sdkFor({ validation_state: "Invalid", manifests: {}, validation_status: [] })
  });
  assert.equal(result.status, "invalid");
  assert.equal(result.validationState, "Invalid");
});
