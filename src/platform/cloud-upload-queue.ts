export const MAX_CLOUD_UPLOAD_FILES = 50;
export const MAX_CLOUD_UPLOAD_BYTES = 250 * 1024 * 1024;
export const DEFAULT_CLOUD_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_CLOUD_UPLOAD_CONCURRENCY = 3;

const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime", "video/x-matroska",
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/ogg",
  "application/pdf", "text/plain"
]);

export type CloudUploadFileLike = { name: string; size: number; type: string };
export type CloudUploadStatus = "queued" | "uploading" | "succeeded" | "failed" | "cancelled";
export type CloudUploadItem<T extends CloudUploadFileLike> = {
  id: string;
  file: T;
  status: CloudUploadStatus;
  error?: string;
  progress?: number;
  uploadedBytes?: number;
  totalBytes?: number;
};
export type RejectedCloudUpload<T extends CloudUploadFileLike> = { file: T; reason: string };

export function validateCloudUploadFiles<T extends CloudUploadFileLike>(files: readonly T[], configuredMaxBytes = DEFAULT_CLOUD_UPLOAD_BYTES) {
  const maxBytes = Number.isSafeInteger(configuredMaxBytes) ? Math.max(1, Math.min(MAX_CLOUD_UPLOAD_BYTES, configuredMaxBytes)) : DEFAULT_CLOUD_UPLOAD_BYTES;
  const accepted: T[] = [];
  const rejected: RejectedCloudUpload<T>[] = [];
  for (const [index, file] of files.entries()) {
    if (index >= MAX_CLOUD_UPLOAD_FILES) {
      rejected.push({ file, reason: "A batch can contain at most 50 files." });
    } else if (!Number.isSafeInteger(file.size) || file.size < 1) {
      rejected.push({ file, reason: "The file is empty or has an invalid size." });
    } else if (file.size > maxBytes) {
      rejected.push({ file, reason: "The file exceeds the " + Math.floor(maxBytes / 1024 / 1024) + " MiB per-file limit configured for this storage provider." });
    } else if (!ALLOWED_TYPES.has(String(file.type || "").toLowerCase())) {
      rejected.push({ file, reason: "This file type is not supported for private cloud upload." });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}

export async function runCloudUploadQueue<T extends CloudUploadFileLike>(
  items: readonly CloudUploadItem<T>[],
  upload: (file: T, signal: AbortSignal, onProgress: (uploadedBytes: number, totalBytes: number) => void) => Promise<unknown>,
  options: {
    signal: AbortSignal;
    concurrency?: number;
    onUpdate?: (item: CloudUploadItem<T>) => void;
  }
): Promise<CloudUploadItem<T>[]> {
  const concurrency = Math.max(1, Math.min(
    MAX_CLOUD_UPLOAD_CONCURRENCY,
    Math.floor(options.concurrency ?? MAX_CLOUD_UPLOAD_CONCURRENCY)
  ));
  const results = items.map(item => ({ ...item }));
  let cursor = 0;
  const update = (index: number, patch: Partial<CloudUploadItem<T>>) => {
    results[index] = { ...results[index], ...patch };
    options.onUpdate?.(results[index]);
  };
  async function worker() {
    while (cursor < results.length) {
      const index = cursor++;
      if (options.signal.aborted) {
        update(index, { status: "cancelled", error: "Upload cancelled." });
        continue;
      }
      update(index, { status: "uploading", error: undefined, progress: 0, uploadedBytes: 0, totalBytes: results[index].file.size });
      try {
        await upload(results[index].file, options.signal, (uploadedBytes, totalBytes) => {
          const safeTotal = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : results[index].file.size;
          const safeUploaded = Math.max(0, Math.min(safeTotal, Number.isFinite(uploadedBytes) ? uploadedBytes : 0));
          update(index, { uploadedBytes: safeUploaded, totalBytes: safeTotal, progress: Math.round(safeUploaded / safeTotal * 100) });
        });
        update(index, options.signal.aborted
          ? { status: "cancelled", error: "Upload cancelled." }
          : { status: "succeeded", error: undefined, progress: 100, uploadedBytes: results[index].file.size, totalBytes: results[index].file.size });
      } catch (error) {
        update(index, options.signal.aborted
          ? { status: "cancelled", error: "Upload cancelled." }
          : { status: "failed", error: error instanceof Error ? error.message.slice(0, 300) : "Private cloud upload failed." });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, results.length) }, () => worker()));
  return results;
}
