import { spawn } from "node:child_process";
import { access, lstat, stat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";

const MODELS = new Set(["realesrgan-x4plus", "realesrgan-x4plus-anime", "realesr-animevideov3", "realesrgan-x2plus"]);
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

// Inspect bounded container metadata before derivative publication. This verifies
// format and dimensions; it deliberately does not claim a full pixel decode or
// perceptual-quality assessment, which remain separate release gates.
async function inspectImage(path) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 24) throw fail("Image output is missing or truncated.", "AI_UPSCALE_OUTPUT_INVALID");
    const head = Buffer.alloc(Math.min(64, info.size));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const bytes = head.subarray(0, bytesRead);
    if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii", 12, 16) === "IHDR") {
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height || width > 32768 || height > 32768) throw fail("Image dimensions are invalid or exceed the supported limit.", "AI_UPSCALE_OUTPUT_INVALID");
      return { format: "png", width, height, byteSize: info.size };
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      // JPEG dimensions are stored in a Start Of Frame segment. Bound the
      // metadata scan so malformed files cannot force unbounded reads.
      const scanSize = Math.min(info.size, 1024 * 1024);
      const scan = Buffer.alloc(scanSize);
      const result = await handle.read(scan, 0, scanSize, 0);
      let offset = 2;
      while (offset + 4 <= result.bytesRead) {
        if (scan[offset] !== 0xff) { offset++; continue; }
        while (offset < result.bytesRead && scan[offset] === 0xff) offset++;
        const marker = scan[offset++];
        if (marker === 0xd9 || marker === 0xda) break;
        if ([0xd8,0x01,0xd0,0xd1,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7].includes(marker)) continue;
        if (offset + 2 > result.bytesRead) break;
        const length = scan.readUInt16BE(offset);
        if (length < 2 || offset + length > result.bytesRead) break;
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
          if (length < 7) break;
          const height = scan.readUInt16BE(offset + 3), width = scan.readUInt16BE(offset + 5);
          if (!width || !height || width > 32768 || height > 32768) break;
          const tail = Buffer.alloc(2);
          await handle.read(tail, 0, 2, info.size - 2);
          if (tail[0] !== 0xff || tail[1] !== 0xd9) throw fail("JPEG output is incomplete.", "AI_UPSCALE_OUTPUT_INVALID");
          return { format: "jpg", width, height, byteSize: info.size };
        }
        offset += length;
      }
      throw fail("JPEG output has no valid image dimensions.", "AI_UPSCALE_OUTPUT_INVALID");
    }
    if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
      const chunk = bytes.toString("ascii", 12, 16);
      let width = 0, height = 0;
      if (chunk === "VP8X") {
        width = 1 + bytes.readUIntLE(24, 3);
        height = 1 + bytes.readUIntLE(27, 3);
      } else if (chunk === "VP8L" && bytes[20] === 0x2f) {
        width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
        height = 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
      } else if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        width = bytes.readUInt16LE(26) & 0x3fff;
        height = bytes.readUInt16LE(28) & 0x3fff;
      }
      if (width && height && width <= 32768 && height <= 32768) return { format: "webp", width, height, byteSize: info.size };
    }
    throw fail("Image output does not contain a supported image header and dimensions.", "AI_UPSCALE_OUTPUT_INVALID");
  } finally { await handle.close(); }
}

async function validateImageOutput(path, format, sourceDimensions, scale) {
  const image = await inspectImage(path);
  if (image.format !== format) throw fail("AI upscaling output does not match the requested image format.", "AI_UPSCALE_OUTPUT_INVALID");
  const expectedWidth = sourceDimensions.width * scale;
  const expectedHeight = sourceDimensions.height * scale;
  if (image.width !== expectedWidth || image.height !== expectedHeight) {
    throw fail("AI upscaling output dimensions do not match the requested scale.", "AI_UPSCALE_DIMENSIONS_MISMATCH");
  }
  return image;
}

