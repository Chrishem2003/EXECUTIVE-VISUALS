import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const DEFAULT_BUCKET = "executive-visuals-media";
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime", "video/x-matroska",
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/ogg",
  "application/pdf", "text/plain", "text/vtt", "application/json"
]);

function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, char => "%" + char.charCodeAt(0).toString(16).toUpperCase());
}

function safeObjectPath(value) {
  if (typeof value !== "string" || value.length > 1024 || value.startsWith("/") || value.includes("\\")) {
    throw new Error("Neon object path is invalid.");
  }
  const parts = value.split("/");
  if (parts.length < 2 || parts.length > 12 || !UUID.test(parts[0]) ||
      parts.some(part => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]{1,180}$/.test(part))) {
    throw new Error("Neon object path must begin with a user or project UUID and contain safe path segments.");
  }
  return parts.map(awsEncode).join("/");
}

function safeBucket(value) {
  const bucket = String(value || DEFAULT_BUCKET).trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new Error("NEON_STORAGE_BUCKET is invalid.");
  }
  return bucket;
}

function hmac(key, value, encoding) {
  const result = createHmac("sha256", key).update(value, "utf8");
  return encoding ? result.digest(encoding) : result.digest();
}

function signingKey(secret, date, region) {
  const dateKey = hmac("AWS4" + secret, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function canonicalQuery(entries) {
  return [...entries]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => key + "=" + value)
    .join("&");
}

function endpointOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("NEON_STORAGE_ENDPOINT must be a valid absolute URL."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("NEON_STORAGE_ENDPOINT must be an HTTPS origin without credentials, path, query or fragment.");
  }
  return parsed.origin;
}

