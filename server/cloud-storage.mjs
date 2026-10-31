const BUCKET = "executive-visuals-media";
const MIME_TYPES = new Set([
  "image/jpeg","image/png","image/webp","image/gif",
  "video/mp4","video/webm","video/quicktime","video/x-matroska",
  "audio/mpeg","audio/wav","audio/x-wav","audio/mp4","audio/ogg",
  "application/pdf","text/plain","text/vtt","application/json"
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Cloud storage URL must be a valid absolute URL."); }
  const local = ["localhost","127.0.0.1","::1","[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("Cloud storage URL must use HTTPS and must not contain credentials, query parameters or fragments.");
  }
  return url.origin;
}

export function buildCloudAssetObjectPath({ ownerId, projectId = null, assetId, filename }) {
  const owner = String(ownerId || "");
  const project = projectId === null || projectId === undefined || projectId === "" ? null : String(projectId);
  const asset = String(assetId || "");
  const name = String(filename || "");
  if (!UUID.test(owner) || project !== null && !UUID.test(project) || !UUID.test(asset)) {
    throw new Error("Cloud asset path requires valid owner, optional project and asset UUIDs.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(name) || name === "." || name === "..") {
    throw new Error("Cloud asset filename is invalid.");
  }
  return (project || owner) + "/" + asset + "/" + name;
}

function safeObjectPath(value) {
  if (typeof value !== "string" || value.length > 1024 || value.startsWith("/") || value.includes("\\")) {
    throw new Error("Storage object path is invalid.");
  }
  const parts = value.split("/");
  if (parts.length < 2 || parts.length > 12 || !UUID.test(parts[0]) ||
      parts.some(part => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]{1,180}$/.test(part))) {
    throw new Error("Storage object path must begin with a user or project UUID and contain safe path segments.");
  }
  return parts.map(encodeURIComponent).join("/");
}

export function createCloudStorage({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  maxBytes = 250 * 1024 * 1024
} = {}) {
  if (!url || !serviceRoleKey) throw new Error("Cloud storage requires server-side SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  if (typeof fetchImpl !== "function") throw new Error("Cloud storage requires a fetch implementation.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Cloud storage timeout must be between 1000 and 120000 milliseconds.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) throw new Error("Cloud storage size limit is invalid.");
  const base = origin(url);

  async function request(path, { method="GET", headers={}, body=null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + path, {
        method,
        headers: {
          apikey: serviceRoleKey,
          authorization: "Bearer " + serviceRoleKey,
          ...headers
        },
        ...(body === null ? {} : { body }),
        signal: controller.signal
      });
      const raw = await response.text();
      let parsed = null;
      if (raw) {
        try { parsed = JSON.parse(raw); }
        catch { if (response.ok) throw new Error("Cloud storage returned a non-JSON response."); }
      }
      if (!response.ok) {
        const message = typeof parsed?.message === "string"
          ? parsed.message.replaceAll(serviceRoleKey, "[redacted]").slice(0, 300)
          : "Cloud storage request failed.";
        const error = new Error(message);
        error.code = "CLOUD_STORAGE_HTTP_" + response.status;
        error.status = response.status;
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("Cloud storage request timed out.");
        timeout.code = "CLOUD_STORAGE_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async upload(objectPath, bytes, contentType) {
      const path = safeObjectPath(objectPath);
      if (!MIME_TYPES.has(contentType)) throw new Error("Unsupported cloud media content type.");
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
        throw new Error("Cloud media bytes are empty or exceed the configured size limit.");
      }
      await request("/storage/v1/object/" + BUCKET + "/" + path, {
        method:"POST",
        headers:{"content-type":contentType,"cache-control":"max-age=3600","x-upsert":"false"},
        body:bytes
      });
      return { bucket:BUCKET, path:objectPath, size:bytes.byteLength, contentType };
    },
    async createSignedUrl(objectPath, expiresIn = 300) {
      const path = safeObjectPath(objectPath);
      if (!Number.isInteger(expiresIn) || expiresIn < 30 || expiresIn > 3600) throw new Error("Signed URL expiry must be between 30 and 3600 seconds.");
      const result = await request("/storage/v1/object/sign/" + BUCKET + "/" + path, {
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({expiresIn})
      });
      if (typeof result?.signedURL !== "string" || !result.signedURL) throw new Error("Cloud storage did not return a signed URL.");
      const signedPath = result.signedURL.startsWith("/object/")
        ? "/storage/v1" + result.signedURL
        : result.signedURL;
      const signed = new URL(signedPath, base);
      if (signed.origin !== base || !signed.pathname.startsWith("/storage/v1/object/sign/")) {
        throw new Error("Cloud storage returned an unsafe signed URL.");
      }
      return signed.toString();
    },
    async remove(objectPath) {
      const path = safeObjectPath(objectPath);
      await request("/storage/v1/object/" + BUCKET, {
        method:"DELETE",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({prefixes:[objectPath]})
      });
      return true;
    }
  });
}