export function createRealEsrganAdapter({
  binaryPath = process.env.REALESRGAN_NCNN_PATH || "",
  modelDirectory = process.env.REALESRGAN_MODEL_DIR || "",
  timeoutMs = 30 * 60 * 1000,
  maxOutputBytes = 250 * 1024 * 1024,
  enabled = process.env.AI_UPSCALE_ENABLED === "true"
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2 * 60 * 60 * 1000) throw new Error("AI upscale timeout is invalid.");
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 2 * 1024 * 1024 * 1024) throw new Error("AI upscale output limit is invalid.");

  const executionFingerprints = new Map();

  async function fingerprint(model) {
    const files = [binaryPath, resolve(modelDirectory || ".", model + ".param"), resolve(modelDirectory || ".", model + ".bin")];
    try {
      const metadata = await Promise.all(files.map(path => stat(path)));
      return metadata.map(item => item.size + ":" + item.mtimeMs).join("|");
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

  async function selfTest({ inputPath, model = "realesrgan-x4plus", scale = 2, tile = 0, format = "png", signal } = {}) {
    if (!enabled) throw fail("AI_UPSCALE_ENABLED must be explicitly enabled before a GPU self-test.", "AI_UPSCALE_ENGINE_UNAVAILABLE");
    if (!(await regularFile(inputPath, "self-test image"))) throw fail("A readable test image is required for the inference self-test.", "AI_UPSCALE_INVALID_INPUT");
    const selected = String(model || "realesrgan-x4plus");
    if (!MODELS.has(selected)) throw fail("The selected AI model is not allowlisted.", "AI_UPSCALE_INVALID_MODEL");
    const before = await fingerprint(selected);
    if (!before) throw fail("The selected engine and model files are not installed.", "AI_UPSCALE_ENGINE_UNAVAILABLE");
    const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-selftest-"));
    try {
      const outputPath = join(directory, randomUUID() + "." + format);
      const result = await execute({ inputPath, outputPath, model: selected, scale, tile, format, signal });
      const after = await fingerprint(selected);
      if (!after || before !== after) throw fail("Engine or model files changed during the self-test.", "AI_UPSCALE_SELF_TEST_FAILED");
      executionFingerprints.set(selected, after);
      return { passed: true, executionVerified: true, inferenceVerified: false, engine: result.engine, model: result.model, scale: result.scale, outputBytes: result.byteSize };
    } catch (error) {
      executionFingerprints.delete(selected);
      throw error;
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
  }

  function plan({ inputPath, outputPath, model = "realesrgan-x4plus", scale = 4, tile = 0, format = "png" } = {}) {
    if (!MODELS.has(model)) throw fail("The selected AI model is not allowlisted.", "AI_UPSCALE_INVALID_MODEL");
    if (!FORMATS.has(format)) throw fail("The requested output format is unsupported.", "AI_UPSCALE_INVALID_OPTIONS");
    const factor = boundedInteger(scale, 4, 2, 4, "Scale");
    if (![2, 3, 4].includes(factor)) throw fail("Scale must be 2, 3 or 4.", "AI_UPSCALE_INVALID_OPTIONS");
    const tileSize = boundedInteger(tile, 0, 0, 512, "Tile size");
    if (tileSize !== 0 && tileSize < 32) throw fail("Tile size must be zero or between 32 and 512.", "AI_UPSCALE_INVALID_OPTIONS");
    if (!inputPath || !outputPath || resolve(inputPath) === resolve(outputPath)) throw fail("Distinct input and output paths are required.", "AI_UPSCALE_INVALID_PATH");
    return {
      binary: binaryPath,
      args: ["-i", resolve(inputPath), "-o", resolve(outputPath), "-n", model, "-s", String(factor), "-t", String(tileSize), "-f", format],
      model, scale: factor, tile: tileSize, format
    };
  }

  async function execute(options = {}) {
    const prepared = plan(options);
    const readiness = await probe(prepared.model);
    if (!readiness.available || !readiness.executionEnabled) throw fail(readiness.reason, "AI_UPSCALE_ENGINE_UNAVAILABLE");
    const input = resolve(options.inputPath), output = resolve(options.outputPath);
    if (!(await regularFile(input))) throw fail("AI upscale input must be an existing regular file.", "AI_UPSCALE_INVALID_INPUT");
    const sourceImage = await inspectImage(input);
    try { await lstat(output); throw fail("AI upscale output already exists; source files are never overwritten.", "AI_UPSCALE_OUTPUT_EXISTS"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(output) === input || output.startsWith(input + sep)) throw fail("AI upscale output path is invalid.", "AI_UPSCALE_INVALID_PATH");
    await run(prepared.binary, prepared.args, timeoutMs, options.signal);
    const info = await stat(output).catch(() => null);
    if (!info?.isFile() || info.size < 24 || info.size > maxOutputBytes) throw fail("AI upscale output is missing, empty or exceeds the configured size limit.", "AI_UPSCALE_OUTPUT_INVALID");
    const outputImage = await validateImageOutput(output, prepared.format, sourceImage, prepared.scale);
    return { path: output, byteSize: info.size, width: outputImage.width, height: outputImage.height, sourceWidth: sourceImage.width, sourceHeight: sourceImage.height, model: prepared.model, scale: prepared.scale, tile: prepared.tile, format: prepared.format, engine: "realesrgan-ncnn-vulkan", method: "ai-super-resolution" };
  }

  return Object.freeze({ probe, plan, execute, selfTest });
}
