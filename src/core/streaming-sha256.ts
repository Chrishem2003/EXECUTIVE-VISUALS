import { sha256 } from "@noble/hashes/sha2.js";

const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const MIN_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

export type Sha256BlobOptions = {
  signal?: AbortSignal;
  chunkBytes?: number;
  onProgress?: (processedBytes: number, totalBytes: number) => void;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Checksum calculation cancelled.");
  error.name = "AbortError";
  throw error;
}

/**
 * Hash a Blob incrementally so large media files never need to be copied into
 * one giant ArrayBuffer. Memory use is bounded by chunkBytes.
 */
export async function sha256Blob(blob: Blob, options: Sha256BlobOptions = {}): Promise<string> {
  if (!blob || typeof blob.size !== "number" || typeof blob.slice !== "function") {
    throw new TypeError("A browser Blob or File is required for SHA-256.");
  }
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < MIN_CHUNK_BYTES || chunkBytes > MAX_CHUNK_BYTES) {
    throw new RangeError("SHA-256 chunk size must be between 64 KiB and 32 MiB.");
  }

  const digest = sha256.create();
  let processedBytes = 0;
  while (processedBytes < blob.size) {
    throwIfAborted(options.signal);
    const end = Math.min(blob.size, processedBytes + chunkBytes);
    const bytes = new Uint8Array(await blob.slice(processedBytes, end).arrayBuffer());
    digest.update(bytes);
    processedBytes = end;
    options.onProgress?.(processedBytes, blob.size);
  }
  throwIfAborted(options.signal);
  return Array.from(digest.digest(), byte => byte.toString(16).padStart(2, "0")).join("");
}
