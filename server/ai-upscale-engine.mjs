import { spawn } from "node:child_process";
import { access, lstat, stat, open, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";

const MODELS = new Set(["realesrgan-x4plus", "realesrgan-x4plus-anime", "realesr-animevideov3", "realesrnet-x4plus"]);
const FORMATS = new Set(["png", "jpg", "webp"]);
const fail = (message, code) => Object.assign(new Error(message), { code });

function boundedInteger(value, fallback, min, max, label) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw fail(label + " is outside the supported range.", "AI_UPSCALE_INVALID_OPTIONS");
  }
  return number;
}

async function regularFile(path, label) {
  if (!path) return false;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    await access(path, constants.R_OK);
    return true;
  } catch { return false; }
}

async function fingerprintRegularFile(path, label) {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) {
      throw fail(label + " must remain a regular, non-symlink file.", "AI_UPSCALE_INPUT_CHANGED");
    }
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  } catch (error) {
    if (error.code === "AI_UPSCALE_INPUT_CHANGED") throw error;
    throw fail(label + " changed or became unavailable during processing.", "AI_UPSCALE_INPUT_CHANGED");
  }
}

function run(binary, args, timeoutMs, signal) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "", settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolvePromise({ stderr });
    };
    const abort = () => {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref?.();
      finish(fail("AI upscaling job was cancelled.", "JOB_CANCELLED"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(fail("AI upscaling process exceeded its time limit.", "AI_UPSCALE_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.once("error", () => finish(fail("AI upscaling executable could not start.", "AI_UPSCALE_ENGINE_UNAVAILABLE")));
    child.once("close", code => code === 0
      ? finish()
      : finish(fail("AI upscaling process failed: " + stderr.slice(-1200), "AI_UPSCALE_PROCESS_FAILED")));
  });
}

const GPU_MEMORY_FAILURE = /out of memory|failed to allocate|allocation failed|vkAllocateMemory|VK_ERROR_OUT_OF_(?:DEVICE|HOST)_MEMORY|insufficient[^\\n]*memory|memory allocation/i;
const FALLBACK_TILE_SIZES = Object.freeze([256, 192, 128, 96, 64, 32]);

function isGpuMemoryFailure(error) {
  return GPU_MEMORY_FAILURE.test(String(error?.message || ""));
}

/**
 * Retry only recognized GPU-memory allocation failures. The NCNN CLI documents
 * smaller tiles as the memory-pressure control; explicit operator tile choices
 * remain authoritative and are never silently changed.
 */
async function runWithTileFallback(binary, args, timeoutMs, signal, outputPath, requestedTile) {
  const candidates = requestedTile === 0 ? [0, ...FALLBACK_TILE_SIZES] : [requestedTile];
  const attemptedTiles = [];
  const startedAt = Date.now();
  for (let index = 0; index < candidates.length; index++) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      await unlink(outputPath).catch(() => {});
      throw Object.assign(
        fail("AI upscaling job exceeded its total time limit across tile retries.", "AI_UPSCALE_TIMEOUT"),
        { requestedTile, attemptedTiles: [...attemptedTiles], tileFallbackUsed: attemptedTiles.some(value => value !== requestedTile) }
      );
    }
    const tile = candidates[index];
    const attemptArgs = args.slice();
    const tileIndex = attemptArgs.indexOf("-t");
    if (tileIndex < 0 || tileIndex + 1 >= attemptArgs.length) {
      throw fail("AI upscaling execution plan is missing its tile argument.", "AI_UPSCALE_INVALID_OPTIONS");
    }
    attemptArgs[tileIndex + 1] = String(tile);
    attemptedTiles.push(tile);
    try {
      await run(binary, attemptArgs, remainingMs, signal);
      return { tile, attemptedTiles, fallbackUsed: tile !== requestedTile };
    } catch (error) {
      await unlink(outputPath).catch(() => {});
      if (!isGpuMemoryFailure(error) || index === candidates.length - 1) {
        throw Object.assign(error, {
          requestedTile,
          attemptedTiles: [...attemptedTiles],
          tileFallbackUsed: attemptedTiles.some(value => value !== requestedTile)
        });
      }
    }
  }
  throw fail("AI upscaling exhausted its GPU-memory tile fallback strategy.", "AI_UPSCALE_PROCESS_FAILED");
}

