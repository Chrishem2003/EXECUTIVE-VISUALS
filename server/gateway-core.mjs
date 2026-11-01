import { Buffer } from "node:buffer";

/**
 * Shared, hardened client for every external creative engine.
 *
 * Rules (identical to the text and image gateways):
 *  - disabled unless the server explicitly enables the engine
 *  - HTTPS required, except for loopback addresses
 *  - remote hosts need an explicit opt-in after a pricing review
 *  - credentials stay server-side and are sent only to the configured origin
 *  - redirects are never followed
 *  - every response body is size-capped before it is trusted
 *  - result URLs on another origin are fetched only from an allow-listed host
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DONE = new Set(["succeeded", "success", "completed", "complete", "done", "finished", "ready"]);
const FAILED = new Set(["failed", "failure", "error", "canceled", "cancelled", "rejected"]);
const REF = /^[A-Za-z0-9_.:-]{1,200}$/;

export class GatewayError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}
const fail = (prefix, suffix, message) => new GatewayError(`${prefix}_GATEWAY_${suffix}`, message);

/** Configuration problems an operator must fix. Workflow nodes report these as "blocked", not "failed". */
export const isGatewayBlockedCode = code =>
  /_GATEWAY_(DISABLED|CONFIG_INVALID|INSECURE_URL|REMOTE_DISABLED|UNSUPPORTED_INPUT|OUTPUT_HOST_BLOCKED)$/.test(String(code || ""));

/**
 * Only a rate-limit rejection is retried automatically. Other failures may have
 * happened after a paid job was accepted, so a blind retry could bill twice.
 */
export const isGatewayRetryableCode = code => /_GATEWAY_RATE_LIMITED$/.test(String(code || ""));

/** Non-throwing readiness summary for health checks. */
export function gatewayStatus(prefix) {
  const env = process.env;
  const enabled = env[`${prefix}_GATEWAY_ENABLED`] === "true";
  let configured = false;
  try {
    const url = new URL(env[`${prefix}_GATEWAY_URL`] || "");
    const local = LOOPBACK.has(url.hostname.toLowerCase());
    const safe = local ? ["http:", "https:"].includes(url.protocol) : url.protocol === "https:" && env[`${prefix}_GATEWAY_ALLOW_REMOTE`] === "true";
    configured = Boolean(env[`${prefix}_GATEWAY_MODEL`]) && safe;
  } catch {
    configured = false;
  }
  return { enabled, configured };
}

export function gatewayConfig(prefix, label) {
  const env = process.env;
  const read = suffix => String(env[`${prefix}_GATEWAY_${suffix}`] ?? "").trim();
  if (read("ENABLED") !== "true") throw fail(prefix, "DISABLED", `The ${label} is disabled by server configuration.`);
  const rawUrl = read("URL");
  const model = read("MODEL");
  if (!rawUrl || !model) throw fail(prefix, "CONFIG_INVALID", `Configure the server-side ${label} URL and model before running this node.`);
  let base;
  try {
    base = new URL(rawUrl);
  } catch {
    throw fail(prefix, "CONFIG_INVALID", `The configured ${label} URL is invalid.`);
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw fail(prefix, "CONFIG_INVALID", `The ${label} URL must be http(s) and must not contain credentials, query parameters or fragments.`);
  }
  const local = LOOPBACK.has(base.hostname.toLowerCase());
  if (base.protocol !== "https:" && !local) throw fail(prefix, "INSECURE_URL", `Non-local ${label}s must use HTTPS.`);
  if (!local && read("ALLOW_REMOTE") !== "true") {
    throw fail(prefix, "REMOTE_DISABLED", `Remote ${label}s are disabled. Verify provider pricing and explicitly enable remote access on the server.`);
  }
  const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, Number(value) || fallback));
  const prefixPath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const apiKey = read("API_KEY");
  return {
    prefix,
    label,
    base,
    local,
    model,
    timeoutMs: clamp(read("TIMEOUT_MS"), 1000, 600000, 120000),
    jobTimeoutMs: clamp(read("JOB_TIMEOUT_MS"), 5000, 7200000, 1800000),
    pollMs: clamp(read("POLL_MS"), 200, 30000, 2000),
    outputHosts: new Set(read("OUTPUT_HOSTS").split(",").map(host => host.trim().toLowerCase()).filter(Boolean)),
    authHeaders: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    url: path => new URL(prefixPath + String(path).replace(/^\/+/, ""), base.origin)
  };
}

