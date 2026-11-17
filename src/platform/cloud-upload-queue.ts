export const MAX_CLOUD_UPLOAD_FILES = 50;
export const MAX_CLOUD_UPLOAD_BYTES = 50 * 1024 * 1024;
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
};
export type RejectedCloudUpload<T extends CloudUploadFileLike> = { file: T; reason: string };

export function validateCloudUploadFiles<T extends CloudUploadFileLike>(files: readonly T[]) {
  const accepted: T[] = [];
  const rejected: RejectedCloudUpload<T>[] = [];
  for (const [index, file] of files.entries()) {
    if (index >= MAX_CLOUD_UPLOAD_FILES) {
      rejected.push({ file, reason: "A batch can contain at most 50 files." });
    } else if (!Number.isSafeInteger(file.size) || file.size < 1) {
      rejected.push({ file, reason: "The file is empty or has an invalid size." });
    } else if (file.size > MAX_CLOUD_UPLOAD_BYTES) {
      rejected.push({ file, reason: "The file exceeds the 50 MiB per-file limit." });
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
  upload: (file: T, signal: AbortSignal) => Promise<unknown>,
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
      update(index, { status: "uploading", error: undefined });
      try {
        await upload(results[index].file, options.signal);
        update(index, options.signal.aborted
          ? { status: "cancelled", error: "Upload cancelled." }
          : { status: "succeeded", error: undefined });
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
