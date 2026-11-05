import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoogleGeminiGcsMirrorBootstrap } from "../google-gemini-gcs-mirror-bootstrap.mjs";

const env = {
  GOOGLE_CLOUD_PROJECT_ID: "executive-visuals-staging",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "server-only-test-secret",
  GEMINI_GCS_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
};

test("GCS bootstrap uses ADC with explicit project and requested scopes", async () => {
  const constructed = [], requested = [];
  class FakeGoogleAuth {
    constructor(options) { constructed.push(options); }
    async getClient() {
      return { async getAccessToken() { requested.push(true); return { token: "a".repeat(40) }; } };
    }
  }
  const bootstrap = await createGoogleGeminiGcsMirrorBootstrap({ env, GoogleAuthClass: FakeGoogleAuth });
  const token = await bootstrap.getAccessToken({ projectId: env.GOOGLE_CLOUD_PROJECT_ID, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  assert.equal(token, "a".repeat(40));
  assert.equal(constructed.length, 1);
  assert.equal(constructed[0].projectId, env.GOOGLE_CLOUD_PROJECT_ID);
  assert.deepEqual(constructed[0].scopes, ["https://www.googleapis.com/auth/cloud-platform"]);
  assert.equal(requested.length, 1);
  assert.equal(typeof bootstrap.createService, "function");
});

test("GCS bootstrap reuses ADC clients by normalized scope set", async () => {
  let clients = 0;
  class FakeGoogleAuth {
    constructor() { clients++; }
    async getClient() { return { async getAccessToken() { return "b".repeat(40); } }; }
  }
  const bootstrap = await createGoogleGeminiGcsMirrorBootstrap({ env, GoogleAuthClass: FakeGoogleAuth });
  await bootstrap.getAccessToken({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  await bootstrap.getAccessToken({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  assert.equal(clients, 1);
});

test("GCS bootstrap rejects missing encryption and project configuration", async () => {
  class FakeGoogleAuth { async getClient() { return { async getAccessToken() { return "c".repeat(40); } }; } }
  await assert.rejects(createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GEMINI_GCS_SESSION_ENCRYPTION_KEY: "" }, GoogleAuthClass: FakeGoogleAuth }), /GEMINI_GCS_SESSION_ENCRYPTION_KEY/);
  await assert.rejects(createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GOOGLE_CLOUD_PROJECT_ID: "" }, GoogleAuthClass: FakeGoogleAuth }), /GOOGLE_CLOUD_PROJECT_ID/);
});

test("GCS bootstrap rejects cross-project requests, invalid scopes and malformed tokens", async () => {
  class FakeGoogleAuth {
    constructor() {}
    async getClient() { return { async getAccessToken() { return "short"; } }; }
  }
  const bootstrap = await createGoogleGeminiGcsMirrorBootstrap({ env, GoogleAuthClass: FakeGoogleAuth });
  await assert.rejects(bootstrap.getAccessToken({ projectId: "another-project" }), /project does not match/);
  await assert.rejects(bootstrap.getAccessToken({ scopes: ["not-a-url"] }), /scopes are invalid/);
  await assert.rejects(bootstrap.getAccessToken(), /invalid access token/);
});

test("GCS bootstrap rejects service-account key files and malformed WIF endpoints", async () => {
  class FakeGoogleAuth { async getClient() { return { async getAccessToken() { return "d".repeat(40); } }; } }
  const directory = await mkdtemp(join(tmpdir(), "ev-gcs-auth-"));
  const file = join(directory, "credentials.json");
  try {
    await writeFile(file, JSON.stringify({ type: "service_account", private_key: "never-a-real-key" }));
    await assert.rejects(createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: file }, GoogleAuthClass: FakeGoogleAuth }), /Only a generated Google Workload Identity Federation/);
    await writeFile(file, JSON.stringify({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/staging/providers/render",
      token_url: "https://sts.googleapis.com.evil.invalid/v1/token",
      credential_source: { file: "/tmp/subject-token" }
    }));
    await assert.rejects(createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: file }, GoogleAuthClass: FakeGoogleAuth }), /Only a generated Google Workload Identity Federation/);
    await writeFile(file, JSON.stringify({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/staging/providers/render",
      token_url: "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url: "https://evil.invalid/token",
      credential_source: { file: "/tmp/subject-token" }
    }));
    await assert.rejects(createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: file }, GoogleAuthClass: FakeGoogleAuth }), /trusted Google token endpoints/);
    await writeFile(file, JSON.stringify({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/staging/providers/render",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { executable: { command: "/tmp/untrusted-command" } }
    }));
    await assert.rejects(createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: file }, GoogleAuthClass: FakeGoogleAuth }), /executable token sources are not supported/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
