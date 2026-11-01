const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const allowedImageHosts = host => host === "fal.media" || host.endsWith(".fal.media");
const allowedQueueUrl = raw => {
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error("The image provider returned an invalid job URL."), { code: "IMAGE_GATEWAY_INVALID_RESPONSE" }); }
  if (url.protocol !== "https:" || url.hostname !== "queue.fal.run" || url.username || url.password || url.port || url.hash) {
    throw Object.assign(new Error("The image provider returned an unsafe job URL."), { code: "IMAGE_GATEWAY_INVALID_RESPONSE" });
  }
  return url;
};
async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try { response = await fetch(url, { ...options, signal: controller.signal, redirect: "error" }); }
    catch (error) {
      if (error?.name === "AbortError") throw Object.assign(new Error("Image provider request timed out."), { code: "IMAGE_GATEWAY_TIMEOUT" });
      throw Object.assign(new Error("Image provider could not be reached."), { code: "IMAGE_GATEWAY_UNAVAILABLE" });
    }
    if (response.status === 429) throw Object.assign(new Error("Image provider rate limit reached."), { code: "IMAGE_GATEWAY_RATE_LIMITED" });
    if (response.status >= 500) throw Object.assign(new Error("Image provider returned a temporary server error."), { code: "IMAGE_GATEWAY_SERVER_ERROR" });
    if (!response.ok) throw Object.assign(new Error("Image provider rejected the request (" + response.status + ")."), { code: "IMAGE_GATEWAY_REQUEST_REJECTED" });
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > 2 * 1024 * 1024) throw Object.assign(new Error("Image provider returned an oversized response."), { code: "IMAGE_GATEWAY_INVALID_RESPONSE" });
    try { return JSON.parse(raw); } catch { throw Object.assign(new Error("Image provider returned invalid JSON."), { code: "IMAGE_GATEWAY_INVALID_RESPONSE" }); }
  } finally { clearTimeout(timer); }
}
export async function generateFalImage({ prompt, size = "1024x1024", quality = "medium" } = {}) {
  const referenceField = String(process.env.FAL_IMAGE_REFERENCE_FIELD || "").trim();
  const allowedReferenceFields = new Set(["image_url", "image_urls", "reference_image_url", "reference_image_urls"]);
  if (referenceField && !allowedReferenceFields.has(referenceField)) {
    throw Object.assign(new Error("FAL_IMAGE_REFERENCE_FIELD must be a documented reference-image field supported by the selected model."), { code: "IMAGE_GATEWAY_CONFIG_INVALID" });
  }
  const reference = String(arguments[0]?.referenceImageDataUrl || "");
  if (reference && (!allowedReferenceFields.has(referenceField) || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(reference) || reference.length > 14 * 1024 * 1024)) {
    throw Object.assign(new Error("Reference image input requires an explicitly configured supported model field and a valid image data URL under 10 MiB."), { code: "IMAGE_GATEWAY_UNSUPPORTED_INPUT" });
  }
  if (process.env.IMAGE_GATEWAY_ENABLED !== "true") throw Object.assign(new Error("Image generation is disabled by server configuration."), { code: "IMAGE_GATEWAY_DISABLED" });
  if (process.env.IMAGE_GATEWAY_ALLOW_REMOTE !== "true") throw Object.assign(new Error("Remote image providers are disabled. Verify pricing and explicitly enable remote access on the server."), { code: "IMAGE_GATEWAY_REMOTE_DISABLED" });
  const key = String(process.env.FAL_KEY || "").trim();
  const model = String(process.env.FAL_IMAGE_MODEL || "").trim();
  if (!key || !model || model.length > 240 || !/^[a-zA-Z0-9_./:-]+$/.test(model) || model.includes("..") || model.startsWith("/") ) {
    throw Object.assign(new Error("Configure a valid server-side image provider key and model before running this node."), { code: "IMAGE_GATEWAY_CONFIG_INVALID" });
  }
  const text = String(prompt || "").trim().slice(0, 20000);
  if (!text) throw Object.assign(new Error("Image generation requires a non-empty prompt."), { code: "PROMPT_REQUIRED" });
  const timeoutMs = Math.max(1000, Math.min(300000, Number(process.env.IMAGE_GATEWAY_TIMEOUT_MS) || 180000));
  const base = "https://queue.fal.run/" + model.split("/").map(encodeURIComponent).join("/");
  const headers = { authorization: "Key " + key, "content-type": "application/json" };
  const sizes = { "512x512": "square", "1024x1024": "square_hd", "1536x1024": "landscape_4_3", "1024x1536": "portrait_4_3" };
  const requestPayload = { prompt: text, image_size: sizes[size] || "square_hd", num_images: 1 };
  if (reference) requestPayload[referenceField] = reference;
  const submitted = await fetchJson(base, { method: "POST", headers, body: JSON.stringify(requestPayload) }, Math.min(timeoutMs, 30000));
  const requestId = String(submitted.request_id || "");
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(requestId)) throw Object.assign(new Error("Image provider did not return a valid request identifier."), { code: "IMAGE_GATEWAY_INVALID_RESPONSE" });
  const statusUrl = allowedQueueUrl(submitted.status_url || ("https://queue.fal.run/" + model + "/requests/" + requestId + "/status"));
  const resultUrl = allowedQueueUrl(submitted.response_url || ("https://queue.fal.run/" + model + "/requests/" + requestId));
  const deadline = Date.now() + timeoutMs;
  let result;
  while (Date.now() < deadline) {
    const status = await fetchJson(statusUrl, { headers: { authorization: "Key " + key } }, Math.min(15000, Math.max(1000, deadline - Date.now())));
    if (status.status === "COMPLETED") { result = await fetchJson(resultUrl, { headers: { authorization: "Key " + key } }, Math.min(20000, Math.max(1000, deadline - Date.now()))); break; }
    if (["FAILED", "CANCELLED"].includes(status.status)) throw Object.assign(new Error("Image provider job did not complete successfully."), { code: "IMAGE_GATEWAY_JOB_FAILED" });
    if (!["IN_QUEUE", "IN_PROGRESS"].includes(status.status)) throw Object.assign(new Error("Image provider returned an unknown job state."), { code: "IMAGE_GATEWAY_INVALID_RESPONSE" });
    await sleep(Math.min(1500, Math.max(0, deadline - Date.now())));
  }
  if (!result) throw Object.assign(new Error("Image provider job timed out before completion."), { code: "IMAGE_GATEWAY_TIMEOUT" });
  const imageUrl = String(result.images?.[0]?.url || "");
  let parsed;
  try { parsed = new URL(imageUrl); } catch { throw Object.assign(new Error("Image provider returned no valid output image URL."), { code: "IMAGE_GATEWAY_INVALID_RESPONSE" }); }
  if (parsed.protocol !== "https:" || !allowedImageHosts(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.port) {
    throw Object.assign(new Error("Image provider returned an unsafe output URL."), { code: "IMAGE_GATEWAY_INVALID_RESPONSE" });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(30000, Math.max(1000, deadline - Date.now())));
  try {
    let response;
    try { response = await fetch(parsed, { signal: controller.signal, redirect: "error" }); }
    catch (error) {
      if (error?.name === "AbortError") throw Object.assign(new Error("Generated image download timed out."), { code: "IMAGE_GATEWAY_TIMEOUT" });
      throw Object.assign(new Error("Generated image could not be downloaded safely."), { code: "IMAGE_GATEWAY_UNAVAILABLE" });
    }
    if (!response.ok) throw Object.assign(new Error("Generated image download failed."), { code: "IMAGE_GATEWAY_INVALID_RESPONSE" });
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_OUTPUT_BYTES) throw Object.assign(new Error("Generated image exceeds the 50 MiB limit."), { code: "IMAGE_GATEWAY_INVALID_RESPONSE" });
    let bytes;
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader(), chunks = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_OUTPUT_BYTES) {
            await reader.cancel().catch(() => {});
            throw Object.assign(new Error("Generated image exceeds the 50 MiB limit."), { code: "IMAGE_GATEWAY_INVALID_RESPONSE" });
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      bytes = Buffer.concat(chunks, total);
    } else {
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) throw Object.assign(new Error("Generated image is empty or exceeds the 50 MiB limit."), { code: "IMAGE_GATEWAY_INVALID_RESPONSE" });
    return { buffer: bytes, model, usage: null, provider: "fal", requestId };
  } finally { clearTimeout(timer); }
}
