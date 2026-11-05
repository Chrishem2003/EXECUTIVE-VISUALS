import test from "node:test";
import assert from "node:assert/strict";
import { buildGeminiOmniFlashInteractionRequest } from "../google-omni-flash-interaction.mjs";
import { createGeminiOmniFlashClient } from "../google-omni-flash-client.mjs";

const id = "v1_abcdef123456";
const fileUri = "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media";
const env = {
  GEMINI_API_KEY: "server-google-key",
  GEMINI_OMNI_ENABLED: "true",
  GEMINI_OMNI_ALLOW_REMOTE: "true",
  GEMINI_OMNI_PAID_TIER_CONFIRMED: "true"
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
function harness({ fetchImpl, approve = async () => true, authorize = async () => true, overrides = {}, maxResponseBytes = 4 * 1024 * 1024 } = {}) {
  const calls = [];
  const client = createGeminiOmniFlashClient({
    env: { ...env, ...overrides },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return fetchImpl ? fetchImpl(url, options) : response(200, interaction());
    },
    assertApprovedSubmission: approve,
    authorizeInteraction: authorize,
    timeoutMs: 3000,
    streamTimeoutMs: 3000,
    maxResponseBytes
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


test("captures the creation ID and video URI from bounded SSE events", async () => {
  const events = [
    { event_type: "interaction.created", interaction: { id, model: "gemini-omni-1.1-flash", status: "in_progress" } },
    { event_type: "step.start", index: 0, step: { type: "model_output" } },
    { event_type: "step.delta", index: 0, delta: { type: "video", mime_type: "video/mp4", uri: fileUri } },
    { event_type: "interaction.completed", interaction: { id, model: "gemini-omni-1.1-flash", status: "completed", usage: { total_tokens: 12 } } }
  ];
  const body = events.map(event => "event: " + event.event_type + "\ndata: " + JSON.stringify(event) + "\n\n").join("") + "event: done\ndata: [DONE]\n\n";
  const h = harness({ fetchImpl: async () => new Response(body, {
    status: 200, headers: { "content-type": "text/event-stream" }
  }) });
  const persisted = [];
  const result = await h.client.createInteraction(await plan(), { jobId: "job-1" }, {
    onInteractionCreated: async event => persisted.push(event)
  });
  assert.equal(result.interactionId, id);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.outputUrls, [fileUri]);
  assert.equal(result.usage.total_tokens, 12);
  assert.deepEqual(persisted, [{ interactionId: id, status: "running", model: "gemini-omni-1.1-flash" }]);
  const payload = JSON.parse(h.calls[0].options.body);
  assert.equal(payload.stream, true);
  assert.equal(payload.background, true);
});

test("preserves durable creation callback when an SSE stream is interrupted", async () => {
  const event = { event_type: "interaction.created", interaction: { id, model: "gemini-omni-1.1-flash", status: "in_progress" } };
  const body = "event: interaction.created\ndata: " + JSON.stringify(event) + "\n\n";
  const h = harness({ fetchImpl: async () => new Response(body, {
    status: 200, headers: { "content-type": "text/event-stream" }
  }) });
  const persisted = [];
  await assert.rejects(async () => h.client.createInteraction(await plan(), {}, {
    onInteractionCreated: async value => persisted.push(value)
  }), error => error.code === "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].interactionId, id);
});

test("refuses missing approval before any provider request", async () => {
  const h = harness({ approve: async () => false });
  await assert.rejects(async () => h.client.createInteraction(await plan()), error =>
    error.code === "GEMINI_OMNI_APPROVAL_REQUIRED");
  assert.equal(h.calls.length, 0);
});

test("requires explicit remote flags and server-side credentials", async () => {
  const disabled = harness({ overrides: { GEMINI_OMNI_ALLOW_REMOTE: "false" } });
  await assert.rejects(async () => disabled.client.createInteraction(await plan()), error =>
    error.code === "GEMINI_OMNI_REMOTE_DISABLED");
  const missing = harness({ overrides: { GEMINI_API_KEY: "" } });
  await assert.rejects(async () => missing.client.createInteraction(await plan()), error =>
    error.code === "GEMINI_OMNI_CONFIG_MISSING");
});

test("does not retry an ambiguous interaction POST", async () => {
  let attempts = 0;
  const h = harness({
    fetchImpl: async () => { attempts++; throw new TypeError("connection reset"); }
  });
  await assert.rejects(async () => h.client.createInteraction(await plan()), error =>
    error.code === "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
  assert.equal(attempts, 1);
});

test("treats provider 5xx on submission as an unknown outcome", async () => {
  const h = harness({ fetchImpl: async () => response(503, { error: "temporarily unavailable" }) });
  await assert.rejects(async () => h.client.createInteraction(await plan()), error =>
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
  assert.equal(new URL(h.calls[0].url).searchParams.get("fields"),
    "id,model,status,steps(type,content(type,mime_type,uri))");
});

test("enforces owner/project authorization before retrieval, cancellation and deletion", async () => {
  const h = harness({ authorize: async () => false });
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

test("rejects inline plans and treats malformed successful responses as ambiguous submissions", async () => {
  const h = harness();
  const inline = await buildGeminiOmniFlashInteractionRequest({
    prompt: "A sunrise", delivery: "inline"
  });
  await assert.rejects(() => h.client.createInteraction(inline), error =>
    error.code === "GEMINI_OMNI_PLAN_INVALID");
  const valid = await plan();
  const forged = {
    ...valid,
    payload: {
      ...valid.payload,
      input: [
        { type: "image", uri: "https://attacker.example/private-media" },
        { type: "text", text: "Describe this image" }
      ]
    }
  };
  await assert.rejects(() => h.client.createInteraction(forged), error =>
    error.code === "GEMINI_OMNI_PLAN_INVALID");
  const bad = harness({ fetchImpl: async () => response(200, { id, model: "wrong", status: "completed", steps: [] }) });
  await assert.rejects(async () => bad.client.createInteraction(await plan()), error =>
    error.code === "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
});

test("treats an already-deleted Google interaction as an idempotent success", async () => {
  const h = harness({ fetchImpl: async () => response(404, { error: "not found" }) });
  const result = await h.client.deleteInteraction(id, { ownerId: "owner-1", projectId: "project-1" });
  assert.equal(result.deleted, true);
  assert.equal(result.interactionId, id);
  assert.equal(h.calls.length, 1);
});

test("requires paid-tier confirmation independently of general remote feature flags", async () => {
  const h = harness({ overrides: { GEMINI_OMNI_PAID_TIER_CONFIRMED: "false" } });
  await assert.rejects(async () => h.client.createInteraction(await plan()), error =>
    error.code === "GEMINI_OMNI_PAID_TIER_REQUIRED");
  assert.equal(h.calls.length, 0);
});

test("allows authorized retention cleanup after generation has been disabled", async () => {
  const h = harness({
    overrides: {
      GEMINI_OMNI_ENABLED: "false",
      GEMINI_OMNI_ALLOW_REMOTE: "false",
      GEMINI_OMNI_PAID_TIER_CONFIRMED: "false",
      GEMINI_OMNI_CLEANUP_ENABLED: "true"
    },
    fetchImpl: async () => response(204, null)
  });
  const result = await h.client.deleteInteraction(id, { ownerId: "owner-1", projectId: "project-1" });
  assert.equal(result.deleted, true);
  assert.equal(h.calls.length, 1);
});

test("accepts only short-lived private Supabase signed media URLs from the configured asset bucket", async () => {
  const supabaseUrl = "https://private-project.supabase.co";
  const mediaUrl = supabaseUrl + "/storage/v1/object/sign/executive-visuals-media/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/clip.mp4?token=short-lived-secret";
  const privatePlan = await buildGeminiOmniFlashInteractionRequest({
    prompt: "Animate the private clip",
    projectId: "22222222-2222-4222-8222-222222222222",
    sourceVideoAssetId: "33333333-3333-4333-8333-333333333333",
    operation: "edit",
    getAuthorizedAssetContext: async () => ({ownerId:"11111111-1111-4111-8111-111111111111",projectId:"22222222-2222-4222-8222-222222222222"}),
    resolveGoogleFileAsset: async () => ({uri:mediaUrl,sourceType:"signed_url",mediaType:"video",sizeBytes:1024,expiresAt:new Date(Date.now()+600000).toISOString(),durationSeconds:5})
  });
  const h = harness({overrides:{SUPABASE_URL:supabaseUrl}});
  const result = await h.client.createInteraction(privatePlan);
  assert.equal(result.status,"running");
  const payload=JSON.parse(h.calls[0].options.body);
  assert.equal(payload.input[0].uri,mediaUrl);
});

test("rejects external media URLs from other origins, buckets and with extra query parameters", async () => {
  const supabaseUrl = "https://private-project.supabase.co";
  const base = supabaseUrl + "/storage/v1/object/sign/executive-visuals-media/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/clip.mp4";
  const unsafe = [
    "https://attacker.example" + base.slice(supabaseUrl.length) + "?token=x",
    supabaseUrl + "/storage/v1/object/sign/other-bucket/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/clip.mp4?token=x",
    base + "?token=x&download=1",
    base + "?token=x#fragment",
    "http://" + base.slice("https://".length) + "?token=x"
  ];
  for (const uri of unsafe) {
    const forged = {
      endpoint:"https://generativelanguage.googleapis.com/v1beta/interactions",
      method:"POST",auth:{headerName:"x-goog-api-key",credentialSource:"server-only"},
      policy:{provider:"google",model:"gemini-omni-1.1-flash",requiresApproval:true},
      payload:{model:"gemini-omni-1.1-flash",input:[{type:"video",uri}],response_format:{type:"video",aspect_ratio:"16:9",resolution:"720p",delivery:"uri"}}
    };
    const h = harness({overrides:{SUPABASE_URL:supabaseUrl}});
    await assert.rejects(()=>h.client.createInteraction(forged),error=>error.code==="GEMINI_OMNI_PLAN_INVALID");
    assert.equal(h.calls.length,0);
  }
});


test("bounds interaction polling response bytes before JSON parsing", async () => {
  const oversized = {
    id, model: "gemini-omni-1.1-flash", status: "in_progress", steps: [],
    padding: "x".repeat(4096)
  };
  const h = harness({
    maxResponseBytes: 1024,
    fetchImpl: async () => response(200, oversized)
  });
  await assert.rejects(
    () => h.client.getInteraction(id, { ownerId: "owner-1", projectId: "project-1" }),
    error => error.code === "GEMINI_OMNI_RESPONSE_TOO_LARGE"
  );
  assert.equal(h.calls.length, 1);
});
