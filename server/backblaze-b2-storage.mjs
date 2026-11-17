import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const DEFAULT_BUCKET = "executive-visuals-media";
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const DEFAULT_MULTIPART_PART_BYTES = 64 * 1024 * 1024;
const DEFAULT_MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;
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
    throw new Error("B2 object path is invalid.");
  }
  const parts = value.split("/");
  if (parts.length < 3 || parts.length > 12 || !UUID.test(parts[0]) || !UUID.test(parts[1]) ||
      parts.some(part => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]{1,180}$/.test(part))) {
    throw new Error("B2 object path must begin with project/owner and asset UUIDs and contain safe path segments.");
  }
  return parts.map(awsEncode).join("/");
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

function safeBucket(value) {
  const bucket = String(value || DEFAULT_BUCKET);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new Error("B2 bucket name is invalid.");
  }
  return bucket;
}

export function createBackblazeB2Storage({
  region = process.env.B2_REGION,
  accessKeyId = process.env.B2_APPLICATION_KEY_ID,
  secretAccessKey = process.env.B2_APPLICATION_KEY,
  bucket = process.env.B2_BUCKET || DEFAULT_BUCKET,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  maxBytes = 250 * 1024 * 1024,
  multipartThresholdBytes = Math.min(DEFAULT_MULTIPART_THRESHOLD_BYTES, maxBytes),
  multipartPartBytes = DEFAULT_MULTIPART_PART_BYTES,
  clock = () => new Date()
} = {}) {
  const signingRegion = String(region || "").trim().toLowerCase();
  const keyId = String(accessKeyId || "").trim();
  const secret = String(secretAccessKey || "");
  const bucketName = safeBucket(bucket);
  if (!/^[a-z0-9]+-[a-z0-9]+-\d{3}$/.test(signingRegion)) throw new Error("B2_REGION must be a Backblaze S3 region such as us-west-004.");
  if (!/^[A-Za-z0-9]{16,128}$/.test(keyId) || secret.length < 16 || secret.length > 256) {
    throw new Error("B2 access key credentials are missing or invalid.");
  }
  if (typeof fetchImpl !== "function") throw new Error("B2 storage requires a fetch implementation.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("B2 storage timeout must be between 1000 and 120000 milliseconds.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) throw new Error("B2 storage size limit is invalid.");
  if (typeof clock !== "function") throw new Error("B2 storage clock must be a function.");
  if (!Number.isSafeInteger(multipartThresholdBytes) || multipartThresholdBytes < 1 || multipartThresholdBytes > maxBytes) throw new Error("B2 multipart threshold is invalid.");
  if (!Number.isSafeInteger(multipartPartBytes) || multipartPartBytes < MIN_MULTIPART_PART_BYTES || multipartPartBytes > 5 * 1024 * 1024 * 1024) throw new Error("B2 multipart part size must be between 5 MiB and 5 GiB.");

  const host = "s3." + signingRegion + ".backblazeb2.com";
  const base = "https://" + host;
  const bucketPath = "/" + bucketName;

  function timestamp() {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("B2 signing clock returned an invalid date.");
    const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    return { amzDate: iso, date: iso.slice(0, 8) };
  }

  function objectUrl(path) {
    return base + bucketPath + "/" + safeObjectPath(path);
  }

  function signedHeaders({ method, path, query = new Map(), payloadHash, contentType = null, body = null, signal = null }) {
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
      canonicalQuery(query),
      canonicalHeaders,
      signedHeaderNames,
      payloadHash
    ].join("\n");
    const scope = date + "/" + signingRegion + "/s3/aws4_request";
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex")
    ].join("\n");
    const signature = hmac(signingKey(secret, date, signingRegion), stringToSign, "hex");
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

  async function request(method, url, { query = new Map(), payloadHash = EMPTY_SHA256, contentType = null, body = null, contentLength = null, signal = null, acceptNotFound = false } = {}) {
    const parsed = new URL(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      const signed = signedHeaders({
        method,
        path: parsed.pathname,
        query,
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
        const error = new Error("B2 storage request failed (HTTP " + response.status + ").");
        error.code = "B2_STORAGE_HTTP_" + response.status;
        error.status = response.status;
        throw error;
      }
      return response;
    } catch (error) {
      if (signal?.aborted) {
        const cancelled = new Error("B2 storage upload was cancelled.");
        cancelled.code = "B2_STORAGE_ABORTED";
        throw cancelled;
      }
      if (error?.name === "AbortError") {
        const timeout = new Error("B2 storage request timed out.");
        timeout.code = "B2_STORAGE_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function digestFile(filePath) {
    const before = await stat(filePath);
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) throw new Error("B2 media file is empty or exceeds the configured size limit.");
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(filePath)) {
      size += chunk.length;
      if (size > maxBytes) throw Object.assign(new Error("B2 media file exceeds the configured size limit."), { code: "B2_STORAGE_TOO_LARGE" });
      digest.update(chunk);
    }
    const after = await stat(filePath);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("B2 media file changed while its checksum was calculated.");
    }
    return { size, sha256: digest.digest("hex"), mtimeMs: before.mtimeMs };
  }

  async function digestFileRange(filePath, start, end) {
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(filePath, { start, end })) {
      size += chunk.length;
      digest.update(chunk);
    }
    if (size !== end - start + 1) throw new Error("B2 multipart source file changed while reading a part.");
    return { size, sha256: digest.digest("hex") };
  }

  function xmlTag(xml, name) {
    const match = String(xml).match(new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">"));
    if (!match) throw new Error("B2 multipart response omitted " + name + ".");
    return match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  }

  function xmlEscape(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function multipartPartsFromXml(xml) {
    const parts = [];
    for (const match of String(xml).matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      const body = match[1];
      const partNumber = Number(xmlTag(body, "PartNumber"));
      const etag = xmlTag(body, "ETag").replace(/^"|"$/g, "");
      const size = Number(xmlTag(body, "Size"));
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000 ||
          !/^[A-Fa-f0-9-]{8,128}$/.test(etag) || !Number.isSafeInteger(size) || size < 1) {
        throw new Error("B2 returned an invalid multipart part listing.");
      }
      parts.push({ partNumber, etag, size });
    }
    return parts;
  }

  async function beginMultipartUpload(objectPath, contentType, signal = null) {
    const path = safeObjectPath(objectPath);
    if (!MIME_TYPES.has(contentType)) throw new Error("Unsupported B2 media content type.");
    const query = new Map([["uploads", ""]]);
    const response = await request("POST", objectUrl(path) + "?" + canonicalQuery(query), {
      query, contentType, signal
    });
    const uploadId = xmlTag(await response.text(), "UploadId");
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(uploadId)) throw new Error("B2 returned an invalid multipart upload identifier.");
    return { bucket: bucketName, path: objectPath, uploadId };
  }

  async function listMultipartParts(objectPath, uploadId, { signal = null } = {}) {
    const path = safeObjectPath(objectPath);
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(String(uploadId || ""))) throw new Error("B2 multipart upload identifier is invalid.");
    const parts = [];
    let marker = null;
    for (let page = 0; page < 10; page++) {
      const query = new Map([["uploadId", uploadId]]);
      if (marker !== null) query.set("part-number-marker", String(marker));
      const response = await request("GET", objectUrl(path) + "?" + canonicalQuery(query), { query, signal });
      const xml = await response.text();
      parts.push(...multipartPartsFromXml(xml));
      const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
      if (!truncated) return { parts, truncated: false };
      const next = Number(xmlTag(xml, "NextPartNumberMarker"));
      if (!Number.isInteger(next) || next <= (marker || 0) || next > 10000) throw new Error("B2 returned an invalid multipart pagination marker.");
      marker = next;
    }
    throw new Error("B2 multipart part listing exceeded the pagination limit.");
  }

  async function uploadMultipartPartFile(objectPath, uploadId, partNumber, filePath, start, end, { signal = null } = {}) {
    const path = safeObjectPath(objectPath);
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(String(uploadId || "")) || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000 ||
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new Error("B2 multipart part request is invalid.");
    }
    const info = await stat(filePath);
    if (!info.isFile() || end >= info.size) throw new Error("B2 multipart part range exceeds the source file.");
    const part = await digestFileRange(filePath, start, end);
    const query = new Map([["partNumber", String(partNumber)], ["uploadId", uploadId]]);
    const response = await request("PUT", objectUrl(path) + "?" + canonicalQuery(query), {
      query, payloadHash: part.sha256, body: createReadStream(filePath, { start, end }),
      contentLength: part.size, signal
    });
    const etag = response.headers?.get?.("etag")?.replace(/^"|"$/g, "");
    if (!etag || !/^[A-Fa-f0-9-]{8,128}$/.test(etag)) throw new Error("B2 multipart part response omitted a valid ETag.");
    return { partNumber, etag, sha256: part.sha256, size: part.size };
  }

  async function completeMultipartUpload(objectPath, uploadId, parts, { signal = null } = {}) {
    const path = safeObjectPath(objectPath);
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(String(uploadId || "")) || !Array.isArray(parts) || parts.length < 1 || parts.length > 10000) {
      throw new Error("B2 multipart completion request is invalid.");
    }
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    if (ordered.some((part, index) => part.partNumber !== index + 1 || !/^[A-Fa-f0-9-]{8,128}$/.test(String(part.etag || "")))) {
      throw new Error("B2 multipart completion requires contiguous ordered part receipts.");
    }
    const partsXml = ordered.map(part =>
      "<Part><ETag>" + xmlEscape(part.etag) + "</ETag><PartNumber>" + part.partNumber + "</PartNumber></Part>"
    ).join("");
    const body = "<CompleteMultipartUpload xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">" + partsXml + "</CompleteMultipartUpload>";
    const bytes = Buffer.from(body);
    const query = new Map([["uploadId", uploadId]]);
    const response = await request("POST", objectUrl(path) + "?" + canonicalQuery(query), {
      query, payloadHash: createHash("sha256").update(bytes).digest("hex"),
      contentType: "application/xml", body, contentLength: bytes.length, signal
    });
    const xml = await response.text();
    if (/<Error(?:\s|>)/.test(xml)) throw new Error("B2 rejected multipart completion.");
    return { bucket: bucketName, path: objectPath, parts: ordered.length };
  }

  async function abortMultipartUpload(objectPath, uploadId, { signal = null } = {}) {
    const path = safeObjectPath(objectPath);
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(String(uploadId || ""))) throw new Error("B2 multipart upload identifier is invalid.");
    const query = new Map([["uploadId", uploadId]]);
    await request("DELETE", objectUrl(path) + "?" + canonicalQuery(query), { query, signal });
    return true;
  }

  async function uploadFileMultipart(objectPath, filePath, contentType, file, signal) {
    const path = safeObjectPath(objectPath);
    const partCount = Math.ceil(file.size / multipartPartBytes);
    if (partCount < 1 || partCount > 10000) throw new Error("B2 multipart upload exceeds the 10,000-part limit.");
    const uploadQuery = new Map([["uploads", ""]]);
    const initiated = await request("POST", objectUrl(path) + "?" + canonicalQuery(uploadQuery), {
      query: uploadQuery,
      contentType,
      signal
    });
    const uploadId = xmlTag(await initiated.text(), "UploadId");
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(uploadId)) throw new Error("B2 returned an invalid multipart upload identifier.");

    const uploadedParts = [];
    try {
      for (let partNumber = 1; partNumber <= partCount; partNumber++) {
        if (signal?.aborted) {
          const cancelled = new Error("B2 multipart upload was cancelled.");
          cancelled.code = "B2_STORAGE_ABORTED";
          throw cancelled;
        }
        const start = (partNumber - 1) * multipartPartBytes;
        const end = Math.min(file.size, start + multipartPartBytes) - 1;
        const part = await digestFileRange(filePath, start, end);
        const partQuery = new Map([["partNumber", String(partNumber)], ["uploadId", uploadId]]);
        const partUrl = objectUrl(path) + "?" + canonicalQuery(partQuery);
        let etag = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const response = await request("PUT", partUrl, {
              query: partQuery,
              payloadHash: part.sha256,
              body: createReadStream(filePath, { start, end }),
              contentLength: part.size,
              signal
            });
            etag = response.headers?.get?.("etag")?.replace(/^"|"$/g, "") || null;
            if (!etag || !/^[A-Fa-f0-9-]{8,128}$/.test(etag)) throw new Error("B2 multipart part response omitted a valid ETag.");
            break;
          } catch (error) {
            if (signal?.aborted || (error?.status && error.status < 500) || attempt === 3) throw error;
          }
        }
        uploadedParts.push({ partNumber, etag });
      }

      const afterParts = await digestFile(filePath);
      if (afterParts.size !== file.size || afterParts.mtimeMs !== file.mtimeMs || afterParts.sha256 !== file.sha256) throw new Error("B2 media file changed during multipart upload.");
      const partsXml = uploadedParts.map(part =>
        "<Part><ETag>" + xmlEscape(part.etag) + "</ETag><PartNumber>" + part.partNumber + "</PartNumber></Part>"
      ).join("");
      const completeBody = "<CompleteMultipartUpload xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">" + partsXml + "</CompleteMultipartUpload>";
      const completeBytes = Buffer.from(completeBody);
      const completeQuery = new Map([["uploadId", uploadId]]);
      const completed = await request("POST", objectUrl(path) + "?" + canonicalQuery(completeQuery), {
        query: completeQuery,
        payloadHash: createHash("sha256").update(completeBytes).digest("hex"),
        contentType: "application/xml",
        body: completeBody,
        contentLength: completeBytes.length,
        signal
      });
      const completeXml = await completed.text();
    if (/<Error(?:\s|>)/.test(xml)) throw new Error("B2 rejected multipart completion.");
      const afterComplete = await stat(filePath);
      if (afterComplete.size !== file.size || afterComplete.mtimeMs !== file.mtimeMs) throw new Error("B2 media file changed before multipart receipt was finalized.");
      return {
        bucket: bucketName,
        path: objectPath,
        size: file.size,
        sha256: file.sha256,
        contentType,
        multipart: true,
        parts: uploadedParts.length
      };
    } catch (error) {
      try {
        const abortQuery = new Map([["uploadId", uploadId]]);
        await request("DELETE", objectUrl(path) + "?" + canonicalQuery(abortQuery), {
          query: abortQuery,
          signal: signal?.aborted ? null : signal
        });
      } catch {
        if (error && typeof error === "object") error.cleanupFailed = true;
      }
      throw error;
    }
  }

  return Object.freeze({
    bucket: bucketName,
    endpoint: base,
    beginMultipartUpload,
    listMultipartParts,
    uploadMultipartPartFile,
    completeMultipartUpload,
    abortMultipartUpload,

    async checkReadiness() {
      await request("HEAD", base + bucketPath);
      return { ready: true, storage: "private", provider: "backblaze-b2", bucket: bucketName };
    },

    async upload(objectPath, bytes, contentType) {
      const path = safeObjectPath(objectPath);
      if (!MIME_TYPES.has(contentType)) throw new Error("Unsupported B2 media content type.");
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
        throw new Error("B2 media bytes are empty or exceed the configured size limit.");
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
      if (!MIME_TYPES.has(contentType)) throw new Error("Unsupported B2 media content type.");
      const file = await digestFile(filePath);
      const afterDigest = await stat(filePath);
      if (afterDigest.size !== file.size || afterDigest.mtimeMs !== file.mtimeMs) {
        throw new Error("B2 media file changed before upload.");
      }
      if (file.size > multipartThresholdBytes) {
        return uploadFileMultipart(objectPath, filePath, contentType, file, signal);
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
        throw new Error("B2 media file changed while it was uploaded.");
      }
      return { bucket: bucketName, path: objectPath, size: file.size, sha256: file.sha256, contentType, multipart: false };
    },

    async createSignedUrl(objectPath, expiresIn = 300) {
      const path = safeObjectPath(objectPath);
      if (!Number.isInteger(expiresIn) || expiresIn < 30 || expiresIn > 3600) {
        throw new Error("B2 signed URL expiry must be between 30 and 3600 seconds.");
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
      const canonical = canonicalQuery(query);
      const canonicalRequest = ["GET", bucketPath + "/" + path, canonical, "host:" + host + "\n", "host", "UNSIGNED-PAYLOAD"].join("\n");
      const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
      const signature = hmac(signingKey(secret, date, signingRegion), stringToSign, "hex");
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
