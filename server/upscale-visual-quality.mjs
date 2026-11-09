import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";

const DEFAULT_MAX_PIXELS = 40_000_000;
const DEFAULT_MAX_BYTES = DEFAULT_MAX_PIXELS * 3;
const fail = (message, code = "AI_UPSCALE_QUALITY_INVALID") => Object.assign(new Error(message), { code });

function safeDimensions(width, height, maxPixels) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width * height > maxPixels || width * height * 3 > DEFAULT_MAX_BYTES) {
    throw fail("Decoded image dimensions are invalid or exceed the quality-assessment pixel budget.", "AI_UPSCALE_QUALITY_LIMIT");
  }
  return { width, height };
}

function lumaAt(rgb, width, x, y) {
  const offset = (y * width + x) * 3;
  return 0.2126 * rgb[offset] + 0.7152 * rgb[offset + 1] + 0.0722 * rgb[offset + 2];
}

function seamBoundary(rgb, width, height, axis, position, options) {
  const span = axis === "vertical" ? height : width;
  const at = axis === "vertical"
    ? (x, i) => lumaAt(rgb, width, x, i)
    : (y, i) => lumaAt(rgb, width, i, y);
  let tested = 0, anomalous = 0, edgeSum = 0, baselineSum = 0;
  const stride = Math.max(1, Math.floor(span / 2048));
  for (let i = 0; i < span; i += stride) {
    const edge = Math.abs(at(position, i) - at(position - 1, i));
    const left = Math.abs(at(position - 2, i) - at(position - 3, i));
    const right = Math.abs(at(position + 1, i) - at(position + 2, i));
    const baseline = (left + right) / 2;
    tested++;
    edgeSum += edge;
    baselineSum += baseline;
    if (edge >= options.minimumEdge && edge > baseline * options.edgeRatio + options.edgeOffset) anomalous++;
  }
  const ratio = tested ? anomalous / tested : 0;
  return {
    axis, position, samples: tested, anomalousSamples: anomalous,
    anomalyRatio: Number(ratio.toFixed(6)),
    meanBoundaryGradient: Number((edgeSum / Math.max(1, tested)).toFixed(4)),
    meanNeighbourGradient: Number((baselineSum / Math.max(1, tested)).toFixed(4)),
    flagged: tested >= 8 && ratio >= options.minimumAnomalyRatio
  };
}

