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
    response_format: { type: "video", aspect_ratio: "16:9", resolution: "720p" }
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
  assert.equal(calls[0].body.response_format.delivery, "uri");
  assert.equal(calls[0].body.response_format.gcs_uri,
    "gs://" + bucket + "/executive-visuals/omni-12/" + jobId + "/" + requestHash + "/");
  assert.deepEqual(events, [{
    interactionId, status: "in_progress", model: "gemini-omni-1.2-flash",
    outputUri: calls[0].body.response_format.gcs_uri
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
  assert.equal(calls[0], "https://aiplatform.googleapis.com/v1beta1/projects/" + projectId +
    "/locations/global/interactions/" + interactionId);
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
