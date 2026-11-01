import { spawn } from "node:child_process";
import { access, lstat, stat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve, sep } from "node:path";

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

async function validateImageOutput(path, format) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    const valid = format === "png"
      ? bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii",12,16) === "IHDR"
      : format === "jpg"
        ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : bytes.length >= 12 && bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP";
    if (!valid) throw fail("AI upscaling output does not match the requested image format.", "AI_UPSCALE_OUTPUT_INVALID");
  } finally { await handle.close(); }
}

export function createRealEsrganAdapter({
  binaryPath = process.env.REALESRGAN_NCNN_PATH || "",
  modelDirectory = process.env.REALESRGAN_MODEL_DIR || "",
  timeoutMs = 30 * 60 * 1000,
  maxOutputBytes = 250 * 1024 * 1024
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2 * 60 * 60 * 1000) throw new Error("AI upscale timeout is invalid.");
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 2 * 1024 * 1024 * 1024) throw new Error("AI upscale output limit is invalid.");

  async function probe(model) {
    const selected = String(model || "realesrgan-x4plus");
    const binaryReady = await regularFile(binaryPath, "binary");
    const modelReady = MODELS.has(selected) && await regularFile(resolve(modelDirectory || ".", selected + ".param")) &&
      await regularFile(resolve(modelDirectory || ".", selected + ".bin"));
    return {
      engine: "realesrgan-ncnn-vulkan",
      available: binaryReady && modelReady,
      binaryReady,
      modelReady,
      model: selected,
      executionEnabled: false,
      reason: !binaryReady ? "Configure a readable NCNN/Vulkan executable." : !modelReady ? "The selected allowlisted model files are not installed." : "Ready for an explicitly approved image job."
    };
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
    if (!readiness.available) throw fail(readiness.reason, "AI_UPSCALE_ENGINE_UNAVAILABLE");
    const input = resolve(options.inputPath), output = resolve(options.outputPath);
    if (!(await regularFile(input))) throw fail("AI upscale input must be an existing regular file.", "AI_UPSCALE_INVALID_INPUT");
    try { await lstat(output); throw fail("AI upscale output already exists; source files are never overwritten.", "AI_UPSCALE_OUTPUT_EXISTS"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(output) === input || output.startsWith(input + sep)) throw fail("AI upscale output path is invalid.", "AI_UPSCALE_INVALID_PATH");
    await run(prepared.binary, prepared.args, timeoutMs, options.signal);
    const info = await stat(output).catch(() => null);
    if (!info?.isFile() || info.size < 24 || info.size > maxOutputBytes) throw fail("AI upscale output is missing, empty or exceeds the configured size limit.", "AI_UPSCALE_OUTPUT_INVALID");
    await validateImageOutput(output, prepared.format);
    return { path: output, byteSize: info.size, model: prepared.model, scale: prepared.scale, tile: prepared.tile, format: prepared.format, engine: "realesrgan-ncnn-vulkan", method: "ai-super-resolution" };
  }

  return Object.freeze({ probe, plan, execute });
}
