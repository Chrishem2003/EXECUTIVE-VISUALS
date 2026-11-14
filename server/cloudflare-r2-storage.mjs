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
    throw new Error("R2 object path is invalid.");
  }
  const parts = value.split("/");
  if (parts.length < 3 || parts.length > 12 || !UUID.test(parts[0]) || !UUID.test(parts[1]) ||
      parts.some(part => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]{1,180}$/.test(part))) {
    throw new Error("R2 object path must begin with project/owner and asset UUIDs and contain safe path segments.");
  }
  return parts.map(awsEncode).join("/");
}

function hmac(key, value, encoding) {
  const result = createHmac("sha256", key).update(value, "utf8");
  return encoding ? result.digest(encoding) : result.digest();
}

function signingKey(secret, date) {
  const dateKey = hmac("AWS4" + secret, date);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function canonicalQuery(entries) {
  return [...entries]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))
    .map(([key, value]) => key + "=" + value)
    .join("&");
}

function safeBucket(value) {
  const bucket = String(value || DEFAULT_BUCKET);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new Error("R2 bucket name is invalid.");
  }
  return bucket;
}

export function createCloudflareR2Storage({
  accountId = process.env.R2_ACCOUNT_ID,
  accessKeyId = process.env.R2_ACCESS_KEY_ID,
  secretAccessKey = process.env.R2_SECRET_ACCESS_KEY,
  bucket = process.env.R2_BUCKET || DEFAULT_BUCKET,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  maxBytes = 250 * 1024 * 1024,
  clock = () => new Date()
} = {}) {
  const account = String(accountId || "").trim();
  const keyId = String(accessKeyId || "").trim();
  const secret = String(secretAccessKey || "");
  const bucketName = safeBucket(bucket);
  if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error("R2_ACCOUNT_ID must be a 32-character Cloudflare account ID.");
  if (!/^[A-Za-z0-9]{16,128}$/.test(keyId) || secret.length < 32 || secret.length > 256) {
    throw new Error("R2 access key credentials are missing or invalid.");
  }
  if (typeof fetchImpl !== "function") throw new Error("R2 storage requires a fetch implementation.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("R2 storage timeout must be between 1000 and 120000 milliseconds.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) throw new Error("R2 storage size limit is invalid.");
  if (typeof clock !== "function") throw new Error("R2 storage clock must be a function.");

  const host = account + ".r2.cloudflarestorage.com";
  const base = "https://" + host;
  const bucketPath = "/" + bucketName;

  function timestamp() {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("R2 signing clock returned an invalid date.");
    const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    return { amzDate: iso, date: iso.slice(0, 8) };
  }

  function objectUrl(path) {
    return base + bucketPath + "/" + safeObjectPath(path);
  }

  function signedHeaders({ method, path, payloadHash, contentType = null, body = null, signal = null }) {
    const { amzDate, date } = timestamp();
    const headers = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    };
    if (contentType) headers["content-type"] = contentType;
    const canonicalHeaders = Object.keys(headers).sort().map(name => name + ":" + headers[name].trim() + "\n").join("");
    const signedHeaderNames = Object.keys(headers).sort().join(";");
    const canonicalRequest = [
      method,
      path,
      "",
      canonicalHeaders,
      signedHeaderNames,
      payloadHash
    ].join("\n");
    const scope = date + "/auto/s3/aws4_request";
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex")
    ].join("\n");
    const signature = hmac(signingKey(secret, date), stringToSign, "hex");
    const authorization = "AWS4-HMAC-SHA256 Credential=" + keyId + "/" + scope +
      ", SignedHeaders=" + signedHeaderNames + ", Signature=" + signature;
    return {
      headers: {
        ...(contentType ? { "content-type": contentType } : {}),
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        authorization
      },
      body,
      signal
    };
  }

  async function request(method, url, { payloadHash = EMPTY_SHA256, contentType = null, body = null, contentLength = null, signal = null, acceptNotFound = false } = {}) {
    const parsed = new URL(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      const signed = signedHeaders({
        method,
        path: parsed.pathname,
        payloadHash,
        contentType,
        body,
        signal: combinedSignal
      });
      if (contentLength !== null) signed.headers["content-length"] = String(contentLength);
      const response = await fetchImpl(url, {
        method,
        headers: signed.headers,
        ...(body === null ? {} : { body }),
        ...(body && typeof body.pipe !== "function" ? {} : body ? { duplex: "half" } : {}),
        signal: combinedSignal
      });
      if (!response.ok && !(acceptNotFound && response.status === 404)) {
        const error = new Error("R2 storage request failed (HTTP " + response.status + ").");
        error.code = "R2_STORAGE_HTTP_" + response.status;
        error.status = response.status;
        throw error;
      }
      return response;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("R2 storage request timed out.");
        timeout.code = "R2_STORAGE_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function digestFile(filePath) {
    const before = await stat(filePath);
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) throw new Error("R2 media file is empty or exceeds the configured size limit.");
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(filePath)) {
      size += chunk.length;
      if (size > maxBytes) throw Object.assign(new Error("R2 media file exceeds the configured size limit."), { code: "R2_STORAGE_TOO_LARGE" });
      digest.update(chunk);
    }
    const after = await stat(filePath);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("R2 media file changed while its checksum was calculated.");
    }
    return { size, sha256: digest.digest("hex"), mtimeMs: before.mtimeMs };
  }

  return Object.freeze({
    bucket: bucketName,
    endpoint: base,

    async checkReadiness() {
      await request("HEAD", base + bucketPath);
      return { ready: true, storage: "private", provider: "cloudflare-r2", bucket: bucketName };
    },

    async upload(objectPath, bytes, contentType) {
      const path = safeObjectPath(objectPath);
      if (!MIME_TYPES.has(contentType)) throw new Error("Unsupported R2 media content type.");
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
        throw new Error("R2 media bytes are empty or exceed the configured size limit.");
      }
      const payloadHash = createHash("sha256").update(bytes).digest("hex");
      await request("PUT", objectUrl(path), {
        payloadHash,
        contentType,
        body: bytes,
        contentLength: bytes.byteLength
      });
      return { bucket: bucketName, path: objectPath, size: bytes.byteLength, contentType };
    },

    async uploadFile(objectPath, filePath, contentType, { signal = null } = {}) {
      const path = safeObjectPath(objectPath);
      if (!MIME_TYPES.has(contentType)) throw new Error("Unsupported R2 media content type.");
      const file = await digestFile(filePath);
      const afterDigest = await stat(filePath);
      if (afterDigest.size !== file.size || afterDigest.mtimeMs !== file.mtimeMs) {
        throw new Error("R2 media file changed before upload.");
      }
      await request("PUT", objectUrl(path), {
        payloadHash: file.sha256,
        contentType,
        body: createReadStream(filePath),
        contentLength: file.size,
        signal
      });
      const afterUpload = await stat(filePath);
      if (afterUpload.size !== file.size || afterUpload.mtimeMs !== file.mtimeMs) {
        throw new Error("R2 media file changed while it was uploaded.");
      }
      return { bucket: bucketName, path: objectPath, size: file.size, sha256: file.sha256, contentType };
    },

    async createSignedUrl(objectPath, expiresIn = 300) {
      const path = safeObjectPath(objectPath);
      if (!Number.isInteger(expiresIn) || expiresIn < 30 || expiresIn > 3600) {
        throw new Error("R2 signed URL expiry must be between 30 and 3600 seconds.");
      }
      const { amzDate, date } = timestamp();
      const scope = date + "/auto/s3/aws4_request";
      const query = new Map([
        ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
        ["X-Amz-Credential", keyId + "/" + scope],
        ["X-Amz-Date", amzDate],
        ["X-Amz-Expires", String(expiresIn)],
        ["X-Amz-SignedHeaders", "host"]
      ]);
      const canonical = canonicalQuery(query);
      const canonicalRequest = ["GET", bucketPath + "/" + path, canonical, "host:" + host + "\n", "host", "UNSIGNED-PAYLOAD"].join("\n");
      const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
      const signature = hmac(signingKey(secret, date), stringToSign, "hex");
      query.set("X-Amz-Signature", signature);
      return base + bucketPath + "/" + path + "?" + canonicalQuery(query);
    },

    async remove(objectPath) {
      const path = safeObjectPath(objectPath);
      await request("DELETE", objectUrl(path), { acceptNotFound: true });
      return true;
    }
  });
}
