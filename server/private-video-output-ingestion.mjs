import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const RESPONSE_TYPES = new Set([...VIDEO_TYPES, "application/octet-stream"]);

function fail(message, code) { return Object.assign(new Error(message), { code }); }

function ipv4Public(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b,c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0 && c === 0 || b === 0 && c === 2 || b === 88 && c === 99)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 192 && b === 31 && c === 196) return false;
  if (a === 192 && b === 52 && c === 193) return false;
  if (a === 192 && b === 175 && c === 48) return false;
  if (a === 192 && b === 0 && c === 170) return false;
  if (a === 192 && b === 0 && c === 8) return false;
  if (a === 192 && b === 0 && c === 9) return false;
  if (a === 192 && b === 0 && c === 10) return false;
  return true;
}

function ipv6Public(address) {
  const value = address.toLowerCase().split("%")[0];
  if (value.includes(".")) {
    const tail = value.slice(value.lastIndexOf(":") + 1);
    if (isIP(tail) === 4) return ipv4Public(tail);
  }
  if (value.startsWith("::ffff:")) {
    const tail = value.slice(7);
    if (isIP(tail) === 4) return ipv4Public(tail);
    const words = tail.split(":");
    if (words.length === 2) {
      const hi = parseInt(words[0], 16), lo = parseInt(words[1], 16);
      if ([hi,lo].every(Number.isFinite)) return ipv4Public([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."));
    }
    return false;
  }
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return false;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some(word => !/^[0-9a-f]{1,4}$/.test(word))) return false;
  const n = words.reduce((acc, word) => (acc << 16n) | BigInt(parseInt(word, 16)), 0n);
  const prefix = n >> 125n;
  // Only global-unicast 2000::/3 is accepted. This excludes unspecified,
  // loopback, ULA, link-local, multicast, IPv4-compatible and transition ranges.
  if (prefix !== 1n) return false;
  const top32 = n >> 96n;
  if (top32 === 0x20010db8n || top32 === 0x20010000n || top32 === 0x20020000n) return false;
  return true;
}

function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? ipv4Public(address) : family === 6 ? ipv6Public(address) : false;
}

function allowedHost(hostname, rules) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return rules.some(rule => {
    const normalized = rule.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    return host === normalized || host.endsWith("." + normalized);
  });
}

async function resolvePinnedAddress(hostname, resolver) {
  const records = await resolver(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length < 1 || records.length > 32 ||
      records.some(record => !record || !publicAddress(record.address))) {
    throw fail("Provider output host resolved to a non-public or invalid address.", "VIDEO_OUTPUT_HOST_NOT_PUBLIC");
  }
  return records[0];
}

async function downloadPinned(url, destination, { resolver, maxBytes, timeoutMs }) {
  const record = await resolvePinnedAddress(url.hostname, resolver);
  return new Promise((resolve, reject) => {
    let received = 0;
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const req = httpsRequest(url, {
      method: "GET",
      agent: false,
      servername: url.hostname,
      headers: { accept: "video/mp4, video/webm, video/quicktime, application/octet-stream" },
      lookup(_hostname, _options, callback) { callback(null, record.address, record.family); }
    }, response => {
      if (response.statusCode !== 200) {
        response.destroy();
        finish(fail("Provider output download returned HTTP " + response.statusCode + ".", "VIDEO_OUTPUT_HTTP_ERROR"));
        return;
      }
      const type = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!RESPONSE_TYPES.has(type)) {
        response.destroy();
        finish(fail("Provider output has an unsupported content type.", "VIDEO_OUTPUT_CONTENT_TYPE_INVALID"));
        return;
      }
      const declared = Number(response.headers["content-length"] || 0);
      if (declared > maxBytes) {
        response.destroy();
        finish(fail("Provider output exceeds the configured download limit.", "VIDEO_OUTPUT_TOO_LARGE"));
        return;
      }
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          if (received > maxBytes) {
            callback(fail("Provider output exceeds the configured download limit.", "VIDEO_OUTPUT_TOO_LARGE"));
            return;
          }
          callback(null, chunk);
        }
      });
      pipeline(response, meter, createWriteStream(destination, { flags: "wx" }))
        .then(() => {
          if (received < 1) finish(fail("Provider output was empty.", "VIDEO_OUTPUT_EMPTY"));
          else finish(null, { size: received, contentType: type });
        })
        .catch(error => finish(error));
    });
    timer = setTimeout(() => req.destroy(fail("Provider output download timed out.", "VIDEO_OUTPUT_TIMEOUT")), timeoutMs);
    req.on("error", error => finish(error));
    req.end();
  });
}

/**
 * Private-output ingestion for remote video provider results.
 *
 * The hostname allowlist is deployment configuration, not a wildcard default.
 * DNS answers are checked and pinned to a public address for the TLS request;
 * redirects are never followed. A media validator (e.g. FFprobe-backed) is
 * mandatory before any file is uploaded or registered as an asset.
 */