export function createNeonObjectStorage({
  endpoint = process.env.NEON_STORAGE_ENDPOINT || process.env.AWS_ENDPOINT_URL_S3,
  region = process.env.NEON_STORAGE_REGION || process.env.AWS_REGION,
  accessKeyId = process.env.NEON_STORAGE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey = process.env.NEON_STORAGE_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
  bucket = process.env.NEON_STORAGE_BUCKET || DEFAULT_BUCKET,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  maxBytes = 250 * 1024 * 1024,
  clock = () => new Date()
} = {}) {
  const base = endpointOrigin(String(endpoint || "").trim());
  const signingRegion = String(region || "").trim().toLowerCase();
  const keyId = String(accessKeyId || "").trim();
  const secret = String(secretAccessKey || "");
  const bucketName = safeBucket(bucket);
  if (!/^[a-z0-9]+-[a-z0-9]+-\\d$/.test(signingRegion)) throw new Error("NEON_STORAGE_REGION must be a Neon Object Storage region such as us-east-2.");
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(keyId) || secret.length < 16 || secret.length > 512) {
    throw new Error("Neon Object Storage credentials are missing or invalid.");
  }
  if (typeof fetchImpl !== "function") throw new Error("Neon Object Storage requires a fetch implementation.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Neon storage timeout must be between 1000 and 120000 milliseconds.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) throw new Error("Neon storage size limit is invalid.");
  if (typeof clock !== "function") throw new Error("Neon storage clock must be a function.");

  const host = new URL(base).host;
  const bucketPath = "/" + awsEncode(bucketName);

  function timestamp() {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Neon signing clock returned an invalid date.");
    const iso = now.toISOString().replace(/[:-]|\\.\\d{3}/g, "");
    return { amzDate: iso, date: iso.slice(0, 8) };
  }

  function objectPath(value) {
    return bucketPath + "/" + safeObjectPath(value);
  }

  function signedHeaders({ method, path, query = new Map(), payloadHash, contentType = null }) {
    const { amzDate, date } = timestamp();
    const headers = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    };
    if (contentType) headers["content-type"] = contentType;
    const canonicalHeaders = Object.keys(headers).sort().map(name => name + ":" + headers[name].trim() + "\\n").join("");
    const signedHeaderNames = Object.keys(headers).sort().join(";");
    const canonicalRequest = [
      method, path, canonicalQuery(query), canonicalHeaders, signedHeaderNames, payloadHash
    ].join("\\n");
    const scope = date + "/" + signingRegion + "/s3/aws4_request";
    const stringToSign = [
      "AWS4-HMAC-SHA256", amzDate, scope,
      createHash("sha256").update(canonicalRequest).digest("hex")
    ].join("\\n");
    const signature = hmac(signingKey(secret, date, signingRegion), stringToSign, "hex");
    return {
      amzDate,
      headers: {
        ...(contentType ? { "content-type": contentType } : {}),
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        authorization: "AWS4-HMAC-SHA256 Credential=" + keyId + "/" + scope +
          ", SignedHeaders=" + signedHeaderNames + ", Signature=" + signature
      }
    };
  }

  async function request(method, path, {
    payloadHash = EMPTY_SHA256, contentType = null, body = null, contentLength = null,
    signal = null, acceptNotFound = false
  } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      const signed = signedHeaders({ method, path, payloadHash, contentType });
      if (contentLength !== null) signed.headers["content-length"] = String(contentLength);
      const response = await fetchImpl(base + path, {
        method,
        headers: signed.headers,
        ...(body === null ? {} : { body }),
        ...(body && typeof body.pipe !== "function" ? {} : body ? { duplex: "half" } : {}),
        signal: combinedSignal
      });
      if (!response.ok && !(acceptNotFound && response.status === 404)) {
        const error = new Error("Neon Object Storage request failed (HTTP " + response.status + ").");
        error.code = "NEON_STORAGE_HTTP_" + response.status;
        error.status = response.status;
        throw error;
      }
      return response;
    } catch (error) {
      if (signal?.aborted) {
        const cancelled = new Error("Neon media upload was cancelled.");
        cancelled.code = "NEON_STORAGE_ABORTED";
        throw cancelled;
      }
      if (error?.name === "AbortError") {
        const timeout = new Error("Neon Object Storage request timed out.");
        timeout.code = "NEON_STORAGE_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function digestFile(filePath) {
    const before = await stat(filePath);
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new Error("Neon media file is empty or exceeds the configured size limit.");
    }
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(filePath)) {
      size += chunk.length;
      if (size > maxBytes) throw Object.assign(new Error("Neon media file exceeds the configured size limit."), { code: "NEON_STORAGE_TOO_LARGE" });
      digest.update(chunk);
    }
    const after = await stat(filePath);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("Neon media file changed while its checksum was calculated.");
    }
    return { size, sha256: digest.digest("hex"), mtimeMs: before.mtimeMs };
  }

  return Object.freeze({
    bucket: bucketName,
    endpoint: base,

    async checkReadiness() {
      await request("HEAD", bucketPath);
      return { ready: true, storage: "private", provider: "neon-object-storage", bucket: bucketName };
    },

    async upload(path, bytes, contentType) {
      const safePath = objectPath(path);
      if (!MIME_TYPES.has(contentType)) throw new Error("Unsupported Neon media content type.");
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
        throw new Error("Neon media bytes are empty or exceed the configured size limit.");
      }
      const payloadHash = createHash("sha256").update(bytes).digest("hex");
      await request("PUT", safePath, {
        payloadHash, contentType, body: bytes, contentLength: bytes.byteLength
      });
      return { bucket: bucketName, path, size: bytes.byteLength, contentType };
    },

    async uploadFile(path, filePath, contentType, { signal = null } = {}) {
      const safePath = objectPath(path);
      if (!MIME_TYPES.has(contentType)) throw new Error("Unsupported Neon media content type.");
      const file = await digestFile(filePath);
      const beforeUpload = await stat(filePath);
      if (beforeUpload.size !== file.size || beforeUpload.mtimeMs !== file.mtimeMs) {
        throw new Error("Neon media file changed before upload.");
      }
      await request("PUT", safePath, {
        payloadHash: file.sha256, contentType, body: createReadStream(filePath),
        contentLength: file.size, signal
      });
      const afterUpload = await stat(filePath);
      if (afterUpload.size !== file.size || afterUpload.mtimeMs !== file.mtimeMs) {
        throw new Error("Neon media file changed while it was uploaded.");
      }
      return { bucket: bucketName, path, size: file.size, sha256: file.sha256, contentType };
    },

    async createSignedUrl(path, expiresIn = 300) {
      const safePath = objectPath(path);
      if (!Number.isInteger(expiresIn) || expiresIn < 30 || expiresIn > 3600) {
        throw new Error("Neon signed URL expiry must be between 30 and 3600 seconds.");
      }
      const { amzDate, date } = timestamp();
      const scope = date + "/" + signingRegion + "/s3/aws4_request";
      const query = new Map([
        ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
        ["X-Amz-Credential", keyId + "/" + scope],
        ["X-Amz-Date", amzDate],
        ["X-Amz-Expires", String(expiresIn)],
        ["X-Amz-SignedHeaders", "host"]
      ]);
      const canonicalRequest = [
        "GET", safePath, canonicalQuery(query), "host:" + host + "\\n", "host", "UNSIGNED-PAYLOAD"
      ].join("\\n");
      const stringToSign = [
        "AWS4-HMAC-SHA256", amzDate, scope,
        createHash("sha256").update(canonicalRequest).digest("hex")
      ].join("\\n");
      query.set("X-Amz-Signature", hmac(signingKey(secret, date, signingRegion), stringToSign, "hex"));
      return base + safePath + "?" + canonicalQuery(query);
    },

    async verifyObject(path, { expectedSize, expectedSha256, contentType } = {}) {
      const safePath = objectPath(path);
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maxBytes) {
        throw new Error("Neon object verification size is invalid.");
      }
      if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
        throw new Error("Neon object verification SHA-256 is invalid.");
      }
      if (contentType !== undefined && !MIME_TYPES.has(contentType)) throw new Error("Neon object verification content type is invalid.");
      const response = await request("GET", safePath);
      const actualType = response.headers?.get?.("content-type")?.split(";")[0]?.trim().toLowerCase() || null;
      const actualLength = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(actualLength) && actualLength !== expectedSize) {
        throw Object.assign(new Error("Neon object size does not match the upload receipt."), { code: "NEON_OBJECT_SIZE_MISMATCH" });
      }
      if (contentType && actualType !== contentType) {
        throw Object.assign(new Error("Neon object media type does not match the upload reservation."), { code: "NEON_OBJECT_MEDIA_TYPE_MISMATCH" });
      }
      const digest = createHash("sha256");
      let size = 0;
      if (!response.body) throw new Error("Neon object verification response has no body.");
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > expectedSize || size > maxBytes) throw Object.assign(new Error("Neon object exceeds the expected size."), { code: "NEON_OBJECT_SIZE_MISMATCH" });
        digest.update(chunk);
      }
      if (size !== expectedSize) throw Object.assign(new Error("Neon object size does not match the upload receipt."), { code: "NEON_OBJECT_SIZE_MISMATCH" });
      const sha256 = digest.digest("hex");
      if (sha256 !== expectedSha256.toLowerCase()) throw Object.assign(new Error("Neon object SHA-256 does not match the upload receipt."), { code: "NEON_OBJECT_SHA256_MISMATCH" });
      return { bucket: bucketName, path, size, sha256, contentType: actualType };
    },

    async remove(path) {
      await request("DELETE", objectPath(path), { acceptNotFound: true });
      return true;
    }
  });
}