export function sleep(ms, signal, prefix = "GATEWAY") {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fail(prefix, "CANCELLED", "The request was cancelled."));
    const onAbort = () => {
      clearTimeout(timer);
      reject(fail(prefix, "CANCELLED", "The request was cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One bounded HTTP exchange. `read` runs inside the timeout so a stalled body cannot hang a worker.
 */
export async function gatewayCall(cfg, target, { method = "GET", headers = {}, body, signal, timeoutMs } = {}, read) {
  const url = target instanceof URL ? target : cfg.url(target);
  if (signal?.aborted) throw fail(cfg.prefix, "CANCELLED", "The request was cancelled.");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs || cfg.timeoutMs);
  const mapAbort = error => {
    if (signal?.aborted) return fail(cfg.prefix, "CANCELLED", "The request was cancelled.");
    if (error?.name === "AbortError") return fail(cfg.prefix, "TIMEOUT", `The ${cfg.label} request timed out.`);
    return null;
  };
  try {
    let response;
    try {
      response = await fetch(url, {
        method,
        body,
        signal: controller.signal,
        redirect: "error",
        headers: { ...(url.origin === cfg.base.origin ? cfg.authHeaders : {}), ...headers }
      });
    } catch (error) {
      throw mapAbort(error) || fail(cfg.prefix, "UNAVAILABLE", `The ${cfg.label} could not be reached.`);
    }
    if (response.status === 429) throw fail(cfg.prefix, "RATE_LIMITED", `The ${cfg.label} rate limit was reached.`);
    if (response.status >= 500) throw fail(cfg.prefix, "SERVER_ERROR", `The ${cfg.label} returned a temporary server error (${response.status}).`);
    if (!response.ok) throw fail(cfg.prefix, "REQUEST_REJECTED", `The ${cfg.label} rejected the request (${response.status}).`);
    try {
      return await read(response);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw mapAbort(error) || fail(cfg.prefix, "INVALID_RESPONSE", `The ${cfg.label} returned an unreadable response.`);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function readBody(response, maxBytes, prefix) {
  const tooLarge = () => fail(prefix, "INVALID_RESPONSE", `The response exceeds the ${Math.round(maxBytes / 1048576)} MiB transport limit.`);
  if (Number(response.headers.get("content-length") || 0) > maxBytes) throw tooLarge();
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw tooLarge();
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
}

export async function readJson(response, prefix, maxBytes = 8 * 1024 * 1024) {
  const raw = await readBody(response, maxBytes, prefix);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (value && typeof value === "object") return value;
  } catch {
    /* fall through */
  }
  throw fail(prefix, "INVALID_RESPONSE", "The gateway returned an invalid JSON response.");
}

export function decodeBase64(encoded, maxBytes, prefix) {
  if (typeof encoded !== "string" || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw fail(prefix, "INVALID_RESPONSE", "The gateway returned malformed base64 data.");
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0 || buffer.length > maxBytes || buffer.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw fail(prefix, "INVALID_RESPONSE", "The gateway output failed binary validation or exceeds the size limit.");
  }
  return buffer;
}

/** Find the result in the response shapes common to media gateways. */
export function pickOutput(body) {
  const first = Array.isArray(body?.data) ? body.data[0] : undefined;
  const url =
    body?.output_url ?? body?.result_url ?? body?.url ??
    (typeof body?.output === "string" ? body.output : body?.output?.url) ??
    body?.video?.url ?? first?.url ?? first?.output_url;
  const b64 = body?.b64_json ?? first?.b64_json;
  if (typeof url === "string" && url) return { url };
  if (typeof b64 === "string" && b64) return { b64 };
  return null;
}

function sameOriginRef(cfg, ref) {
  let url;
  try {
    url = new URL(String(ref), cfg.base.origin);
  } catch {
    throw fail(cfg.prefix, "INVALID_RESPONSE", "The gateway returned an invalid URL.");
  }
  if (url.origin !== cfg.base.origin) throw fail(cfg.prefix, "INVALID_RESPONSE", "The gateway returned a status URL on a different origin.");
  return url;
}

/** Poll an asynchronous job until it succeeds, fails, is cancelled or times out. */
export async function awaitJob(cfg, { statusTarget, signal, onProgress = () => {} }) {
  const deadline = Date.now() + cfg.jobTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(cfg.pollMs, signal, cfg.prefix);
    const job = await gatewayCall(cfg, statusTarget, { signal }, response => readJson(response, cfg.prefix));
    const progress = Number(job.progress);
    if (Number.isFinite(progress) && progress >= 0) onProgress(progress <= 1 ? progress * 100 : Math.min(progress, 100));
    const status = String(job.status ?? "").toLowerCase();
    if (DONE.has(status)) return job;
    if (FAILED.has(status)) {
      const detail = String(job.error?.message ?? job.error ?? job.message ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
      throw fail(cfg.prefix, "JOB_FAILED", `The ${cfg.label} reported that the job ${status}${detail ? `: ${detail}` : "."}`);
    }
  }
  throw fail(cfg.prefix, "TIMEOUT", `Timed out waiting for the ${cfg.label}.`);
}

/**
 * Download a finished result. The same origin is always allowed. Another origin
 * must use HTTPS (or loopback for a local gateway) and be listed in OUTPUT_HOSTS,
 * so a misbehaving gateway cannot aim the server at internal addresses.
 */
export async function fetchOutput(cfg, ref, { signal, maxBytes }) {
  let url;
  try {
    url = new URL(String(ref), cfg.base.origin);
  } catch {
    throw fail(cfg.prefix, "INVALID_RESPONSE", "The gateway returned an invalid result URL.");
  }
  if (url.origin !== cfg.base.origin) {
    const secure = url.protocol === "https:" || (cfg.local && LOOPBACK.has(url.hostname.toLowerCase()) && url.protocol === "http:");
    const listed = cfg.outputHosts.has(url.host.toLowerCase()) || cfg.outputHosts.has(url.hostname.toLowerCase());
    if (!secure || !listed || url.username || url.password) {
      throw fail(cfg.prefix, "OUTPUT_HOST_BLOCKED", `The result is hosted on ${url.hostname}, which is not in ${cfg.prefix}_GATEWAY_OUTPUT_HOSTS.`);
    }
  }
  return gatewayCall(cfg, url, { signal, timeoutMs: Math.min(cfg.jobTimeoutMs, 900000) }, async response => ({
    buffer: await readBody(response, maxBytes, cfg.prefix),
    contentType: (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
  }));
}

/**
 * Submit work and collect the result whether the gateway answers with the file
 * itself, a result URL, inline base64, or a job id to poll.
 */
export async function submitAndCollect(cfg, { path, headers = {}, body, signal, onProgress = () => {}, maxBytes, statusPath }) {
  const jsonLimit = Math.ceil(maxBytes * 1.4) + 1048576;
  const first = await gatewayCall(cfg, path, { method: "POST", headers, body, signal }, async response => {
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (type.includes("json")) return { json: await readJson(response, cfg.prefix, jsonLimit) };
    return { buffer: await readBody(response, maxBytes, cfg.prefix), contentType: type };
  });
  if (first.buffer) return { ...first, model: cfg.model };
  let output = pickOutput(first.json);
  if (!output) {
    const id = first.json.id ?? first.json.job_id ?? first.json.task_id;
    if (!REF.test(String(id ?? ""))) {
      throw fail(cfg.prefix, "INVALID_RESPONSE", "The gateway response contained neither a result nor a valid job id.");
    }
    const statusTarget = first.json.status_url
      ? sameOriginRef(cfg, first.json.status_url)
      : cfg.url(statusPath.replace("{id}", encodeURIComponent(String(id))));
    const finished = await awaitJob(cfg, { statusTarget, signal, onProgress });
    output = pickOutput(finished);
    if (!output) throw fail(cfg.prefix, "INVALID_RESPONSE", "The job finished without returning a result.");
  }
  if (output.b64) return { buffer: decodeBase64(output.b64, maxBytes, cfg.prefix), contentType: "", model: cfg.model };
  return { ...(await fetchOutput(cfg, output.url, { signal, maxBytes })), model: cfg.model };
}
