import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiGcsIamVerifier } from "../google-gemini-gcs-iam-verifier.mjs";

const env = {
  GOOGLE_CLOUD_PROJECT_ID: "test-gcp-project-12345",
  GOOGLE_CLOUD_PROJECT_NUMBER: "123456789012",
  GEMINI_GCS_ALLOWED_BUCKETS: "private-media-bucket,approved-assets"
};
const serviceAgent = "service-123456789012@gcp-sa-generativelanguage.iam.gserviceaccount.com";
const token = "oauth-test-access-token-123456";

function response(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}
function harness({ apiState = "ENABLED", policies = {}, fetchImpl } = {}) {
  const calls = [];
  const verifier = createGoogleGeminiGcsIamVerifier({
    env,
    getAccessToken: async options => {
      calls.push({ type: "token", options });
      return token;
    },
    fetchImpl: async (url, options) => {
      calls.push({ type: "fetch", url: String(url), options });
      if (fetchImpl) return fetchImpl(url, options);
      if (String(url).includes("serviceusage.googleapis.com")) return response(200, { state: apiState });
      const bucket = decodeURIComponent(new URL(url).pathname.split("/").at(-2));
      return response(200, policies[bucket] || { bindings: [] });
    }
  });
  return { verifier, calls };
}

test("confirms Gemini API enablement and exact service-agent object-viewer grants on every allowlisted bucket", async () => {
  const policy = {
    bindings: [{
      role: "roles/storage.objectViewer",
      members: ["serviceAccount:" + serviceAgent]
    }]
  };
  const h = harness({ policies: { "private-media-bucket": policy, "approved-assets": policy } });
  const result = await h.verifier.check();
  assert.equal(result.ready, true);
  assert.equal(result.apiEnabled, true);
  assert.equal(result.serviceAgent, serviceAgent);
  assert.deepEqual(result.buckets, [
    { bucket: "private-media-bucket", serviceAgentHasObjectViewer: true },
    { bucket: "approved-assets", serviceAgentHasObjectViewer: true }
  ]);
  const tokenCall = h.calls.find(call => call.type === "token");
  assert.deepEqual(tokenCall.options.scopes, [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/devstorage.read_only"
  ]);
  assert.ok(h.calls.filter(call => call.type === "fetch").every(call => call.options.method === "GET"));
  assert.ok(h.calls.filter(call => call.type === "fetch").every(call => call.options.redirect === "error"));
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("fails readiness when the Gemini API is disabled or any bucket grant is missing", async () => {
  const policy = {
    bindings: [{
      role: "roles/storage.objectViewer",
      members: ["serviceAccount:" + serviceAgent]
    }]
  };
  const disabled = harness({ apiState: "DISABLED", policies: {
    "private-media-bucket": policy, "approved-assets": policy
  }});
  assert.equal((await disabled.verifier.check()).ready, false);

  const missing = harness({ policies: { "private-media-bucket": policy } });
  const result = await missing.verifier.check();
  assert.equal(result.ready, false);
  assert.equal(result.buckets[0].serviceAgentHasObjectViewer, true);
  assert.equal(result.buckets[1].serviceAgentHasObjectViewer, false);
});

test("does not accept conditional or unrelated IAM bindings as a durable bucket grant", async () => {
  const h = harness({ policies: {
    "private-media-bucket": { bindings: [{
      role: "roles/storage.objectViewer",
      members: ["serviceAccount:" + serviceAgent],
      condition: { title: "temporary" }
    }] },
    "approved-assets": { bindings: [{
      role: "roles/storage.objectViewer",
      members: ["serviceAccount:someone-else@example.iam.gserviceaccount.com"]
    }] }
  }});
  const result = await h.verifier.check();
  assert.equal(result.ready, false);
  assert.ok(result.buckets.every(item => item.serviceAgentHasObjectViewer === false));
});

test("rejects missing project number, unsafe buckets and missing allowlist before network access", () => {
  for (const invalid of [
    { ...env, GOOGLE_CLOUD_PROJECT_NUMBER: "" },
    { ...env, GEMINI_GCS_ALLOWED_BUCKETS: "private-media-bucket,../other" },
    { ...env, GEMINI_GCS_ALLOWED_BUCKETS: "" }
  ]) {
    let calls = 0;
    assert.throws(() => createGoogleGeminiGcsIamVerifier({
      env: invalid,
      getAccessToken: async () => token,
      fetchImpl: async () => { calls++; }
    }));
    assert.equal(calls, 0);
  }
});

test("fails closed on IAM API errors without exposing provider response details", async () => {
  const h = harness({ fetchImpl: async () => response(403, { error: { message: "private detail" } }) });
  await assert.rejects(
    () => h.verifier.check(),
    error => error.code === "GEMINI_GCS_IAM_PREFLIGHT_FORBIDDEN" && !error.message.includes("private detail")
  );
});
