import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleOmniVertexClient } from "../google-omni-vertex-client.mjs";

const projectId = "executive-visuals-test";
const bucket = "executive-visuals-test-media";
const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const jobId = "223e4567-e89b-42d3-a456-426614174000";
const requestHash = "a".repeat(64);
const interactionId = "v1_abcdef123456";
const token = "vertex-test-access-token-1234567890";
const authClient = { async getClient() { return { async getAccessToken() { return { token }; } }; } };
const plan = {
  policy: { provider: "google", model: "gemini-omni-1.2-flash", requiresApproval: true },
  payload: {
    model: "gemini-omni-1.2-flash",
    input: [{ type: "text", text: "A cinematic sunrise over Kampala." }],
    response_format: { type: "video", aspect_ratio: "16:9", resolution: "720p", duration: "15s" },
    generation_config: { video_config: { task: "text_to_video" } }
  }
};
const context = { jobId, ownerId, requestHash };

test("Vertex client submits an approved Omni 1.2 interaction to the project-scoped endpoint", async () => {
  const calls = [];
  const client = createGoogleOmniVertexClient({
    projectId, outputBucket: bucket, authClient,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ id: interactionId, model: "gemini-omni-1.2-flash", status: "in_progress" }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
  });
  const events = [];
  const result = await client.createInteraction(plan, context, {
    onInteractionCreated: async value => events.push(value)
  });
  assert.equal(result.interactionId, interactionId);
  assert.equal(result.provider, "google");
  assert.equal(result.model, "gemini-omni-1.2-flash");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://aiplatform.googleapis.com/v1beta1/projects/" + projectId + "/locations/global/interactions");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.authorization, "Bearer " + token);
  assert.equal(calls[0].body.model, "gemini-omni-1.2-flash");
  assert.equal(calls[0].body.store, true);
  assert.equal(calls[0].body.background, true);
  assert.deepEqual(calls[0].body.labels, {
    application: "executive_visuals", component: "video_generation",
    provider: "google", model: "omni_1_2_flash"
  });
  assert.equal(JSON.stringify(calls[0].body.labels).includes(jobId), false);
  assert.equal(Array.isArray(calls[0].body.response_format), true);
  assert.equal(calls[0].body.response_format.length, 1);
  assert.equal(calls[0].body.response_format[0].delivery, "uri");
  assert.equal(calls[0].body.response_format[0].gcs_uri,
    "gs://" + bucket + "/executive-visuals/omni-12/" + jobId + "/" + requestHash + "/");
  assert.deepEqual(events, [{
    interactionId, status: "in_progress", model: "gemini-omni-1.2-flash",
    outputUri: calls[0].body.response_format[0].gcs_uri
  }]);
});

test("Vertex client retrieves only the requested model interaction", async () => {
  const calls = [];
  const client = createGoogleOmniVertexClient({
    projectId, outputBucket: bucket, authClient,
    fetchImpl: async url => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: interactionId, model: "gemini-omni-1.2-flash", status: "completed", steps: [] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
  });
  const result = await client.getInteractionForIngestion(interactionId, context);
  assert.equal(result.id, interactionId);
  assert.equal(result.status, "completed");
  assert.equal(calls[0], "https://aiplatform.googleapis.com/v1beta1/projects/" + projectId + "/locations/global/interactions/" + interactionId);
});

test("Vertex client rejects an unapproved plan before obtaining credentials or calling Google", async () => {
  let requests = 0;
  const client = createGoogleOmniVertexClient({
    projectId, outputBucket: bucket,
    authClient: { async getClient() { throw new Error("must not authenticate"); } },
    fetchImpl: async () => { requests++; throw new Error("must not call"); }
  });
  await assert.rejects(() => client.createInteraction({
    ...plan, policy: { ...plan.policy, requiresApproval: false }
  }, context, { onInteractionCreated: async () => {} }), error => error.code === "GOOGLE_VERTEX_PLAN_INVALID");
  assert.equal(requests, 0);
});