export function analyzeUpscalePixels({
  rgb, width, height, referenceRgb, referenceWidth, referenceHeight, tileSize = 256, seam = {}
} = {}) {
  const dimensions = safeDimensions(width, height, DEFAULT_MAX_PIXELS);
  if (!Buffer.isBuffer(rgb) && !(rgb instanceof Uint8Array)) throw fail("Candidate RGB pixels are required.");
  if (rgb.byteLength !== dimensions.width * dimensions.height * 3) throw fail("Candidate RGB byte length does not match its dimensions.");
  if (!Number.isInteger(tileSize) || tileSize < 32 || tileSize > 2048) throw fail("Tile size must be an integer from 32 to 2048.");
  const options = {
    minimumEdge: seam.minimumEdge ?? 18,
    edgeRatio: seam.edgeRatio ?? 3,
    edgeOffset: seam.edgeOffset ?? 6,
    minimumAnomalyRatio: seam.minimumAnomalyRatio ?? 0.15
  };
  if (![options.minimumEdge, options.edgeRatio, options.edgeOffset, options.minimumAnomalyRatio].every(Number.isFinite) ||
      options.minimumEdge < 0 || options.edgeRatio < 0 || options.edgeOffset < 0 ||
      options.minimumAnomalyRatio < 0 || options.minimumAnomalyRatio > 1) throw fail("Seam detector thresholds are invalid.");

  const boundaries = [];
  for (let x = tileSize; x <= width - 4; x += tileSize) boundaries.push(seamBoundary(rgb, width, height, "vertical", x, options));
  for (let y = tileSize; y <= height - 4; y += tileSize) boundaries.push(seamBoundary(rgb, width, height, "horizontal", y, options));
  const flagged = boundaries.filter(item => item.flagged);
  const result = {
    status: flagged.length ? "needs_review" : "no_seam_anomaly_detected",
    method: "pixel-gradient-seam-analysis",
    algorithmVersion: "1.0.0",
    dimensions,
    seamAnalysis: {
      tileSize, boundariesChecked: boundaries.length, flaggedBoundaries: flagged.length,
      maximumAnomalyRatio: boundaries.reduce((max, item) => Math.max(max, item.anomalyRatio), 0),
      boundaries
    },
    referenceMetrics: null,
    limitations: [
      "Seam analysis is a deterministic pixel-gradient heuristic, not a trained artifact classifier.",
      "Absence of a detected seam is not proof that the image is artifact-free.",
      "Learned perceptual quality (LPIPS) is not computed by this local pixel analyzer."
    ]
  };

  if (referenceRgb !== undefined || referenceWidth !== undefined || referenceHeight !== undefined) {
    const refDimensions = safeDimensions(referenceWidth, referenceHeight, DEFAULT_MAX_PIXELS);
    if (refDimensions.width !== dimensions.width || refDimensions.height !== dimensions.height) throw fail("Reference and candidate must have identical dimensions for paired quality metrics.");
    if ((!Buffer.isBuffer(referenceRgb) && !(referenceRgb instanceof Uint8Array)) ||
        referenceRgb.byteLength !== refDimensions.width * refDimensions.height * 3) throw fail("Reference RGB byte length does not match its dimensions.");
    let squaredError = 0;
    const count = dimensions.width * dimensions.height * 3;
    for (let i = 0; i < count; i++) { const delta = rgb[i] - referenceRgb[i]; squaredError += delta * delta; }
    const mse = squaredError / count;
    const psnr = mse === 0 ? null : 10 * Math.log10((255 * 255) / mse);
    let meanX = 0, meanY = 0;
    for (let i = 0; i < count; i++) { meanX += referenceRgb[i]; meanY += rgb[i]; }
    meanX /= count; meanY /= count;
    let varianceX = 0, varianceY = 0, covariance = 0;
    for (let i = 0; i < count; i++) {
      const dx = referenceRgb[i] - meanX, dy = rgb[i] - meanY;
      varianceX += dx * dx; varianceY += dy * dy; covariance += dx * dy;
    }
    varianceX /= count; varianceY /= count; covariance /= count;
    const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
    const ssimGlobal = ((2 * meanX * meanY + c1) * (2 * covariance + c2)) /
      ((meanX * meanX + meanY * meanY + c1) * (varianceX + varianceY + c2));
    result.referenceMetrics = {
      psnrDb: psnr === null ? null : Number(psnr.toFixed(6)),
      identical: mse === 0, ssimGlobal: Number(ssimGlobal.toFixed(8)),
      method: "global_rgb_ssim", lpips: null
    };
  }
  return result;
}

function runBounded(binary, args, { maxBytes, timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let outputBytes = 0, errorText = "", settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve({ stdout: Buffer.concat(stdout), stderr: errorText });
    };
    const abort = () => { child.kill("SIGKILL"); finish(fail("Image quality analysis was cancelled.", "JOB_CANCELLED")); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(fail("Image quality analysis timed out.", "AI_UPSCALE_QUALITY_TIMEOUT")); }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) { child.kill("SIGKILL"); finish(fail("Decoded image exceeded the bounded memory budget.", "AI_UPSCALE_QUALITY_LIMIT")); }
      else stdout.push(chunk);
    });
    child.stderr.on("data", chunk => { errorText = (errorText + chunk.toString()).slice(-2000); });
    child.once("error", () => finish(fail("Image decoder executable could not start.", "AI_UPSCALE_DECODER_UNAVAILABLE")));
    child.once("close", code => code === 0 ? finish() : finish(fail("Image decoder failed: " + errorText.slice(-800), "AI_UPSCALE_DECODE_FAILED")));
  });
}

