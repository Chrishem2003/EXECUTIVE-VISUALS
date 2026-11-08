import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { inspectC2paAsset } from "../c2pa-verification.mjs";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function makePng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", pixels),
    pngChunk("IEND")
  ]);
}

test("loads the real CAI native SDK and inspects an ordinary PNG", async () => {
  const directory = await mkdtemp(join(tmpdir(), "executive-visuals-c2pa-"));
  const path = join(directory, "plain.png");
  try {
    await writeFile(path, makePng());
    const result = await inspectC2paAsset({ path, mimeType: "image/png" });
    assert.equal(result.configured, true);
    assert.equal(result.status, "not_found");
    assert.equal(result.validationState, null);
    assert.equal(result.embedded, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
