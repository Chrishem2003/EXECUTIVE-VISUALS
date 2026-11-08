import test from "node:test";
import assert from "node:assert/strict";
import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { createC2paTransformationSigner } from "../c2pa-signing.mjs";


async function createTestSigningIdentity(dir) {
  const rootKey = join(dir, "ephemeral-test-root-key.pem");
  const rootCert = join(dir, "ephemeral-test-root-cert.pem");
  const signerKey = join(dir, "ephemeral-test-signer-key.pem");
  const signerCsr = join(dir, "ephemeral-test-signer.csr");
  const signerCert = join(dir, "ephemeral-test-signer-cert.pem");
  const certificateChainPath = join(dir, "ephemeral-test-chain.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-keyout", rootKey, "-out", rootCert, "-days", "1",
    "-subj", "/CN=Executive Visuals Ephemeral Test Root",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign"
  ], { stdio: "ignore" });
  execFileSync("openssl", [
    "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-keyout", signerKey, "-out", signerCsr,
    "-subj", "/CN=Executive Visuals Ephemeral Test Signer"
  ], { stdio: "ignore" });
  execFileSync("openssl", [
    "x509", "-req", "-in", signerCsr, "-CA", rootCert, "-CAkey", rootKey,
    "-CAcreateserial", "-out", signerCert, "-days", "1", "-sha256",
    "-extfile", "/dev/stdin"
  ], { input: "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n", stdio: ["pipe", "ignore", "ignore"] });
  await writeFile(certificateChainPath, Buffer.concat([await readFile(signerCert), await readFile(rootCert)]));
  return { certificateChain: await readFile(certificateChainPath), privateKey: await readFile(signerKey) };
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function onePixelPng(red = 255, green = 0, blue = 0) {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([signature, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(Buffer.from([0, red, green, blue, 255]))), pngChunk("IEND", Buffer.alloc(0))]);
}

test("protected signer is disabled by default", async () => {
  const sign = createC2paTransformationSigner({ enabled: false });
  await assert.rejects(() => sign({}), error => error.code === "C2PA_SIGNING_DISABLED");
});

test("production signing requires a timestamp authority unless explicitly waived", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ev-c2pa-sign-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { certificateChain } = await createTestSigningIdentity(dir);
  const sign = createC2paTransformationSigner({
    enabled: true, mediaRoot: dir, certificateChain, keyRef: "kms-test-key",
    signingProvider: { sign: async () => Buffer.alloc(64) }
  });
  await assert.rejects(() => sign({}), error => error.code === "C2PA_TIMESTAMP_AUTHORITY_REQUIRED");
});

