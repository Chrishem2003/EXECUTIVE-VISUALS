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
  let response = "short";
  class FakeGoogleAuth {
    constructor() {}
    async getClient() { return { async getAccessToken() { return response; } }; }
  }
  const bootstrap = await createGoogleGeminiGcsMirrorBootstrap({ env, GoogleAuthClass: FakeGoogleAuth });
  await assert.rejects(bootstrap.getAccessToken({ projectId: "another-project" }), /project does not match/);
  await assert.rejects(bootstrap.getAccessToken({ scopes: ["not-a-url"] }), /scopes are invalid/);
  await assert.rejects(bootstrap.getAccessToken(), /invalid access token/);
  response = "a".repeat(24) + " " + "b".repeat(24);
  await assert.rejects(bootstrap.getAccessToken(), /invalid access token/);
});

test("GCS bootstrap rejects service-account key files and malformed WIF endpoints", async () => {
  class FakeGoogleAuth { async getClient() { return { async getAccessToken() { return "d".repeat(40); } }; } }
  const directory = await mkdtemp(join(tmpdir(), "ev-gcs-auth-"));
  const file = join(directory, "credentials.json");
  try {
    await writeFile(file, JSON.stringify({ type: "service_account", private_key: "never-a-real-key" }));
    await assert.rejects(createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: file }, GoogleAuthClass: FakeGoogleAuth }), /Only generated Google Workload Identity Federation/);
    await writeFile(file, JSON.stringify({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/staging/providers/render",
      token_url: "https://sts.googleapis.com.evil.invalid/v1/token",
      credential_source: { file: "/tmp/subject-token" }
    }));
    await assert.rejects(createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: file }, GoogleAuthClass: FakeGoogleAuth }), /Only generated Google Workload Identity Federation/);
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
    await assert.rejects(createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: file }, GoogleAuthClass: FakeGoogleAuth }), /URL, AWS, executable/);

    await writeFile(file, JSON.stringify({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/staging/providers/render",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { url: "http://169.254.169.254/latest/meta-data/token" }
    }));
    await assert.rejects(createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: file }, GoogleAuthClass: FakeGoogleAuth }), /file-based subject token/);

    await writeFile(file, JSON.stringify({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/staging/providers/render",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { aws: { url: "http://169.254.169.254/latest/meta-data/iam/security-credentials" } }
    }));
    await assert.rejects(createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: file }, GoogleAuthClass: FakeGoogleAuth }), /file-based subject token/);

    await writeFile(file, JSON.stringify({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/staging/providers/render",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { file: "/tmp/subject-token", format: { type: "xml" } }
    }));
    await assert.rejects(createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: file }, GoogleAuthClass: FakeGoogleAuth }), /file-based subject token/);

    await writeFile(file, JSON.stringify({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/staging/providers/render",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { file: "/tmp/subject-token", format: { type: "json", subject_token_field_name: "token" } }
    }));
    const accepted = await createGoogleGeminiGcsMirrorBootstrap({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: file }, GoogleAuthClass: FakeGoogleAuth });
    assert.equal(typeof accepted.getAccessToken, "function");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GCS bootstrap rejects local user ADC before requesting an access token", async () => {
  let tokenRequests = 0;
  class UserRefreshClient {
    async getAccessToken() { tokenRequests += 1; return { token: "u".repeat(40) }; }
  }
  class Compute {}
  class IdentityPoolClient {}
  class FakeGoogleAuth {
    async getClient() { return new UserRefreshClient(); }
  }
  const bootstrap = await createGoogleGeminiGcsMirrorBootstrap({
    env,
    GoogleAuthClass: FakeGoogleAuth,
    GoogleCredentialClientClasses: { Compute, IdentityPoolClient }
  });
  await assert.rejects(bootstrap.checkIdentity(), error =>
    error.code === "GEMINI_GCS_ADC_IDENTITY_TYPE_REJECTED" &&
    /local user ADC credentials/.test(error.message)
  );
  assert.equal(tokenRequests, 0, "unapproved ADC identities must be rejected before token acquisition");
});

test("GCS bootstrap accepts the concrete IdentityPoolClient used by file-based WIF", async () => {
  class Compute {}
  class IdentityPoolClient {
    async getAccessToken() { return { token: "w".repeat(40) }; }
  }
  class FakeGoogleAuth {
    async getClient() { return new IdentityPoolClient(); }
  }
  const bootstrap = await createGoogleGeminiGcsMirrorBootstrap({
    env,
    GoogleAuthClass: FakeGoogleAuth,
    GoogleCredentialClientClasses: { Compute, IdentityPoolClient }
  });
  const identity = await bootstrap.checkIdentity();
  assert.equal(identity.ready, true);
  assert.equal(identity.identityMode, "external-account-wif");
  assert.equal(identity.credentialClientType, "IdentityPoolClient");
});

test("GCS bootstrap accepts an attached Compute workload identity by class identity", async () => {
  class Compute {
    async getAccessToken() { return { token: "c".repeat(40) }; }
  }
  class IdentityPoolClient {}
  class FakeGoogleAuth {
    async getClient() { return new Compute(); }
  }
  const bootstrap = await createGoogleGeminiGcsMirrorBootstrap({
    env,
    GoogleAuthClass: FakeGoogleAuth,
    GoogleCredentialClientClasses: { Compute, IdentityPoolClient }
  });
  const identity = await bootstrap.checkIdentity();
  assert.equal(identity.ready, true);
  assert.equal(identity.identityMode, "attached-workload-identity");
  assert.equal(identity.credentialClientType, "Compute");
});

test("GCS bootstrap rejects a lookalike client even when its constructor name is approved", async () => {
  class Compute {}
  class IdentityPoolClient {}
  const Lookalike = { [Symbol.hasInstance]: () => false };
  class FakeGoogleAuth {
    async getClient() {
      return { constructor: { name: "IdentityPoolClient" }, async getAccessToken() { return { token: "x".repeat(40) }; } };
    }
  }
  const bootstrap = await createGoogleGeminiGcsMirrorBootstrap({
    env,
    GoogleAuthClass: FakeGoogleAuth,
    GoogleCredentialClientClasses: { Compute, IdentityPoolClient: Lookalike }
  });
  await assert.rejects(bootstrap.checkIdentity(), error =>
    error.code === "GEMINI_GCS_ADC_IDENTITY_TYPE_REJECTED"
  );
});
