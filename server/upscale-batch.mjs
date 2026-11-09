import { resolve } from "node:path";

const MAX_BATCH_ITEMS = 100;
const MAX_CONCURRENCY = 4;
const fail = (message, code = "AI_UPSCALE_BATCH_INVALID") => Object.assign(new Error(message), { code });

const ITEM_OPTIONS = Object.freeze(["model", "scale", "tile", "format", "threads", "tta", "gpu"]);

function validateBatch(items, concurrency, maxItems) {
  if (!Array.isArray(items) || items.length < 1 || items.length > maxItems) {
    throw fail("Batch must contain between 1 and " + maxItems + " items.");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw fail("Batch concurrency must be an integer from 1 to " + MAX_CONCURRENCY + ".");
  }
  const ids = new Set();
  const outputs = new Set();
  const normalized = items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw fail("Every batch item must be an object.");
    const id = item.id ?? "item-" + (index + 1);
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) || ids.has(id)) {
      throw fail("Batch item IDs must be safe and unique.");
    }
    ids.add(id);
    if (typeof item.inputPath !== "string" || !item.inputPath.trim() ||
        typeof item.outputPath !== "string" || !item.outputPath.trim()) {
      throw fail("Every batch item needs an inputPath and outputPath.");
    }
    const inputPath = resolve(item.inputPath);
    const outputPath = resolve(item.outputPath);
    if (inputPath === outputPath) throw fail("Batch outputs must never overwrite their source inputs.");
    if (outputs.has(outputPath)) throw fail("Batch output paths must be unique.");
    outputs.add(outputPath);
    const options = {};
    for (const key of ITEM_OPTIONS) {
      if (item[key] !== undefined) options[key] = item[key];
    }
    return Object.freeze({ id, inputPath, outputPath, options });
  });
  const inputPaths = new Set(normalized.map(item => item.inputPath));
  if (normalized.some(item => inputPaths.has(item.outputPath))) {
    throw fail("A batch output cannot overwrite any input in the same batch.");
  }
  return normalized;
}

/**
 * Bounded, provenance-preserving orchestration for the existing single-image
 * adapter. It does not invent a second inference path: every item passes
 * through adapter.execute and inherits its validation, hashing and cleanup.
 */
export function createUpscaleBatchProcessor({
  adapter,
  defaultConcurrency = 1,
  maxItems = MAX_BATCH_ITEMS
} = {}) {
  if (!adapter || typeof adapter.execute !== "function") {
    throw new TypeError("A configured AI upscaling adapter with execute() is required.");
  }
  if (!Number.isInteger(defaultConcurrency) || defaultConcurrency < 1 || defaultConcurrency > MAX_CONCURRENCY) {
    throw new TypeError("Default batch concurrency must be from 1 to " + MAX_CONCURRENCY + ".");
  }
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_BATCH_ITEMS) {
    throw new TypeError("Batch item limit must be from 1 to " + MAX_BATCH_ITEMS + ".");
  }

  async function process({ items, concurrency = defaultConcurrency, signal, onProgress } = {}) {
    const batch = validateBatch(items, concurrency, maxItems);
    const results = new Array(batch.length);
    let cursor = 0;
    let completed = 0;
    const reportProgress = (item, status) => {
      completed++;
      if (typeof onProgress === "function") {
        try {
          onProgress(Object.freeze({ completed, total: batch.length, itemId: item.id, status }));
        } catch { /* Progress observers cannot change processing outcomes. */ }
      }
    };

    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= batch.length) return;
        const item = batch[index];
        if (signal?.aborted) {
          results[index] = { id: item.id, status: "cancelled", code: "JOB_CANCELLED" };
          reportProgress(item, "cancelled");
          continue;
        }
        try {
          const result = await adapter.execute({
            inputPath: item.inputPath,
            outputPath: item.outputPath,
            ...item.options,
            signal
          });
          results[index] = {
            id: item.id,
            status: "succeeded",
            outputPath: result.path ?? item.outputPath,
            sourceSha256: result.sourceSha256 ?? null,
            outputSha256: result.outputSha256 ?? null,
            inputDimensions: result.inputDimensions ?? null,
            outputDimensions: result.outputDimensions ?? null,
            model: result.model ?? item.options.model ?? null,
            scale: result.scale ?? item.options.scale ?? null,
            qualityAssessment: result.qualityAssessment ?? { status: "not_assessed", method: null },
            // No trusted perceptual assessor is connected yet; keep the review gate closed.
            qualityReviewRequired: true
          };
        } catch (error) {
          results[index] = {
            id: item.id,
            status: signal?.aborted ? "cancelled" : "failed",
            code: error?.code || (signal?.aborted ? "JOB_CANCELLED" : "AI_UPSCALE_PROCESS_FAILED"),
            error: String(error?.message || "AI upscaling failed.").slice(0, 500)
          };
        } finally {
          reportProgress(item, results[index].status);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, () => worker()));
    const succeeded = results.filter(item => item?.status === "succeeded").length;
    const failed = results.filter(item => item?.status === "failed").length;
    const cancelled = results.filter(item => item?.status === "cancelled").length;
    return Object.freeze({
      status: cancelled ? "cancelled" : failed ? "partial" : "completed",
      total: batch.length,
      succeeded,
      failed,
      cancelled,
      qualityReviewRequired: results.some(item => item?.status === "succeeded" && item.qualityReviewRequired),
      results: Object.freeze(results)
    });
  }

  return Object.freeze({ process, maxItems, maxConcurrency: MAX_CONCURRENCY });
}
