import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync, inflateSync } from "node:zlib";
import { createC2paVerifier } from "../c2pa-verification.mjs";


async function createTestSigningIdentity(dir) {
  const rootKey=join(dir,"ephemeral-test-root-key.pem"),rootCert=join(dir,"ephemeral-test-root-cert.pem");
  const signerKey=join(dir,"ephemeral-test-signer-key.pem"),signerCsr=join(dir,"ephemeral-test-signer.csr");
  const signerCert=join(dir,"ephemeral-test-signer-cert.pem"),chainPath=join(dir,"ephemeral-test-chain.pem");
  const extensionsPath=join(dir,"ephemeral-test-extensions.cnf");
  await writeFile(extensionsPath,"basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,emailProtection,1.3.6.1.4.1.62558.2.1\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n");
  execFileSync("openssl",["req","-x509","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-keyout",rootKey,"-out",rootCert,"-days","1","-subj","/CN=Executive Visuals Ephemeral Test Root","-addext","basicConstraints=critical,CA:TRUE","-addext","keyUsage=critical,keyCertSign,cRLSign","-addext","subjectKeyIdentifier=hash","-addext","authorityKeyIdentifier=keyid:always"],{stdio:"ignore"});
  execFileSync("openssl",["req","-new","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-keyout",signerKey,"-out",signerCsr,"-subj","/CN=Executive Visuals Ephemeral Test Signer"],{stdio:"ignore"});
  execFileSync("openssl",["x509","-req","-in",signerCsr,"-CA",rootCert,"-CAkey",rootKey,"-CAcreateserial","-out",signerCert,"-days","1","-sha256","-extfile",extensionsPath],{stdio:"ignore"});
  await writeFile(chainPath,Buffer.concat([await readFile(signerCert),await readFile(rootCert)]));
  return {certificateChain:await readFile(chainPath),privateKey:await readFile(signerKey)};
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
function onePixelPng() {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  const pixel = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  return Buffer.concat([signature, pngChunk("IHDR", header), pngChunk("IDAT", pixel), pngChunk("IEND", Buffer.alloc(0))]);
}

function alterMp4MediaData(bytes) {
  const changed = Buffer.from(bytes);
  let offset = 0;
  while (offset + 8 <= changed.length) {
    let size = changed.readUInt32BE(offset);
    const type = changed.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > changed.length) throw new Error("Truncated extended MP4 box");
      const extended = changed.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MP4 box is too large to inspect");
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) {
      size = changed.length - offset;
    }
    if (size < headerSize || offset + size > changed.length) throw new Error("Invalid MP4 box bounds");
    if (type === "mdat" && size > headerSize + 16) {
      const payloadOffset = offset + headerSize + Math.min(16, size - headerSize - 1);
      changed[payloadOffset] ^= 0x01;
      return changed;
    }
    offset += size;
  }
  throw new Error("No mutable MP4 media-data payload was found");
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
  const {certificateChain,privateKey}=await createTestSigningIdentity(dir);
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

test("real CAI Node SDK signs and verifies an MP4 video with the same explicit trust policy", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ev-c2pa-video-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, "source.mp4"), signedPath = join(dir, "signed.mp4"), tamperedPath = join(dir, "tampered.mp4");
  const {certificateChain,privateKey}=await createTestSigningIdentity(dir);
  const certificateBlocks = certificateChain.toString("utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  assert.ok(certificateBlocks.length >= 2, "upstream test fixture must contain a signer and intermediate certificate");
  const anchorPath = join(dir, "user-anchors.pem");
  await writeFile(anchorPath, certificateBlocks[1] + "\n");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=24",
    "-t", "1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", sourcePath
  ], { stdio: "pipe" });

  const { Builder, LocalSigner } = await import("@contentauth/c2pa-node");
  const signer = LocalSigner.newSigner(certificateChain, privateKey, "es256");
  const builder = await Builder.newAsync();
  builder.setIntent({ create: "http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia" });
  builder.sign(signer, { path: sourcePath, mimeType: "video/mp4" }, { path: signedPath, mimeType: "video/mp4" });

  const signedSize = (await stat(signedPath)).size;
  const untrusted = await createC2paVerifier({ sdkLoader: () => import("@contentauth/c2pa-node") })({
    path: signedPath, mimeType: "video/mp4", size: signedSize
  });
  assert.equal(untrusted.status, "valid_untrusted");
  assert.equal(untrusted.manifestPresent, true);

  const trusted = await createC2paVerifier({
    sdkLoader: () => import("@contentauth/c2pa-node"),
    trustAnchors: anchorPath
  })({ path: signedPath, mimeType: "video/mp4", size: signedSize });
  assert.equal(trusted.status, "valid_trusted", JSON.stringify(trusted, null, 2));
  assert.equal(trusted.trustPolicyType, "user_anchors");

  const signedBytes = await readFile(signedPath);
  await writeFile(tamperedPath, alterMp4MediaData(signedBytes));
  const tamperedSize = (await stat(tamperedPath)).size;
  const tampered = await createC2paVerifier({
    sdkLoader: () => import("@contentauth/c2pa-node"),
    trustAnchors: anchorPath
  })({ path: tamperedPath, mimeType: "video/mp4", size: tamperedSize });
  assert.equal(tampered.status, "invalid", JSON.stringify(tampered, null, 2));
});
