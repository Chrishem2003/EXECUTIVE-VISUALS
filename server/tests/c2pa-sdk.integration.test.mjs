import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { createC2paVerifier } from "../c2pa-verification.mjs";

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

test("real CAI Node SDK parses an ordinary PNG and reports no embedded C2PA manifest", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ev-c2pa-sdk-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "plain.png");
  const bytes = onePixelPng();
  await writeFile(path, bytes);

  const verify = createC2paVerifier({ sdkLoader: () => import("@contentauth/c2pa-node") });
  const result = await verify({ path, mimeType: "image/png", size: bytes.length });

  assert.equal(result.status, "not_available");
  assert.equal(result.manifestPresent, false);
  assert.equal(result.errorCode, undefined);
});
