import test from "node:test";
import assert from "node:assert/strict";
import { generateImage } from "../image-gateway.mjs";

const keys = ["IMAGE_GATEWAY_ENABLED", "IMAGE_GATEWAY_ALLOW_REMOTE", "IMAGE_GATEWAY_PROVIDER", "IMAGE_GATEWAY_TIMEOUT_MS", "FAL_KEY", "FAL_IMAGE_MODEL"];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
function restore() { for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key]; }
function response(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(headers), text: async () => typeof body === "string" ? body : JSON.stringify(body), arrayBuffer: async () => Buffer.from(body) };
}

test("optional async image adapter submits, polls, and returns provider image bytes", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  process.env.IMAGE_GATEWAY_ENABLED = "true";
  process.env.IMAGE_GATEWAY_ALLOW_REMOTE = "true";
  process.env.IMAGE_GATEWAY_PROVIDER = "fal";
  process.env.IMAGE_GATEWAY_TIMEOUT_MS = "10000";
  process.env.FAL_KEY = "test-key";
  process.env.FAL_IMAGE_MODEL = "fal-ai/flux/schnell";
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed.toString(), method: options.method || "GET", body: options.body, headers: options.headers || {} });
    if (options.method === "POST") return response(200, { request_id: "request_123", status_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/request_123/status", response_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/request_123" });
    if (parsed.hostname === "queue.fal.run" && parsed.pathname.endsWith("/status")) return response(200, { status: "COMPLETED" });
    if (parsed.hostname === "queue.fal.run") return response(200, { images: [{ url: "https://v3.fal.media/files/test-output.png" }] });
    if (parsed.hostname === "v3.fal.media") return response(200, Buffer.from([137,80,78,71,13,10,26,10,1,2,3]), { "content-length": "11", "content-type": "image/png" });
    throw new Error("Unexpected outbound host");
  };
  try {
    const result = await generateImage({ prompt: "A cinematic original landscape", size: "1024x1024" });
    assert.equal(result.provider, "fal");
    assert.equal(result.requestId, "request_123");
    assert.equal(result.model, "fal-ai/flux/schnell");
    assert.deepEqual([...result.buffer], [137,80,78,71,13,10,26,10,1,2,3]);
    assert.equal(calls[0].url, "https://queue.fal.run/fal-ai/flux/schnell");
    assert.equal(calls[0].headers.authorization, "Key test-key");
    assert.equal(JSON.parse(calls[0].body).prompt, "A cinematic original landscape");
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("async image adapter fails closed without remote opt-in and rejects untrusted output hosts", async () => {
  const originalFetch = globalThis.fetch;
  process.env.IMAGE_GATEWAY_ENABLED = "true";
  process.env.IMAGE_GATEWAY_PROVIDER = "fal";
  process.env.IMAGE_GATEWAY_ALLOW_REMOTE = "false";
  process.env.FAL_KEY = "test-key";
  process.env.FAL_IMAGE_MODEL = "fal-ai/flux/schnell";
  try {
    await assert.rejects(() => generateImage({ prompt: "test" }), error => error.code === "IMAGE_GATEWAY_REMOTE_DISABLED");
    process.env.IMAGE_GATEWAY_ALLOW_REMOTE = "true";
    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (options.method === "POST") return response(200, { request_id: "request_123", status_url: "https://queue.fal.run/status", response_url: "https://queue.fal.run/result" });
      if (parsed.pathname === "/status") return response(200, { status: "COMPLETED" });
      if (parsed.pathname === "/result") return response(200, { images: [{ url: "https://attacker.example/steal-or-ssrf" }] });
      throw new Error("Unexpected fetch");
    };
    await assert.rejects(() => generateImage({ prompt: "test" }), error => error.code === "IMAGE_GATEWAY_INVALID_RESPONSE");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("image gateway rejects unknown provider names instead of silently falling back", async () => {
  const originalFetch = globalThis.fetch;
  process.env.IMAGE_GATEWAY_PROVIDER = "unknown-provider";
  let requested = false;
  globalThis.fetch = async () => { requested = true; throw new Error("network should not be used"); };
  try {
    await assert.rejects(() => generateImage({ prompt: "test" }), error => error.code === "IMAGE_GATEWAY_CONFIG_INVALID");
    assert.equal(requested, false);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});