test("CallbackSigner signs transformed bytes and preserves original source ingredient lineage", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ev-c2pa-callback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { certificateChain, privateKey } = await createTestSigningIdentity(dir);
  const sourcePath = join(dir, "source.png");
  const firstInput = join(dir, "first-transformed.png");
  const firstOutput = join(dir, "first-edit.png");
  const secondInput = join(dir, "second-transformed.png");
  const secondOutput = join(dir, "second-edit.png");
  await writeFile(sourcePath, onePixelPng(255, 0, 0));
  await writeFile(firstInput, onePixelPng(0, 255, 0));
  await writeFile(secondInput, onePixelPng(0, 0, 255));

  let calls = 0;
  const signingProvider = {
    async sign({ keyRef, algorithm, payload }) {
      calls++;
      assert.equal(keyRef, "test-kms-key-reference");
      assert.equal(algorithm, "es256");
      assert.ok(Buffer.isBuffer(payload));
      const signer = createSign("SHA256");
      signer.update(payload);
      signer.end();
      return signer.sign(privateKey);
    }
  };
  const sign = createC2paTransformationSigner({
    enabled: true,
    mediaRoot: dir,
    certificateChain,
    keyRef: "test-kms-key-reference",
    signingProvider,
    requireTimestamp: false,
    sdkLoader: () => import("@contentauth/c2pa-node")
  });

  const first = await sign({
    inputPath: firstInput, sourcePath, outputPath: firstOutput,
    mimeType: "image/png", sourceMimeType: "image/png",
    actionDescription: "First timeline edit",
    sourceAssetId: "asset-source"
  });
  assert.equal(first.status, "signed_and_verified");
  assert.equal(first.sourceManifestPreserved, false);
  assert.equal(first.sourceAndInputDiffer, true);
  assert.equal(first.ingredientCount, 1, "the original source, not the transformed pixels, must be recorded as the parent ingredient");
  const { Reader, Context } = await import("@contentauth/c2pa-node");
  const firstReader = await Reader.fromAsset({ path: firstOutput, mimeType: "image/png" }, new Context({ verify: { verifyAfterReading: true, verifyTrust: false } }));
  const firstParent = firstReader.getActive().ingredients.find(ingredient => ingredient.relationship === "parentOf");
  const sourceDigest = (await import("node:crypto")).createHash("sha256").update(await readFile(sourcePath)).digest("hex");
  assert.equal(firstParent.instance_id, "urn:sha256:" + sourceDigest, "the signed manifest must identify the exact original source bytes");
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await stat(firstOutput)).isFile(), true);

  const second = await sign({
    inputPath: secondInput, sourcePath: firstOutput, outputPath: secondOutput,
    mimeType: "image/png", sourceMimeType: "image/png",
    actionDescription: "Second timeline edit",
    sourceAssetId: "asset-first-edit"
  });
  assert.equal(second.status, "signed_and_verified");
  assert.equal(second.sourceManifestPreserved, true);
  assert.equal(second.sourceAndInputDiffer, true);
  assert.ok(second.ingredientCount >= 1, "new manifest must retain the previous signed asset as an ingredient");
  const secondReader = await Reader.fromAsset({ path: secondOutput, mimeType: "image/png" }, new Context({ verify: { verifyAfterReading: true, verifyTrust: false } }));
  const secondParent = secondReader.getActive().ingredients.find(ingredient => ingredient.relationship === "parentOf");
  assert.equal(secondParent.active_manifest, firstReader.getActive().label, "the next edit must retain the prior signed manifest as its parent");
  assert.equal(second.sourceManifestState, first.validationState);
  assert.equal((await stat(secondOutput)).isFile(), true);
  assert.ok(calls >= 2, "the KMS/HSM callback must be invoked for each derivative");
});

test("signer rejects output overwrite and paths outside its media root", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ev-c2pa-path-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { certificateChain } = await createTestSigningIdentity(dir);
  const source = join(dir, "source.png"), output = join(dir, "existing.png");
  await writeFile(source, onePixelPng());
  await writeFile(output, onePixelPng());
  const sign = createC2paTransformationSigner({
    enabled: true, mediaRoot: dir, certificateChain, keyRef: "test",
    signingProvider: { sign: async () => Buffer.alloc(64) }, requireTimestamp: false
  });
  await assert.rejects(() => sign({ inputPath: source, outputPath: output, mimeType: "image/png", actionDescription: "Edit" }), error => error.code === "C2PA_OUTPUT_ALREADY_EXISTS");
  await assert.rejects(() => sign({ inputPath: source, outputPath: join(tmpdir(), "outside.png"), mimeType: "image/png", actionDescription: "Edit" }), error => error.code === "C2PA_ASSET_PATH_OUTSIDE_MEDIA_ROOT");
});

test("cancellation during protected signing aborts publication and removes the partial output", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ev-c2pa-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { certificateChain, privateKey } = await createTestSigningIdentity(dir);
  const sourcePath = join(dir, "source.png"), inputPath = join(dir, "transformed.png"), outputPath = join(dir, "cancelled.png");
  await writeFile(sourcePath, onePixelPng());
  await writeFile(inputPath, onePixelPng(0, 255, 0));
  const controller = new AbortController();
  const sign = createC2paTransformationSigner({
    enabled: true, mediaRoot: dir, certificateChain, keyRef: "test-cancel-key",
    requireTimestamp: false,
    signingProvider: {
      async sign({ payload, signal }) {
        assert.equal(signal, controller.signal);
        const signer = createSign("SHA256");
        signer.update(payload);
        signer.end();
        controller.abort();
        return signer.sign(privateKey);
      }
    },
    sdkLoader: () => import("@contentauth/c2pa-node")
  });
  await assert.rejects(() => sign({
    inputPath, sourcePath, outputPath, mimeType: "image/png", sourceMimeType: "image/png",
    actionDescription: "Cancelled edit", signal: controller.signal
  }), error => error.code === "JOB_CANCELLED");
  await assert.rejects(() => stat(outputPath));
});
