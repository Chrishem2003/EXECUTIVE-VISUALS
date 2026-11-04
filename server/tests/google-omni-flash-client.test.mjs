import test from "node:test";
import assert from "node:assert/strict";
import { buildGeminiOmniFlashInteractionRequest } from "../google-omni-flash-interaction.mjs";
import { createGeminiOmniFlashClient } from "../google-omni-flash-client.mjs";

const id = "v1_abcdef123456";
const fileUri = "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media";
const env = {
  GEMINI_API_KEY: "server-google-key",
  GEMINI_OMNI_ENABLED: "true",
  GEMINI_OMNI_ALLOW_REMOTE: "true"
};

async function plan() {
  return buildGeminiOmniFlashInteractionRequest({ prompt: "A cinematic sunrise over a mountain lake" });
}
function interaction(status = "in_progress", video = null) {
  return {
    id, model: "gemini-omni-1.1-flash", status,
    steps: video ? [{ type: "model_output", content: [video] }] : []
  };
}
function response(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}
function harness({ fetchImpl, approve = async () => true, authorize = async () => true, overrides = {} } = {}) {
  const calls = [];
  const client = createGeminiOmniFlashClient({
    env: { ...env, ...overrides },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return fetchImpl ? fetchImpl(url, options) : response(200, interaction());
    },
    assertApprovedSubmission: approve,
    authorizeInteraction: authorize,
    timeoutMs: 3000
  });
  return { client, calls };
}

test("creates one stored background interaction only after durable approval", async () => {
  const h = harness();
  const result = await h.client.createInteraction(await plan(), { jobId: "job-1" });
  assert.equal(result.taskId, id);
  assert.equal(result.status, "running");
  assert.equal(result.provider, "google");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(h.calls[0].options.method, "POST");
  assert.equal(h.calls[0].options.headers["x-goog-api-key"], "server-google-key");
  const payload = JSON.parse(h.calls[0].options.body);
  assert.equal(payload.background, true);
  assert.equal(payload.store, true);
  assert.equal(payload.response_format.delivery, "uri");
  assert.equal(JSON.stringify(result).includes("server-google-key"), false);
});

test("refuses missing approval before any provider request", async () => {
  const h = harness({ approve: async () => false });
  await assert.rejects(() => h.client.createInteraction(await plan()), error =>
    error.code === "GEMINI_OMNI_APPROVAL_REQUIRED");
  assert.equal(h.calls.length, 0);
});

test("requires explicit remote flags and server-side credentials", async () => {
  const disabled = harness({ overrides: { GEMINI_OMNI_ALLOW_REMOTE: "false" } });
  await assert.rejects(() => disabled.client.createInteraction(await plan()), error =>
    error.code === "GEMINI_OMNI_REMOTE_DISABLED");
  const missing = harness({ overrides: { GEMINI_API_KEY: "" } });
  await assert.rejects(() => missing.client.createInteraction(await plan()), error =>
    error.code === "GEMINI_OMNI_CONFIG_MISSING");
});

test("does not retry an ambiguous interaction POST", async () => {
  let attempts = 0;
  const h = harness({
    fetchImpl: async () => { attempts++; throw new TypeError("connection reset"); }
  });
  await assert.rejects(() => h.client.createInteraction(await plan()), error =>
    error.code === "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
  assert.equal(attempts, 1);
});

test("treats provider 5xx on submission as an unknown outcome", async () => {
  const h = harness({ fetchImpl: async () => response(503, { error: "temporarily unavailable" }) });
  await assert.rejects(() => h.client.createInteraction(await plan()), error =>
    error.code === "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
  assert.equal(h.calls.length, 1);
});

test("retrieves completed interactions and returns only validated Google output URIs", async () => {
  const h = harness({
    fetchImpl: async () => response(200, interaction("completed", {
      type: "video", mime_type: "video/mp4", uri: fileUri
    }))
  });
  const result = await h.client.getInteraction(id, { ownerId: "owner-1", projectId: "project-1" });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.outputUrls, [fileUri]);
  assert.equal(h.calls[0].options.method, "GET");
});

test("enforces owner/project authorization before retrieval, cancellation and deletion", async () => {
  const h = harness({ authorize: async ({ action }) => action !== "delete" });
  await assert.rejects(() => h.client.getInteraction(id), error =>
    error.code === "GEMINI_OMNI_INTERACTION_FORBIDDEN");
  await assert.rejects(() => h.client.cancelInteraction(id), error =>
    error.code === "GEMINI_OMNI_INTERACTION_FORBIDDEN");
  await assert.rejects(() => h.client.deleteInteraction(id), error =>
    error.code === "GEMINI_OMNI_INTERACTION_FORBIDDEN");
  assert.equal(h.calls.length, 0);
});

test("cancels and deletes only authorized, syntactically valid interaction IDs", async () => {
  const h = harness({
    fetchImpl: async (url, options) => {
      if (options.method === "POST") return response(200, interaction("cancelled"));
      return response(204, null);
    }
  });
  const cancelled = await h.client.cancelInteraction(id, { ownerId: "owner-1", projectId: "project-1" });
  assert.equal(cancelled.status, "canceled");
  assert.equal(cancelled.cancelRequested, true);
  const deleted = await h.client.deleteInteraction(id, { ownerId: "owner-1", projectId: "project-1" });
  assert.equal(deleted.deleted, true);
  assert.equal(h.calls.length, 2);
  await assert.rejects(() => h.client.getInteraction("https://attacker.example/" + id), error =>
    error.code === "GEMINI_OMNI_INVALID_INTERACTION_ID");
});

test("rejects inline output plans and malformed provider response payloads", async () => {
  const h = harness();
  const inline = await buildGeminiOmniFlashInteractionRequest({
    prompt: "A sunrise", delivery: "inline"
  });
  await assert.rejects(() => h.client.createInteraction(inline), error =>
    error.code === "GEMINI_OMNI_PLAN_INVALID");
  const bad = harness({ fetchImpl: async () => response(200, { id, model: "wrong", status: "completed", steps: [] }) });
  await assert.rejects(() => bad.client.createInteraction(await plan()), error =>
    error.code === "GEMINI_OMNI_INVALID_RESPONSE");
});
