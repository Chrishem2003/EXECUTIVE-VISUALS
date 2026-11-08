import test from "node:test";
import assert from "node:assert/strict";
import { createSign } from "node:crypto";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createC2paTransformationSigner } from "../c2pa-signing.mjs";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "c2pa");

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
function onePixelPng() {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([signature, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), pngChunk("IEND", Buffer.alloc(0))]);
}

test("protected signer is disabled by default", async () => {
  const sign = createC2paTransformationSigner();
  await assert.rejects(() => sign({}), error => error.code === "C2PA_SIGNING_DISABLED");
});

test("production signing requires a timestamp authority unless explicitly waived", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ev-c2pa-sign-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const certificateChain = await readFile(join(fixtureDir, "es256-test-only.chain.pem"));
  const sign = createC2paTransformationSigner({
    enabled: true, mediaRoot: dir, certificateChain, keyRef: "kms-test-key",
    signingProvider: { sign: async () => Buffer.alloc(64) }
  });
  await assert.rejects(() => sign({}), error => error.code === "C2PA_TIMESTAMP_AUTHORITY_REQUIRED");
});

test("CallbackSigner delegates private-key operations and preserves source ingredient lineage", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ev-c2pa-callback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const certificateChain = await readFile(join(fixtureDir, "es256-test-only.chain.pem"));
  const privateKey = await readFile(join(fixtureDir, "es256-test-only.private.pem"));
  const inputPath = join(dir, "source.png");
  const firstOutput = join(dir, "first-edit.png");
  const secondOutput = join(dir, "second-edit.png");
  await writeFile(inputPath, onePixelPng());

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
    inputPath, outputPath: firstOutput, mimeType: "image/png",
    actionDescription: "First timeline edit",
    sourceAssetId: "asset-source"
  });
  assert.equal(first.status, "signed_and_verified");
  assert.equal(first.sourceManifestPreserved, false);
  assert.ok(first.ingredientCount >= 1, "edit intent must create a parent ingredient");
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await stat(firstOutput)).isFile(), true);

  const second = await sign({
    inputPath: firstOutput, outputPath: secondOutput, mimeType: "image/png",
    actionDescription: "Second timeline edit",
    sourceAssetId: "asset-first-edit"
  });
  assert.equal(second.status, "signed_and_verified");
  assert.equal(second.sourceManifestPreserved, true);
  assert.ok(second.ingredientCount >= 1, "new manifest must retain the previous signed asset as an ingredient");
  assert.equal(second.sourceManifestState, first.validationState);
  assert.equal((await stat(secondOutput)).isFile(), true);
  assert.ok(calls >= 2, "the KMS/HSM callback must be invoked for each derivative");
});

test("signer rejects output overwrite and paths outside its media root", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ev-c2pa-path-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const certificateChain = await readFile(join(fixtureDir, "es256-test-only.chain.pem"));
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