export function createFfmpegImageDecoder({
  ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath = process.env.FFPROBE_PATH || "ffprobe",
  maxPixels = DEFAULT_MAX_PIXELS,
  timeoutMs = 30_000
} = {}) {
  if (!Number.isInteger(maxPixels) || maxPixels < 1 || maxPixels > DEFAULT_MAX_PIXELS) throw new TypeError("maxPixels exceeds the supported safety budget.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new TypeError("timeoutMs is outside the supported range.");
  return Object.freeze({
    async decode(path, { signal } = {}) {
      if (typeof path !== "string" || !path.trim()) throw fail("Image path is required.");
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw fail("Image must be a regular non-symlink file.", "AI_UPSCALE_INPUT_INVALID");
      if (info.size < 1 || info.size > 250 * 1024 * 1024) throw fail("Image file is empty or exceeds the 250 MiB quality-analysis limit.", "AI_UPSCALE_QUALITY_LIMIT");
      const probe = await runBounded(ffprobePath, ["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json",path], { maxBytes: 64*1024, timeoutMs, signal });
      let parsed;
      try { parsed = JSON.parse(probe.stdout.toString("utf8")); } catch { throw fail("Image decoder returned invalid dimensions.", "AI_UPSCALE_DECODE_FAILED"); }
      const stream = parsed?.streams?.[0];
      const dimensions = safeDimensions(Number(stream?.width), Number(stream?.height), maxPixels);
      const decoded = await runBounded(ffmpegPath, ["-v","error","-i",path,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"], {
        maxBytes: dimensions.width * dimensions.height * 3, timeoutMs, signal
      });
      if (decoded.stdout.length !== dimensions.width * dimensions.height * 3) throw fail("Decoded image byte count does not match probed dimensions.", "AI_UPSCALE_DECODE_FAILED");
      return { ...dimensions, rgb: decoded.stdout };
    }
  });
}

export function createUpscaleVisualQualityAssessor({ decoder = createFfmpegImageDecoder(), lpipsAssessor = null } = {}) {
  if (!decoder || typeof decoder.decode !== "function") throw new TypeError("An image decoder with decode() is required.");
  if (lpipsAssessor !== null && typeof lpipsAssessor.assess !== "function") throw new TypeError("The optional LPIPS assessor must provide assess().");
  return Object.freeze({
    async assess({ candidatePath, referencePath, tileSize = 256, signal } = {}) {
      const candidate = await decoder.decode(candidatePath, { signal });
      const reference = referencePath ? await decoder.decode(referencePath, { signal }) : null;
      const report = analyzeUpscalePixels({
        rgb: candidate.rgb, width: candidate.width, height: candidate.height,
        referenceRgb: reference?.rgb, referenceWidth: reference?.width, referenceHeight: reference?.height, tileSize
      });
      report.perceptualAssessment = { status: "not_run", method: "LPIPS", reason: "paired_reference_and_configured_assessor_required" };
      if (reference && lpipsAssessor) {
        try {
          const result = await lpipsAssessor.assess({ candidatePath, referencePath, signal });
          report.perceptualAssessment = {
            status: "completed", method: "LPIPS", version: result.version,
            network: result.network, device: result.device, distance: result.distance,
            interpretation: "lower_is_more_perceptually_similar"
          };
          report.referenceMetrics.lpips = result.distance;
          report.referenceMetrics.lpipsNetwork = result.network;
          report.referenceMetrics.lpipsVersion = result.version;
        } catch (error) {
          report.perceptualAssessment = {
            status: "unavailable", method: "LPIPS",
            code: error?.code || "AI_UPSCALE_LPIPS_FAILED"
          };
        }
      }
      return report;
    }
  });
}