const MAX_IMAGE_HEADER_BYTES = 1024 * 1024;
const MAX_IMAGE_DIMENSION = 32768;
const MAX_IMAGE_PIXELS = 100_000_000;

function dimensionsFromHeader(bytes) {
  let width = 0, height = 0;
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii",12,16) === "IHDR") {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 30 && bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP") {
    const chunk = bytes.toString("ascii",12,16);
    if (chunk === "VP8X" && bytes.length >= 30) {
      width = 1 + bytes.readUIntLE(24,3);
      height = 1 + bytes.readUIntLE(27,3);
    } else if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
      width = 1 + (((b2 & 0x3f) << 8) | b1);
      height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (sof.has(marker) && segmentLength >= 7) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += segmentLength;
    }
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw fail("Image dimensions are missing, malformed or exceed the safe processing limit.", "AI_UPSCALE_IMAGE_DIMENSIONS_INVALID");
  }
  return { width, height };
}

function imageHasAlpha(bytes) {
  if (bytes.length >= 26 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii",12,16) === "IHDR") {
    const colorType = bytes[25];
    if (colorType === 4 || colorType === 6) return true;
    if (colorType !== 3) return false;
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (length > bytes.length - offset - 12) break;
      if (type === "tRNS") return true;
      if (type === "IDAT" || type === "IEND") return false;
      offset += length + 12;
    }
    return false;
  }
  if (bytes.length >= 30 && bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP") {
    const chunk = bytes.toString("ascii",12,16);
    if (chunk === "VP8X") return Boolean(bytes[20] & 0x10);
    if (chunk === "VP8L" && bytes[20] === 0x2f) return Boolean(bytes[24] & 0x10);
  }
  return false;
}

function bitDepthFromHeader(bytes) {
  if (bytes.length >= 25 &&
      bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
      bytes.toString("ascii", 12, 16) === "IHDR") return bytes[24];
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (sof.has(marker) && segmentLength >= 7) return bytes[offset + 2];
      offset += segmentLength;
    }
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP") return 8;
  return null;
}

