import { ApiError, apiRequest } from "../core/api";

type UploadSession = {
  id: string;
  assetId: string;
  status: "active" | "completing" | "completed" | "aborted" | "expired" | "failed";
  size: number;
  sha256: string;
  partSize: number;
  partCount: number;
  parts?: Array<{ partNumber: number; etag: string; sha256: string; size: number }>;
};
type SessionResponse = { session: UploadSession; idempotentReplay?: boolean };
type PartUrlResponse = { url: string; method: "PUT"; partNumber: number; size: number; expiresInSeconds: number };
type ResumeRecord = {
  key: string;
  sessionId: string;
  projectId: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  sha256: string;
};
const STORAGE_KEY = "executive-visuals:b2-upload-resume:v1";
const SMALL_UPLOAD_LIMIT = 50 * 1024 * 1024;

function resumeKey(file: File, projectId: string): string {
  return [projectId, file.name, file.size, file.lastModified, file.type].join("|");
}
function readResumeRecords(): ResumeRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.key === "string" && typeof item.sessionId === "string") : [];
  } catch { return []; }
}
function saveResumeRecord(record: ResumeRecord): void {
  const records = readResumeRecords().filter(item => item.key !== record.key);
  records.push(record);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-50))); } catch { /* Session remains recoverable from the server if storage is unavailable. */ }
}
function removeResumeRecord(key: string): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(readResumeRecords().filter(item => item.key !== key))); } catch { /* Best-effort local cleanup. */ }
}
async function sha256(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure browser cryptography is required for resumable uploads.");
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
function putPart(url: string, blob: Blob, signal: AbortSignal, onProgress: (loaded: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (error?: Error, etag?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve(etag || "");
    };
    const abort = () => { try { xhr.abort(); } catch {} finish(new Error("Upload cancelled.")); };
    if (signal.aborted) { finish(new Error("Upload cancelled.")); return; }
    xhr.open("PUT", url, true);
    xhr.withCredentials = false;
    xhr.timeout = 15 * 60 * 1000;
    xhr.upload.onprogress = event => onProgress(Math.min(blob.size, event.loaded));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) { finish(new Error("B2 part upload failed (HTTP " + xhr.status + ").")); return; }
      const etag = xhr.getResponseHeader("ETag") || xhr.getResponseHeader("etag") || "";
      if (!etag) { finish(new Error("B2 did not expose the part ETag. Check the private bucket CORS ExposeHeader setting for ETag.")); return; }
      finish(undefined, etag.replace(/^"|"$/g, ""));
    };
    xhr.onerror = () => finish(new Error("Network error while uploading a B2 part. Retry to resume."));
    xhr.ontimeout = () => finish(new Error("B2 part upload timed out. Retry to resume."));
    xhr.onabort = () => finish(new Error("Upload cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(blob);
  });
}

export async function uploadCloudAssetResumable(
  file: File,
  projectId: string,
  signal: AbortSignal,
  onProgress: (uploadedBytes: number, totalBytes: number) => void
): Promise<void> {
  if (file.size <= SMALL_UPLOAD_LIMIT) throw new Error("Resumable multipart upload is reserved for files larger than 50 MiB.");
  if (!projectId) throw new Error("Select a cloud project before uploading.");
  if (file.size < 5_000_000) throw new Error("B2 multipart uploads require files of at least 5 MB.");
  const digest = await sha256(file);
  const key = resumeKey(file, projectId);
  const record = readResumeRecords().find(item => item.key === key && item.projectId === projectId && item.sha256 === digest);
  let session: UploadSession | null = null;
  if (record) {
    try {
      const existing = await apiRequest<SessionResponse>("/api/cloud/uploads/" + encodeURIComponent(record.sessionId));
      session = existing.session;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "B2_MULTIPART_SESSION_NOT_FOUND") throw error;
      removeResumeRecord(key);
    }
  }
  if (session && ["aborted", "expired", "failed"].includes(session.status)) {
    removeResumeRecord(key);
    session = null;
  }
  if (!session) {
    const started = await apiRequest<SessionResponse>("/api/cloud/uploads", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ projectId, originalName: file.name, mediaType: file.type, size: file.size, sha256: digest })
    });
    session = started.session;
    saveResumeRecord({ key, sessionId: session.id, projectId, name: file.name, size: file.size, type: file.type, lastModified: file.lastModified, sha256: digest });
  }
  if (session.sha256 !== digest || session.size !== file.size) throw new Error("The selected file does not match the saved upload session.");
  if (session.status === "completed") {
    removeResumeRecord(key);
    onProgress(file.size, file.size);
    return;
  }
  const refreshed = await apiRequest<SessionResponse>("/api/cloud/uploads/" + encodeURIComponent(session.id));
  session = refreshed.session;
  const completed = new Map((session.parts || []).map(part => [part.partNumber, part]));
  let uploadedBytes = 0;
  for (let partNumber = 1; partNumber <= session.partCount; partNumber++) {
    if (signal.aborted) throw new Error("Upload cancelled.");
    const start = (partNumber - 1) * session.partSize;
    const end = Math.min(file.size, start + session.partSize);
    const chunk = file.slice(start, end);
    const chunkHash = await sha256(chunk);
    const saved = completed.get(partNumber);
    if (saved) {
      if (saved.size !== chunk.size || saved.sha256 !== chunkHash) throw new Error("A saved upload part does not match the selected source file.");
      uploadedBytes += chunk.size;
      onProgress(uploadedBytes, file.size);
      continue;
    }
    const signed = await apiRequest<PartUrlResponse>("/api/cloud/uploads/" + encodeURIComponent(session.id) + "/parts/" + partNumber + "/url", { method: "POST" });
    const etag = await putPart(signed.url, chunk, signal, loaded => onProgress(uploadedBytes + loaded, file.size));
    await apiRequest("/api/cloud/uploads/" + encodeURIComponent(session.id) + "/parts/" + partNumber + "/receipt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ etag, sha256: chunkHash, size: chunk.size })
    });
    uploadedBytes += chunk.size;
    onProgress(uploadedBytes, file.size);
  }
  if (signal.aborted) {
    await apiRequest("/api/cloud/uploads/" + encodeURIComponent(session.id) + "/abort", { method: "POST" }).catch(() => {});
    removeResumeRecord(key);
    throw new Error("Upload cancelled.");
  }
  await apiRequest("/api/cloud/uploads/" + encodeURIComponent(session.id) + "/complete", { method: "POST" });
  removeResumeRecord(key);
  onProgress(file.size, file.size);
}
