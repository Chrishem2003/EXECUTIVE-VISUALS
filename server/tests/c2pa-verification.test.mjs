import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createC2paVerifier } from "../c2pa-verification.mjs";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ev-c2pa-"));
  const path = join(dir, "asset.jpg");
  await writeFile(path, Buffer.from("test-asset-bytes"));
  return { dir, path, size: 16, mimeType: "image/jpeg" };
}
function fakeSdk(validationState, validation_status = []) {
  let received;
  return {
    received: () => received,
    sdk: {
      Context: class { constructor(settings) { this.settings = settings; } },
      Reader: {
        async fromAsset(asset, context) {
          received = { asset, context: context.settings };
          if (validationState === null) return null;
          return {
            json: () => ({ validation_state: validationState, validation_status }),
            isEmbedded: () => true
          };
        }
      }
    }
  };
}

test("reports no manifest distinctly without claiming verification", async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const fake = fakeSdk(null);
  const verify = createC2paVerifier({ sdkLoader: async () => fake.sdk });
  const result = await verify(f);
  assert.equal(result.status, "not_available");
  assert.equal(result.manifestPresent, false);
});

test("uses the maintained SDK Reader with a file-backed asset and disables remote manifest fetch", async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const fake = fakeSdk("Valid", [{ code: "signingCredential.untrusted", success: false, explanation: "Signer not trusted" }]);
  const verify = createC2paVerifier({ sdkLoader: async () => fake.sdk });
  const result = await verify(f);
  assert.equal(result.status, "valid_untrusted");
  assert.equal(result.validationState, "Valid");
  assert.equal(result.embedded, true);
  assert.equal(fake.received().asset.path, f.path);
  assert.equal(fake.received().asset.mimeType, f.mimeType);
  assert.equal(fake.received().context.verify.remoteManifestFetch, false);
  assert.equal(result.validationFindings[0].code, "signingCredential.untrusted");
});

test("never promotes Trusted to trusted without an explicit trust-anchor policy", async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const fake = fakeSdk("Trusted");
  const verify = createC2paVerifier({ sdkLoader: async () => fake.sdk });
  const result = await verify(f);
  assert.equal(result.status, "valid_untrusted");
  assert.equal(result.trustPolicyConfigured, false);
});

test("accepts the SDK Trusted state only when a configured trust policy exists", async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const anchor = join(f.dir, "anchors.pem");
  const anchorPem = "-----BEGIN CERTIFICATE-----\\nTEST TRUST ANCHOR\\n-----END CERTIFICATE-----\\n";
  await writeFile(anchor, anchorPem);
  const fake = fakeSdk("Trusted");
  const verify = createC2paVerifier({ sdkLoader: async () => fake.sdk, trustAnchors: anchor });
  const result = await verify(f);
  assert.equal(result.status, "valid_trusted");
  assert.equal(result.trustPolicyConfigured, true);
  assert.equal(fake.received().context.verify.verifyTrust, true);
  assert.equal(fake.received().context.trust.userAnchors, anchorPem);
  assert.equal(fake.received().context.trust.verifyTrustList, true);
});

test("maps invalid cryptographic validation to invalid and preserves bounded findings", async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const statuses = Array.from({ length: 60 }, (_, i) => ({ code: "bad-" + i, success: false }));
  const fake = fakeSdk("Invalid", statuses);
  const verify = createC2paVerifier({ sdkLoader: async () => fake.sdk });
  const result = await verify(f);
  assert.equal(result.status, "invalid");
  assert.equal(result.validationFindings.length, 50);
});

test("fails closed when the SDK cannot be loaded or its validation state is unknown", async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const unavailable = createC2paVerifier({ sdkLoader: async () => { throw new Error("module missing"); } });
  assert.equal((await unavailable(f)).status, "verification_error");
  const unknown = createC2paVerifier({ sdkLoader: async () => fakeSdk("NewState").sdk });
  assert.equal((await unknown(f)).errorCode, "C2PA_VALIDATION_STATE_UNKNOWN");
});

test("rejects oversized, missing, changed-size and non-file assets before SDK loading", async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  let loads = 0;
  const verify = createC2paVerifier({ maxBytes: 20, sdkLoader: async () => { loads++; return fakeSdk("Valid").sdk; } });
  assert.equal((await verify({ ...f, size: 21 })).errorCode, "C2PA_ASSET_TOO_LARGE");
  assert.equal((await verify({ ...f, size: f.size + 1 })).errorCode, "C2PA_ASSET_SIZE_MISMATCH");
  assert.equal((await verify({ ...f, path: join(f.dir, "missing.jpg") })).errorCode, "C2PA_ASSET_UNAVAILABLE");
  assert.equal(loads, 0);
});

test("does not send unsupported media types or MIME/extension mismatches to the native parser", async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  let loads = 0;
  const verify = createC2paVerifier({ sdkLoader: async () => { loads++; return fakeSdk("Valid").sdk; } });
  const unsupported = await verify({ ...f, mimeType: "video/webm" });
  assert.equal(unsupported.status, "not_supported");
  const mismatch = await verify({ ...f, mimeType: "image/png" });
  assert.equal(mismatch.status, "not_supported");
  assert.equal(loads, 0);
});

test("fails closed when the configured parser limit is invalid", async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const verify = createC2paVerifier({ maxBytes: Number.NaN, sdkLoader: async () => fakeSdk("Valid").sdk });
  assert.equal((await verify(f)).errorCode, "C2PA_LIMIT_CONFIG_INVALID");
});