test("Vertex client rejects invalid project, bucket, output path and mismatched provider responses", async () => {
  assert.throws(() => createGoogleOmniVertexClient({ projectId: "bad", outputBucket: bucket }), /project ID/);
  assert.throws(() => createGoogleOmniVertexClient({ projectId, outputBucket: "Bad Bucket" }), /GCS output bucket/);
  const client = createGoogleOmniVertexClient({ projectId, outputBucket: bucket, authClient });
  assert.throws(() => client.outputUri({ jobId: "../escape", requestHash }), error => error.code === "GOOGLE_VERTEX_CONTEXT_INVALID");
  const wrong = createGoogleOmniVertexClient({
    projectId, outputBucket: bucket, authClient,
    fetchImpl: async () => new Response(JSON.stringify({ id: interactionId, model: "wrong-model", status: "completed" }), { status: 200 })
  });
  await assert.rejects(() => wrong.getInteractionForIngestion(interactionId, context),
    error => error.code === "GOOGLE_VERTEX_RESPONSE_INVALID");
});

test("Vertex client rejects oversized interaction responses before parsing", async () => {
  const client = createGoogleOmniVertexClient({
    projectId, outputBucket: bucket, authClient, maxResponseBytes: 1024,
    fetchImpl: async () => new Response("x".repeat(2048), {
      status: 200, headers: { "content-type": "application/json", "content-length": "2048" }
    })
  });
  await assert.rejects(() => client.getInteractionForIngestion(interactionId, context),
    error => error.code === "GOOGLE_VERTEX_RESPONSE_TOO_LARGE");
});

test("Vertex client preserves non-video response formats while enforcing a single private video destination", async () => {
  let sent;
  const client = createGoogleOmniVertexClient({
    projectId, outputBucket: bucket, authClient,
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: interactionId, model: "gemini-omni-1.2-flash", status: "in_progress" }), { status: 200 });
    }
  });
  const multiFormatPlan = {
    ...plan,
    payload: {
      ...plan.payload,
      response_format: [
        { type: "text", format: "text" },
        { type: "video", aspect_ratio: "9:16", duration: "15s", resolution: "4k" }
      ]
    }
  };
  await client.createInteraction(multiFormatPlan, context, { onInteractionCreated: async () => {} });
  assert.deepEqual(sent.response_format[0], { type: "text", format: "text" });
  assert.equal(sent.response_format[1].type, "video");
  assert.equal(sent.response_format[1].delivery, "uri");
  assert.equal(sent.response_format[1].gcs_uri, client.outputUri(context));
  assert.equal(sent.response_format[1].duration, "15s");
  assert.equal(sent.generation_config.video_config.task, "text_to_video");
});

test("Vertex client rejects requests without an explicit video task", async () => {
  const client = createGoogleOmniVertexClient({
    projectId, outputBucket: bucket, authClient,
    fetchImpl: async () => { throw new Error("must not submit"); }
  });
  await assert.rejects(() => client.createInteraction({
    ...plan, payload: { ...plan.payload, generation_config: {} }
  }, context, { onInteractionCreated: async () => {} }),
  error => error.code === "GOOGLE_VERTEX_PLAN_INVALID");
});


test("Vertex client uses the documented interactions cancel endpoint with an empty request body", async () => {
  let sent;
  const client = createGoogleOmniVertexClient({
    projectId, outputBucket: bucket, authClient,
    fetchImpl: async (url, options) => {
      sent = { url: String(url), options };
      return new Response(null, { status: 200 });
    }
  });
  const result = await client.cancelInteraction(interactionId, context);
  assert.equal(result.status, "cancel_requested");
  assert.equal(sent.url, "https://aiplatform.googleapis.com/v1/projects/" + projectId + "/locations/global/interactions/" + interactionId + "/cancel");
  assert.equal(sent.options.method, "POST");
  assert.equal(sent.options.body, undefined);
});

test("Vertex client refuses polling and cancellation without an authorized job scope", async () => {
  let requests = 0;
  const client = createGoogleOmniVertexClient({
    projectId, outputBucket: bucket, authClient,
    fetchImpl: async () => { requests++; throw new Error("must not call"); }
  });
  await assert.rejects(() => client.getInteractionForIngestion(interactionId, { ownerId }), error =>
    error.code === "GOOGLE_VERTEX_CONTEXT_INVALID");
  await assert.rejects(() => client.cancelInteraction(interactionId, { jobId }), error =>
    error.code === "GOOGLE_VERTEX_CONTEXT_INVALID");
  assert.equal(requests, 0);
});
