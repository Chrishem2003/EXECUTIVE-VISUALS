import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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

function chunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type), data]);
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
  const text = Buffer.from("Comment\\0Original", "latin1");
  const pixels = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("tEXt", text),
    chunk("IDAT", pixels),
    chunk("IEND")
  ]);
}

function changePngText(buffer) {
  const output = Buffer.from(buffer);
  let offset = 8;
  while (offset + 12 <= output.length) {
    const length = output.readUInt32BE(offset);
    const type = output.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    if (type === "tEXt") {
      const marker = Buffer.from("Original", "latin1");
      const index = output.indexOf(marker, dataStart);
      assert.notEqual(index, -1, "expected the PNG text fixture");
      Buffer.from("Tampered", "latin1").copy(output, index);
      const body = output.subarray(offset + 4, crcOffset);
      output.writeUInt32BE(crc32(body), crcOffset);
      return output;
    }
    offset = crcOffset + 4;
  }
  throw new Error("PNG text chunk not found");
}

test("validates a genuinely signed C2PA PNG and detects post-signing asset tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "executive-visuals-c2pa-signed-"));
  const input = join(directory, "input.png");
  const signed = join(directory, "signed.png");
  const tampered = join(directory, "tampered.png");
  const key = join(directory, "signer-key.pem");
  const certificate = join(directory, "signer-cert.pem");
  try {
    const generated = spawnSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", key, "-out", certificate, "-days", "2", "-nodes",
      "-subj", "/CN=Executive Visuals CI C2PA Test Signer",
      "-addext", "keyUsage=critical,digitalSignature",
      "-addext", "extendedKeyUsage=critical,1.3.6.1.5.5.7.3.36"
    ], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr || "openssl certificate generation failed");
    await writeFile(input, makePng());
    const { Builder, LocalSigner } = await import("@contentauth/c2pa-node");
    const builder = await Builder.newAsync();
    builder.setIntent({ create: "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture" });
    const signer = LocalSigner.newSigner(await readFile(certificate), await readFile(key), "es256");
    builder.sign(signer, { path: input, mimeType: "image/png" }, { path: signed, mimeType: "image/png" });

    const valid = await inspectC2paAsset({ path: signed, mimeType: "image/png" });
    assert.equal(valid.configured, true);
    assert.equal(valid.embedded, true);
    assert.ok(valid.activeManifest, "signed file should expose an active manifest");
    assert.ok(["Valid", "Trusted"].includes(valid.validationState), `unexpected signed-fixture state: ${valid.validationState}`);

    await writeFile(tampered, changePngText(await readFile(signed)));
    const invalid = await inspectC2paAsset({ path: tampered, mimeType: "image/png" });
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.validationState, "Invalid");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