export function createPrivateVideoOutputIngestor({
  assets,
  allowedHosts = [],
  resolver = dnsLookup,
  validateMedia,
  tempRoot = tmpdir(),
  maxBytesPerOutput = 250 * 1024 * 1024,
  maxTotalBytes = 500 * 1024 * 1024,
  timeoutMs = 30000,
  download = downloadPinned
} = {}) {
  if (!assets || typeof assets.createFromFile !== "function" || typeof assets.softDelete !== "function") {
    throw new Error("Private video ingestion requires cloud asset createFromFile and softDelete operations.");
  }
  if (!Array.isArray(allowedHosts) || allowedHosts.length < 1 || allowedHosts.length > 100 ||
      allowedHosts.some(host => typeof host !== "string" || !/^(?:\*\.)?[a-z0-9.-]{1,253}$/i.test(host))) {
    throw new Error("An explicit, bounded provider output hostname allowlist is required.");
  }
  if (typeof resolver !== "function" || typeof validateMedia !== "function" || typeof download !== "function") {
    throw new Error("Private video ingestion requires DNS resolution, pinned downloading and media validation.");
  }
  if (!Number.isSafeInteger(maxBytesPerOutput) || maxBytesPerOutput < 1024 || maxBytesPerOutput > 1024 * 1024 * 1024 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < maxBytesPerOutput || maxTotalBytes > 2 * 1024 * 1024 * 1024 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("Private video ingestion limits are invalid.");
  }

  return Object.freeze({
    async ingest({ job, task, input } = {}) {
      if (!job || !UUID.test(String(job.owner_id || "")) ||
          job.project_id != null && !UUID.test(String(job.project_id))) {
        throw fail("Video output job ownership scope is invalid.", "VIDEO_OUTPUT_JOB_SCOPE_INVALID");
      }
      if (!task || typeof task.taskId !== "string" || !task.taskId.trim() ||
          !Array.isArray(task.outputUrls) || task.outputUrls.length < 1 || task.outputUrls.length > 10) {
        throw fail("Provider returned an invalid output collection.", "VIDEO_OUTPUT_COLLECTION_INVALID");
      }
      const directory = await mkdtemp(join(tempRoot, "ev-video-output-"));
      const created = [];
      let totalBytes = 0;
      try {
        for (let index = 0; index < task.outputUrls.length; index++) {
          const raw = task.outputUrls[index];
          let url;
          try {
            url = new URL(raw);
            if (url.protocol !== "https:" || url.username || url.password || url.hash ||
                url.port && url.port !== "443" || url.href.length > 8192 || !allowedHost(url.hostname, allowedHosts)) throw new Error();
          } catch {
            throw fail("Provider output URL is not on the approved HTTPS host allowlist.", "VIDEO_OUTPUT_URL_REJECTED");
          }
          const path = join(directory, "provider-output-" + index + ".bin");
          const receipt = await download(url, path, { resolver, maxBytes: maxBytesPerOutput, timeoutMs });
          if (!receipt || !Number.isSafeInteger(receipt.size) || receipt.size < 1 ||
              receipt.size > maxBytesPerOutput || !VIDEO_TYPES.has(receipt.contentType)) {
            throw fail("Provider output download receipt is invalid.", "VIDEO_OUTPUT_DOWNLOAD_INVALID");
          }
          totalBytes += receipt.size;
          if (totalBytes > maxTotalBytes) throw fail("Provider output collection exceeds its total size limit.", "VIDEO_OUTPUT_TOTAL_TOO_LARGE");
          const validation = await validateMedia({ path, contentType: receipt.contentType, size: receipt.size, task, input });
          if (!validation || validation.valid !== true || !VIDEO_TYPES.has(validation.mediaType)) {
            throw fail("Provider output failed media validation.", "VIDEO_OUTPUT_MEDIA_INVALID");
          }
          const asset = await assets.createFromFile({
            ownerId: job.owner_id,
            projectId: job.project_id || null,
            originalName: "generated-video-" + (index + 1) + "." + (validation.mediaType === "video/webm" ? "webm" : validation.mediaType === "video/quicktime" ? "mov" : "mp4"),
            mediaType: validation.mediaType,
            filePath: path,
            metadata: {
              source: "video-generation",
              provider: String(input?.provider || "").slice(0, 100),
              model: String(input?.model || "").slice(0, 160),
              providerTaskId: task.taskId.slice(0, 256),
              validated: true,
              validation: validation.metadata && typeof validation.metadata === "object" && !Array.isArray(validation.metadata) &&
                JSON.stringify(validation.metadata).length <= 8000 ? validation.metadata : {}
            }
          });
          if (asset && typeof asset.id === "string" && UUID.test(asset.id)) created.push(asset);
          if (!asset || typeof asset.id !== "string" || !UUID.test(asset.id) || asset.ownerId !== job.owner_id ||
              (asset.projectId || null) !== (job.project_id || null)) {
            if (!asset || typeof asset.id !== "string" || !UUID.test(asset.id)) {
              const error = fail("Private asset registration returned no safe cleanup identifier.", "VIDEO_OUTPUT_ASSET_REGISTRATION_INVALID");
              error.cleanupPending = true;
              throw error;
            }
            throw fail("Private asset registration returned an invalid ownership record.", "VIDEO_OUTPUT_ASSET_REGISTRATION_INVALID");
          }
        }
        return Object.freeze({
          assetIds: Object.freeze(created.map(asset => asset.id)),
          usage: Object.freeze({ outputCount: created.length, totalBytes })
        });
      } catch (error) {
        for (const asset of created.reverse()) {
          try { await assets.softDelete({ ownerId: job.owner_id, assetId: asset.id }); }
          catch { error.cleanupPending = true; }
        }
        throw error;
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    }
  });
}
