import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { createC2paVerifier } from "../c2pa-verification.mjs";

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
  const pixel = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  return Buffer.concat([signature, pngChunk("IHDR", header), pngChunk("IDAT", pixel), pngChunk("IEND", Buffer.alloc(0))]);
}
function alterPngPixels(bytes) {
  const signature = bytes.subarray(0, 8);
  const chunks = [];
  let offset = 8, changed = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT" && !changed) {
      const pixels = inflateSync(data);
      pixels[1] = pixels[1] === 255 ? 0 : 255;
      chunks.push(pngChunk("IDAT", deflateSync(pixels)));
      changed = true;
    } else {
      chunks.push(Buffer.from(bytes.subarray(offset, offset + 12 + length)));
    }
    offset += 12 + length;
  }
  if (!changed || offset !== bytes.length) throw new Error("Could not safely rewrite PNG pixel data");
  return Buffer.concat([signature, ...chunks]);
}

test("real CAI SDK validates signed media, applies explicit signer policy and rejects altered pixels", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ev-c2pa-signed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputPath = join(dir, "source.png"), signedPath = join(dir, "signed.png"), tamperedPath = join(dir, "tampered.png");
  const certificateChain = await readFile(join(fixtureDir, "es256-test-only.chain.pem"));
  const privateKey = await readFile(join(fixtureDir, "es256-test-only.private.pem"));
  const certificateBlocks = certificateChain.toString("utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  assert.ok(certificateBlocks.length >= 2, "upstream test fixture must contain a signer and intermediate certificate");
  const anchorPath = join(dir, "user-anchors.pem");
  await writeFile(anchorPath, certificateBlocks[1] + "\n");
  await writeFile(inputPath, onePixelPng());

  const { Builder, LocalSigner } = await import("@contentauth/c2pa-node");
  const signer = LocalSigner.newSigner(certificateChain, privateKey, "es256");
  const builder = await Builder.newAsync();
  builder.setIntent({ create: "http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia" });
  builder.sign(signer, { path: inputPath, mimeType: "image/png" }, { path: signedPath, mimeType: "image/png" });

  const signedSize = (await stat(signedPath)).size;
  const untrustedVerifier = createC2paVerifier({ sdkLoader: () => import("@contentauth/c2pa-node") });
  const untrusted = await untrustedVerifier({ path: signedPath, mimeType: "image/png", size: signedSize });
  assert.equal(untrusted.manifestPresent, true);
  assert.equal(untrusted.status, "valid_untrusted");
  assert.ok(Array.isArray(untrusted.validationFindings));

  const trustedVerifier = createC2paVerifier({ sdkLoader: () => import("@contentauth/c2pa-node"), trustAnchors: anchorPath });
  const trusted = await trustedVerifier({ path: signedPath, mimeType: "image/png", size: signedSize });
  assert.equal(trusted.manifestPresent, true);
  assert.equal(trusted.status, "valid_trusted", JSON.stringify(trusted, null, 2));
  assert.equal(trusted.trustPolicyType, "user_anchors");

  const signedBytes = await readFile(signedPath);
  await writeFile(tamperedPath, alterPngPixels(signedBytes));
  const tamperedSize = (await stat(tamperedPath)).size;
  const tampered = await trustedVerifier({ path: tamperedPath, mimeType: "image/png", size: tamperedSize });
  assert.equal(tampered.status, "invalid");
});