async function readImageBitDepth(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(MAX_IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bitDepthFromHeader(header.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

async function readImageHasAlpha(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(MAX_IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return imageHasAlpha(header.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

async function readImageDimensions(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(MAX_IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return dimensionsFromHeader(header.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
})();
function updatePngCrc(crc, bytes) {
  for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}
async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (!result.bytesRead) throw fail("AI upscaling PNG output is truncated.", "AI_UPSCALE_OUTPUT_INVALID");
    read += result.bytesRead;
  }
  return buffer;
}
function pngInterlacePasses(width, height, interlace) {
  if (interlace === 0) return [{ width, height }];
  const starts = [[0,0],[4,0],[0,4],[2,0],[0,2],[1,0],[0,1]];
  const steps = [[8,8],[8,8],[4,8],[4,4],[2,4],[2,2],[1,2]];
  return starts.map(([x,y], index) => {
    const [dx,dy] = steps[index];
    return {
      width: width > x ? Math.ceil((width - x) / dx) : 0,
      height: height > y ? Math.ceil((height - y) / dy) : 0
    };
  });
}

async function validatePngFile(path, maxBytes) {
  const before = await lstat(path).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) throw fail("AI upscaling output must be a regular, non-symlink PNG file.", "AI_UPSCALE_OUTPUT_INVALID");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.dev !== before.dev || info.ino !== before.ino ||
        info.size !== before.size || info.size < 57 || info.size > maxBytes) {
      throw fail("AI upscaling PNG output changed during validation or is empty, incomplete or oversized.", "AI_UPSCALE_OUTPUT_INVALID");
    }
    const signature = await readExact(handle, 8, 0);
    if (!signature.equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw fail("AI upscaling output has an invalid PNG signature.", "AI_UPSCALE_OUTPUT_INVALID");
    let offset = 8, index = 0, width = 0, height = 0, bitDepth = 0, colorType = -1, ihdrInterlace = 0;
    let hasIdat = false, idatBytes = 0, idatEnded = false, hasPlte = false, hasIend = false;
    const idatParts = [];
    const critical = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
    while (offset < info.size) {
      if (info.size - offset < 12) throw fail("AI upscaling PNG output has a truncated chunk.", "AI_UPSCALE_OUTPUT_INVALID");
      const header = await readExact(handle, 8, offset);
      const length = header.readUInt32BE(0), typeBytes = header.subarray(4, 8), type = typeBytes.toString("ascii");
      if (length > 0x7fffffff || length > info.size - offset - 12) throw fail("AI upscaling PNG chunk exceeds its file boundary.", "AI_UPSCALE_OUTPUT_INVALID");
      if (![...typeBytes].every(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) || (typeBytes[2] & 0x20) !== 0) {
        throw fail("AI upscaling PNG contains an invalid chunk type.", "AI_UPSCALE_OUTPUT_INVALID");
      }
      if (index === 0 && (type !== "IHDR" || length !== 13)) throw fail("AI upscaling PNG must begin with IHDR.", "AI_UPSCALE_OUTPUT_INVALID");
      if (index > 0 && type === "IHDR") throw fail("AI upscaling PNG contains duplicate IHDR chunks.", "AI_UPSCALE_OUTPUT_INVALID");
      if (hasIend) throw fail("AI upscaling PNG contains data after IEND.", "AI_UPSCALE_OUTPUT_INVALID");
      if (hasIdat && type !== "IDAT") idatEnded = true;
      if (type === "IDAT" && idatEnded) throw fail("AI upscaling PNG IDAT chunks are not consecutive.", "AI_UPSCALE_OUTPUT_INVALID");
      if (type === "PLTE") {
        if (hasPlte || hasIdat || colorType === 0 || colorType === 4 || length < 3 || length > 768 || length % 3 !== 0) {
          throw fail("AI upscaling PNG has an invalid PLTE chunk.", "AI_UPSCALE_OUTPUT_INVALID");
        }
        if (colorType === 3 && length / 3 > 2 ** bitDepth) throw fail("AI upscaling PNG palette exceeds its bit depth.", "AI_UPSCALE_OUTPUT_INVALID");
        hasPlte = true;
      }
      if ((typeBytes[0] & 0x20) === 0 && !critical.has(type)) throw fail("AI upscaling PNG contains an unsupported critical chunk.", "AI_UPSCALE_OUTPUT_INVALID");
      if (type === "IEND" && (length !== 0 || !hasIdat || idatBytes === 0)) throw fail("AI upscaling PNG is missing image data or has an invalid IEND.", "AI_UPSCALE_OUTPUT_INVALID");
      let crc = updatePngCrc(0xffffffff, typeBytes), dataOffset = offset + 8, remaining = length;
      const ihdr = type === "IHDR" ? Buffer.alloc(13) : null;
      let copied = 0;
      while (remaining > 0) {
        const size = Math.min(64 * 1024, remaining), bytes = await readExact(handle, size, dataOffset);
        crc = updatePngCrc(crc, bytes);
        if (ihdr) { bytes.copy(ihdr, copied); copied += bytes.length; }
        dataOffset += size; remaining -= size;
      }
      const storedCrc = (await readExact(handle, 4, dataOffset)).readUInt32BE(0);
      if (((crc ^ 0xffffffff) >>> 0) !== storedCrc) throw fail("AI upscaling PNG contains an invalid chunk CRC.", "AI_UPSCALE_OUTPUT_INVALID");
      if (type === "IHDR") {
        width = ihdr.readUInt32BE(0); height = ihdr.readUInt32BE(4);
        bitDepth = ihdr[8]; colorType = ihdr[9]; ihdrInterlace = ihdr[12];
        const depths = ({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]})[colorType] || [];
        if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION ||
            width * height > MAX_IMAGE_PIXELS || !depths.includes(bitDepth) ||
            ihdr[10] !== 0 || ihdr[11] !== 0 || ![0,1].includes(ihdr[12])) {
          throw fail("AI upscaling PNG has invalid dimensions or IHDR fields.", "AI_UPSCALE_OUTPUT_INVALID");
        }
      }
      if (type === "IDAT") { hasIdat = true; idatBytes += length; idatParts.push(await readExact(handle, length, offset + 8)); }
      if (type === "IEND") {
        if (colorType === 3 && !hasPlte) throw fail("AI upscaling indexed PNG is missing PLTE.", "AI_UPSCALE_OUTPUT_INVALID");
        hasIend = true;
        if (dataOffset + 4 !== info.size) throw fail("AI upscaling PNG contains trailing bytes after IEND.", "AI_UPSCALE_OUTPUT_INVALID");
      }
      offset = dataOffset + 4; index++;
    }
    if (!hasIend || !hasIdat || offset !== info.size) throw fail("AI upscaling PNG output is incomplete.", "AI_UPSCALE_OUTPUT_INVALID");

    // IDAT chunks concatenate into one zlib stream. Validate decoded scanline
    // sizes and filter bytes, with a hard cap against decompression bombs.
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
    const bitsPerPixel = channels * bitDepth;
    const passes = pngInterlacePasses(width, height, ihdrInterlace);
    let expectedBytes = 0;
    const scanlinePasses = [];
    for (const pass of passes) {
      if (!pass.width || !pass.height) continue;
      const rowBytes = Math.ceil(pass.width * bitsPerPixel / 8);
      expectedBytes += pass.height * (rowBytes + 1);
      scanlinePasses.push({ rows: pass.height, rowBytes });
    }
    const MAX_PNG_DECODE_BYTES = 512 * 1024 * 1024;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_PNG_DECODE_BYTES) {
      throw fail("AI upscaling PNG decoded image exceeds the safe validation budget.", "AI_UPSCALE_OUTPUT_INVALID");
    }
    let decoded;
    try {
      const compressed = Buffer.concat(idatParts, idatBytes);
      const inflated = inflateSync(compressed, { maxOutputLength: expectedBytes + 1, info: true });
      decoded = inflated.buffer;
      if (inflated.engine.bytesWritten !== compressed.length) {
        throw fail("AI upscaling PNG image data contains trailing bytes after its zlib stream.", "AI_UPSCALE_OUTPUT_INVALID");
      }
    } catch (error) {
      if (error.code === "AI_UPSCALE_OUTPUT_INVALID") throw error;
      throw fail("AI upscaling PNG image data is not a valid bounded zlib/DEFLATE stream.", "AI_UPSCALE_OUTPUT_INVALID");
    }
    if (decoded.length !== expectedBytes) {
      throw fail("AI upscaling PNG decoded scanline length does not match its dimensions.", "AI_UPSCALE_OUTPUT_INVALID");
    }
    let scanOffset = 0;
    for (const pass of scanlinePasses) {
      for (let row = 0; row < pass.rows; row++) {
        if (decoded[scanOffset] > 4) throw fail("AI upscaling PNG contains an invalid scanline filter.", "AI_UPSCALE_OUTPUT_INVALID");
        scanOffset += pass.rowBytes + 1;
      }
    }
    return { width, height };
  } finally { await handle.close().catch(() => {}); }
}

