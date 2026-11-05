import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleVideoInteractionRepository } from "../google-video-interaction-repository.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const jobId = "223e4567-e89b-42d3-a456-426614174000";
const projectId = "323e4567-e89b-42d3-a456-426614174000";
const interactionId = "v1_abcdef123456";
const requestHash = "a".repeat(64);
const now = new Date(Date.now() + 86400000).toISOString();
function row(overrides = {}) {
  return {
    id: "423e4567-e89b-42d3-a456-426614174000",
    provider: "google", model: "gemini-omni-1.1-flash",
    interaction_id: interactionId, job_id: jobId, owner_id: ownerId,
    project_id: projectId, request_hash: requestHash,
    parent_interaction_id: null, state: "running", output_file_name: null, output_uri: null,
    submitted_at: new Date().toISOString(), expires_at: now, deleted_at: null, metadata: {},
    ...overrides
  };
}
function harness(handler) {
  const calls = [];
  const repository = createGoogleVideoInteractionRepository({
    url: "https://project.supabase.co",
    serviceRoleKey: "server-service-role",
    timeoutMs: 3000,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return handler(url, options);
    }
  });
  return { repository, calls };
}
function response(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}
const scope = { interactionId, ownerId, projectId, jobId };

test("records a durable owner/project/job scoped interaction without storing media bytes", async () => {
  const h = harness(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.owner_id, ownerId);
    assert.equal(body.project_id, projectId);
    assert.equal(body.job_id, jobId);
    assert.equal(body.interaction_id, interactionId);
    assert.equal("video" in body, false);
    return response(201, [row({ output_uri: body.output_uri })]);
  });
  const result = await h.repository.recordInteraction({
    provider: "google", model: "gemini-omni-1.1-flash",
    ...scope, requestHash, state: "running", expiresAt: now,
    outputUri: "https://generativelanguage.googleapis.com/v1beta/files/generated123"
  });
  assert.equal(result.interactionId, interactionId);
  assert.equal(result.ownerId, ownerId);
  assert.equal(result.outputUri, "https://generativelanguage.googleapis.com/v1beta/files/generated123");
  assert.equal(h.calls[0].options.headers["content-profile"], "executive_visuals");
  assert.equal(h.calls[0].options.headers.authorization, "Bearer server-service-role");
});

test("finds interactions only within exact owner/project/job scope", async () => {
  const h = harness(async url => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("interaction_id"), "eq." + interactionId);
    assert.equal(parsed.searchParams.get("owner_id"), "eq." + ownerId);
    assert.equal(parsed.searchParams.get("project_id"), "eq." + projectId);
    assert.equal(parsed.searchParams.get("job_id"), "eq." + jobId);
    return response(200, [row()]);
  });
  const result = await h.repository.findInteraction(scope);
  assert.equal(result.jobId, jobId);
});

test("updates and deletes only a matching scoped interaction", async () => {
  const h = harness(async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("owner_id"), "eq." + ownerId);
    assert.equal(parsed.searchParams.get("job_id"), "eq." + jobId);
    if (options.method === "PATCH" && JSON.parse(options.body).state === "deleted") {
      return response(200, [row({ state: "deleted", deleted_at: new Date().toISOString() })]);
    }
    const body = JSON.parse(options.body);
    return response(200, [row({ state: body.state, output_uri: body.output_uri ?? null })]);
  });
  assert.equal((await h.repository.updateInteraction({ ...scope, state: "succeeded", outputUri: "https://generativelanguage.googleapis.com/v1beta/files/generated123" })).outputUri, "https://generativelanguage.googleapis.com/v1beta/files/generated123");
  assert.equal((await h.repository.markInteractionDeleted(scope)).state, "deleted");
});

test("lists bounded expired interactions for retention cleanup", async () => {
  const h = harness(async url => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("state"), "not.eq.deleted");
    assert.equal(parsed.searchParams.get("limit"), "10");
    return response(200, [row({ state: "succeeded", expires_at: new Date(Date.now() - 1000).toISOString() })]);
  });
  const rows = await h.repository.listExpired({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "succeeded");
});

test("rejects malformed IDs, scope, model, status and expiry before network calls", async () => {
  const h = harness(async () => response(200, []));
  await assert.rejects(() => h.repository.findInteraction({ ...scope, interactionId: "https://attacker.invalid" }));
  await assert.rejects(() => h.repository.recordInteraction({
    provider: "google", model: "wrong", ...scope, requestHash, state: "running", expiresAt: now
  }));
  await assert.rejects(() => h.repository.recordInteraction({
    provider: "google", model: "gemini-omni-1.1-flash", ...scope,
    requestHash, state: "running", expiresAt: "not-a-date"
  }));
  assert.equal(h.calls.length, 0);
});
