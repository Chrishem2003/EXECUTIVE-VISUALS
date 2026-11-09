import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fail = (message, code = "AI_UPSCALE_LPIPS_FAILED") => Object.assign(new Error(message), { code });
const DEFAULT_MAX_PIXELS = 8_294_400;
const HARD_MAX_PIXELS = 16_000_000;

async function validateImageFile(path, label) {
  if (typeof path !== "string" || !path.trim()) throw fail(label + " image path is required.", "AI_UPSCALE_LPIPS_INVALID");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw fail(label + " must be a regular non-symlink file.", "AI_UPSCALE_LPIPS_INVALID");
  if (info.size < 1 || info.size > 250 * 1024 * 1024) throw fail(label + " is empty or exceeds the 250 MiB limit.", "AI_UPSCALE_LPIPS_LIMIT");
}

function runBounded(binary, args, { timeoutMs, maxBytes, signal, env, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    const stdout = [];
    let stdoutBytes = 0, stderr = "", settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString("utf8"));
    };
    const abort = () => { child.kill("SIGKILL"); finish(fail("LPIPS assessment was cancelled.", "JOB_CANCELLED")); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(fail("LPIPS assessment timed out.", "AI_UPSCALE_LPIPS_TIMEOUT")); }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) { child.kill("SIGKILL"); finish(fail("LPIPS output exceeded its bounded response size.", "AI_UPSCALE_LPIPS_LIMIT")); }
      else stdout.push(chunk);
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
    child.once("error", () => finish(fail("LPIPS Python runtime could not start.", "AI_UPSCALE_LPIPS_UNAVAILABLE")));
    child.once("close", code => {
      if (settled) return;
      if (code !== 0) finish(fail("LPIPS worker failed: " + stderr.slice(-1200), "AI_UPSCALE_LPIPS_UNAVAILABLE"));
      else finish();
    });
  });
}

/**
 * Offline-only LPIPS adapter. It requires a pre-provisioned Python environment,
 * the lpips/torch/Pillow packages, and cached backbone weights. It never downloads
 * model weights and only computes paired, same-resolution reference comparisons.
 */
export function createLpipsPerceptualAssessor({
  pythonPath = process.env.AI_UPSCALE_LPIPS_PYTHON || process.env.PYTHON || "python3",
  scriptPath = fileURLToPath(new URL("./scripts/lpips_assess.py", import.meta.url)),
  network = "alex",
  device = "auto",
  maxPixels = DEFAULT_MAX_PIXELS,
  threads = 1,
  timeoutMs = 120_000,
  spawnProcess = spawn
} = {}) {
  if (typeof pythonPath !== "string" || !pythonPath.trim()) throw new TypeError("A Python executable is required.");
  if (!["alex", "vgg", "squeeze"].includes(network)) throw new TypeError("LPIPS network must be alex, vgg or squeeze.");
  if (!["auto", "cpu", "cuda"].includes(device)) throw new TypeError("LPIPS device must be auto, cpu or cuda.");
  if (!Number.isInteger(maxPixels) || maxPixels < 1 || maxPixels > HARD_MAX_PIXELS) throw new TypeError("LPIPS pixel limit exceeds the supported safety budget.");
  if (!Number.isInteger(threads) || threads < 1 || threads > 8) throw new TypeError("LPIPS thread count must be from 1 to 8.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw new TypeError("LPIPS timeout must be from 1 to 300 seconds.");

  return Object.freeze({
    async assess({ candidatePath, referencePath, signal } = {}) {
      if (!referencePath) throw fail("LPIPS requires a paired reference image.", "AI_UPSCALE_LPIPS_REFERENCE_REQUIRED");
      await validateImageFile(candidatePath, "Candidate");
      await validateImageFile(referencePath, "Reference");
      const output = await runBounded(pythonPath, [
        scriptPath, "--candidate", candidatePath, "--reference", referencePath,
        "--net", network, "--device", device, "--max-pixels", String(maxPixels),
        "--threads", String(threads)
      ], {
        timeoutMs, maxBytes: 64 * 1024, signal, spawnProcess,
        env: { ...process.env, PYTHONUNBUFFERED: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }
      });
      let result;
      try { result = JSON.parse(output); }
      catch { throw fail("LPIPS worker returned invalid JSON.", "AI_UPSCALE_LPIPS_PROTOCOL"); }
      if (result?.ok !== true || result.metric !== "LPIPS" || result.version !== "0.1" ||
          result.network !== network || !["cpu", "cuda"].includes(result.device) || !Number.isFinite(result.distance) || result.distance < 0 ||
          !Number.isInteger(result.width) || !Number.isInteger(result.height) ||
          result.width < 64 || result.height < 64 || result.width * result.height > maxPixels ||
          result.modelDownloadsAllowed !== false) {
        throw fail("LPIPS worker returned an invalid or unsupported assessment.", "AI_UPSCALE_LPIPS_PROTOCOL");
      }
      return Object.freeze({
        metric: "LPIPS",
        version: result.version,
        network: result.network,
        device: result.device,
        distance: result.distance,
        width: result.width,
        height: result.height,
        interpretation: "lower_is_more_perceptually_similar",
        modelDownloadsAllowed: false
      });
    }
  });
}