async function validateImageOutput(path, format, maxBytes) {
  if (format === "png") return validatePngFile(path, maxBytes);
  const before = await lstat(path).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) throw fail("AI upscaling output must be a regular, non-symlink image file.", "AI_UPSCALE_OUTPUT_INVALID");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.dev !== before.dev || info.ino !== before.ino ||
        info.size !== before.size || info.size < 24 || info.size > maxBytes) {
      throw fail("AI upscaling image changed during validation or is empty, incomplete or oversized.", "AI_UPSCALE_OUTPUT_INVALID");
    }
    const header = Buffer.alloc(MAX_IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    const valid = format === "jpg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12 && bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP";
    if (!valid) throw fail("AI upscaling output does not match the requested image format.", "AI_UPSCALE_OUTPUT_INVALID");
    return dimensionsFromHeader(bytes);
  } finally { await handle.close().catch(() => {}); }
}

export function createRealEsrganAdapter({
  binaryPath = process.env.REALESRGAN_NCNN_PATH || "",
  modelDirectory = process.env.REALESRGAN_MODEL_DIR || "",
  timeoutMs = 30 * 60 * 1000,
  maxOutputBytes = 250 * 1024 * 1024,
  maxOutputPixels = MAX_IMAGE_PIXELS,
  enabled = process.env.AI_UPSCALE_ENABLED === "true"
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2 * 60 * 60 * 1000) throw new Error("AI upscale timeout is invalid.");
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 2 * 1024 * 1024 * 1024) throw new Error("AI upscale output limit is invalid.");
  if (!Number.isInteger(maxOutputPixels) || maxOutputPixels < 1 || maxOutputPixels > MAX_IMAGE_PIXELS) throw new Error("AI upscale pixel budget is invalid.");

  const executionFingerprints = new Map();

  async function fingerprint(model) {
    const files = [binaryPath, resolve(modelDirectory || ".", model + ".param"), resolve(modelDirectory || ".", model + ".bin")];
    try {
      // Include inode/device and nanosecond ctime as well as size/mtime. This
      // detects same-size replacements and content edits even when mtime is restored.
      const metadata = await Promise.all(files.map(path => lstat(path, { bigint: true })));
      if (metadata.some(item => !item.isFile() || item.isSymbolicLink())) return null;
      return metadata.map(item => [item.dev, item.ino, item.size, item.mtimeNs, item.ctimeNs].join(":")).join("|");
    } catch { return null; }
  }

  async function probe(model) {
    const selected = String(model || "realesrgan-x4plus");
    const binaryReady = await regularFile(binaryPath, "binary");
    const modelReady = MODELS.has(selected) && await regularFile(resolve(modelDirectory || ".", selected + ".param")) &&
      await regularFile(resolve(modelDirectory || ".", selected + ".bin"));
    const configured = binaryReady && modelReady;
    const currentFingerprint = configured ? await fingerprint(selected) : null;
    const executionVerified = Boolean(currentFingerprint && executionFingerprints.get(selected) === currentFingerprint);
    return {
      engine: "realesrgan-ncnn-vulkan",
      available: configured,
      executionVerified,
      inferenceVerified: false,
      executionEnabled: Boolean(enabled),
      binaryReady,
      modelReady,
      model: selected,
      reason: !binaryReady ? "Configure a readable NCNN/Vulkan executable." : !modelReady ? "The selected allowlisted model files are not installed." : !enabled ? "Engine is installed, but AI_UPSCALE_ENABLED is not enabled on this worker." : executionVerified ? "Execution self-test passed; neural inference quality has not been independently verified." : "Configured, but an execution self-test has not passed on this worker."
    };
  }

  async function selfTest({ inputPath, model = "realesrgan-x4plus", scale = 2, tile = 0, format = "png", threads = "1:2:2", tta = false, gpu = "auto", signal } = {}) {
    if (!enabled) throw fail("AI_UPSCALE_ENABLED must be explicitly enabled before a GPU self-test.", "AI_UPSCALE_ENGINE_UNAVAILABLE");
    if (!(await regularFile(inputPath, "self-test image"))) throw fail("A readable test image is required for the inference self-test.", "AI_UPSCALE_INVALID_INPUT");
    const selected = String(model || "realesrgan-x4plus");
    if (!MODELS.has(selected)) throw fail("The selected AI model is not allowlisted.", "AI_UPSCALE_INVALID_MODEL");
    const before = await fingerprint(selected);
    if (!before) throw fail("The selected engine and model files are not installed.", "AI_UPSCALE_ENGINE_UNAVAILABLE");
    const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-selftest-"));
    try {
      const outputPath = join(directory, randomUUID() + "." + format);
      const result = await execute({ inputPath, outputPath, model: selected, scale, tile, format, threads, tta, gpu, signal });
      const after = await fingerprint(selected);
      if (!after || before !== after) throw fail("Engine or model files changed during the self-test.", "AI_UPSCALE_SELF_TEST_FAILED");
      executionFingerprints.set(selected, after);
      return { passed: true, executionVerified: true, inferenceVerified: false, engine: result.engine, model: result.model, scale: result.scale, threads: result.threads, tta: result.tta, gpu: result.gpu, inputDimensions: result.inputDimensions, outputDimensions: result.outputDimensions, outputBytes: result.byteSize, outputHasAlpha: result.outputHasAlpha, alphaPreserved: result.alphaPreserved, tile: result.tile, requestedTile: result.requestedTile, tileFallbackUsed: result.tileFallbackUsed, tileAttempts: result.tileAttempts };
    } catch (error) {
      executionFingerprints.delete(selected);
      throw error;
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
  }

  function plan({ inputPath, outputPath, model = "realesrgan-x4plus", scale = 4, tile = 0, format = "png", threads = "1:2:2", tta = false, gpu = "auto" } = {}) {
    if (!MODELS.has(model)) throw fail("The selected AI model is not allowlisted.", "AI_UPSCALE_INVALID_MODEL");
    if (!FORMATS.has(format)) throw fail("The requested output format is unsupported.", "AI_UPSCALE_INVALID_OPTIONS");
    const factor = boundedInteger(scale, 4, 2, 4, "Scale");
    if (![2, 3, 4].includes(factor)) throw fail("Scale must be 2, 3 or 4.", "AI_UPSCALE_INVALID_OPTIONS");
    const tileSize = boundedInteger(tile, 0, 0, 512, "Tile size");
    if (tileSize !== 0 && tileSize < 32) throw fail("Tile size must be zero or between 32 and 512.", "AI_UPSCALE_INVALID_OPTIONS");
    // NCNN's -j load:proc:save controls decode, inference and encode workers.
    // Keep a conservative aggregate cap because higher values can increase GPU memory use.
    if (typeof threads !== "string" || !/^[1-4]:[1-4]:[1-4]$/.test(threads) ||
        threads.split(":").reduce((sum, value) => sum + Number(value), 0) > 8) {
      throw fail("Thread configuration must be load:proc:save with each value 1-4 and a combined maximum of 8.", "AI_UPSCALE_INVALID_OPTIONS");
    }
    if (typeof tta !== "boolean") throw fail("TTA must be a boolean.", "AI_UPSCALE_INVALID_OPTIONS");
    const gpuId = gpu === "auto" ? "auto" : Number.isInteger(gpu) ? String(gpu) : typeof gpu === "string" && /^(?:0|[1-9][0-9]?)$/.test(gpu) ? gpu : null;
    if (gpuId === null || (gpuId !== "auto" && Number(gpuId) > 31)) throw fail("GPU selection must be auto or a device index from 0 to 31.", "AI_UPSCALE_INVALID_OPTIONS");
    if (!inputPath || !outputPath || resolve(inputPath) === resolve(outputPath)) throw fail("Distinct input and output paths are required.", "AI_UPSCALE_INVALID_PATH");
    return {
      binary: binaryPath,
      args: ["-i", resolve(inputPath), "-o", resolve(outputPath), "-n", model, "-s", String(factor), "-t", String(tileSize), "-g", gpuId, "-j", threads, ...(tta ? ["-x"] : []), "-f", format],
      model, scale: factor, tile: tileSize, gpu: gpuId, threads, tta, format
    };
  }

  async function execute(options = {}) {
    const prepared = plan(options);
    const readiness = await probe(prepared.model);
    if (!readiness.available || !readiness.executionEnabled) throw fail(readiness.reason, "AI_UPSCALE_ENGINE_UNAVAILABLE");
    const input = resolve(options.inputPath), output = resolve(options.outputPath);
    if (!(await regularFile(input))) throw fail("AI upscale input must be an existing regular file.", "AI_UPSCALE_INVALID_INPUT");
    // Pin source identity and metadata across header inspection and inference so
    // the derivative cannot silently be attributed to bytes that were replaced mid-job.
    const inputFingerprintBefore = await fingerprintRegularFile(input, "AI upscale input");
    const inputDimensions = await readImageDimensions(input);
    const sourceBitDepth = await readImageBitDepth(input);
    if (sourceBitDepth !== null && sourceBitDepth > 8) throw fail("This NCNN/Vulkan adapter has not certified high-bit-depth input. Use an 8-bit source or a separately validated high-bit-depth inference path.", "AI_UPSCALE_BIT_DEPTH_UNSUPPORTED");
    const sourceHasAlpha = await readImageHasAlpha(input);
    if (sourceHasAlpha && prepared.format === "jpg") throw fail("JPEG cannot preserve source transparency. Choose PNG or WebP output.", "AI_UPSCALE_ALPHA_JPEG_UNSUPPORTED");
    const projectedWidth = inputDimensions.width * prepared.scale;
    const projectedHeight = inputDimensions.height * prepared.scale;
    if (projectedWidth > MAX_IMAGE_DIMENSION || projectedHeight > MAX_IMAGE_DIMENSION || projectedWidth * projectedHeight > maxOutputPixels) {
      throw fail("Requested upscale dimensions exceed the safe output pixel budget.", "AI_UPSCALE_OUTPUT_BUDGET_EXCEEDED");
    }
    try { await lstat(output); throw fail("AI upscale output already exists; source files are never overwritten.", "AI_UPSCALE_OUTPUT_EXISTS"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(output) === input || output.startsWith(input + sep)) throw fail("AI upscale output path is invalid.", "AI_UPSCALE_INVALID_PATH");
    const execution = await runWithTileFallback(prepared.binary, prepared.args, timeoutMs, options.signal, output, prepared.tile);
    try {
      const inputFingerprintAfter = await fingerprintRegularFile(input, "AI upscale input");
      if (inputFingerprintAfter !== inputFingerprintBefore) {
        throw fail("AI upscale source changed during inference; the derivative was rejected.", "AI_UPSCALE_INPUT_CHANGED");
      }
      const info = await stat(output).catch(() => null);
      if (!info?.isFile() || info.size < 24 || info.size > maxOutputBytes) throw fail("AI upscale output is missing, empty or exceeds the configured size limit.", "AI_UPSCALE_OUTPUT_INVALID");
      const outputDimensions = await validateImageOutput(output, prepared.format, maxOutputBytes);
      const outputBitDepth = await readImageBitDepth(output);
      const outputHasAlpha = await readImageHasAlpha(output);
      if (sourceHasAlpha && !outputHasAlpha) throw fail("AI upscaling output lost source transparency; the derivative was rejected.", "AI_UPSCALE_ALPHA_LOST");
      if (outputDimensions.width !== inputDimensions.width * prepared.scale || outputDimensions.height !== inputDimensions.height * prepared.scale) {
        throw fail("AI upscaling output dimensions do not match the requested scale.", "AI_UPSCALE_OUTPUT_DIMENSIONS_MISMATCH");
      }
      return {
        path: output, byteSize: info.size, inputDimensions, outputDimensions,
        sourceHasAlpha, outputHasAlpha, alphaPreserved: !sourceHasAlpha || outputHasAlpha,
        ...(sourceBitDepth !== null ? { sourceBitDepth } : {}),
        ...(outputBitDepth !== null ? { outputBitDepth } : {}),
        model: prepared.model, scale: prepared.scale, threads: prepared.threads, tta: prepared.tta, gpu: prepared.gpu, tile: execution.tile,
        requestedTile: prepared.tile, tileFallbackUsed: execution.fallbackUsed,
        tileAttempts: execution.attemptedTiles, format: prepared.format,
        engine: "realesrgan-ncnn-vulkan", method: "ai-super-resolution"
      };
    } catch (error) {
      await unlink(output).catch(() => {});
      throw error;
    }
  }

  return Object.freeze({ probe, plan, execute, selfTest });
}
