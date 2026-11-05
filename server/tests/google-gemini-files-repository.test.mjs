import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiFilesRepository } from "../google-gemini-files-repository.mjs";

const base = "https://project.supabase.co";
const key = "server-role-secret";
const row = {
  id: "44444444-4444-4444-8444-444444444444",
  provider: "google-gemini-files",
  asset_id: "33333333-3333-4333-8333-333333333333",
  owner_id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
  google_file_name: "files/gemini-123",
  google_file_uri: "https://generativelanguage.googleapis.com/v1beta/files/gemini-123",
  mime_type: "image/png",
  byte_size: 1024,
  sha256: "a".repeat(64),
  state: "ACTIVE",
  uploaded_at: "2026-11-05T00:00:00.000Z",
  expires_at: "2026-11-07T00:00:00.000Z"
};
function response(status, data) {
  return new Response(data === null ? null : JSON.stringify(data), { status });
}

test("finds only the exact provider, asset, owner, project and MIME mapping", async () => {
  const calls = [];
  const repository = createGoogleGeminiFilesRepository({
    url: base, serviceRoleKey: key,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(200, [row]);
    }
  });
  const result = await repository.findProviderFile({
    assetId: row.asset_id, ownerId: row.owner_id, projectId: row.project_id, mimeType: row.mime_type
  });
  assert.equal(result.name, row.google_file_name);
  assert.equal(result.uri, row.google_file_uri);
  assert.equal(result.assetId, row.asset_id);
  assert.equal(result.ownerId, row.owner_id);
  assert.equal(result.projectId, row.project_id);
  assert.equal(result.sizeBytes, 1024);
  assert.equal(result.sourceType, "upload");
  assert.equal(result.sourceUri, null);
  assert.match(calls[0].url, /project_id=eq.22222222/);
  assert.equal(calls[0].options.headers.apikey, key);
  assert.equal(calls[0].options.headers["accept-profile"], "executive_visuals");
});

test("queries personal assets with a null project scope and returns null for no mapping", async () => {
  let url;
  const repository = createGoogleGeminiFilesRepository({
    url: base, serviceRoleKey: key,
    fetchImpl: async value => { url = String(value); return response(200, []); }
  });
  const result = await repository.findProviderFile({
    assetId: row.asset_id, ownerId: row.owner_id, projectId: null, mimeType: row.mime_type
  });
  assert.equal(result, null);
  assert.match(url, /project_id=is.null/);
});

test("upserts a provider-file mapping without exposing service-role credentials", async () => {
  let call;
  const repository = createGoogleGeminiFilesRepository({
    url: base, serviceRoleKey: key,
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return response(201, [{ id: row.id }]);
    }
  });
  const id = await repository.recordProviderFile({
    provider: row.provider, assetId: row.asset_id, ownerId: row.owner_id,
    projectId: row.project_id, name: row.google_file_name, uri: row.google_file_uri,
    mimeType: row.mime_type, sizeBytes: row.byte_size, sha256: row.sha256,
    state: row.state, uploadedAt: row.uploaded_at, expiresAt: row.expires_at
  });
  assert.equal(id, row.id);
  assert.match(call.url, /on_conflict=provider%2Casset_id%2Cowner_id/);
  assert.equal(call.options.method, "POST");
  assert.match(call.options.headers.prefer, /resolution=merge-duplicates/);
  assert.equal(call.options.headers.apikey, key);
  const body = JSON.parse(call.options.body);
  assert.equal(body.source_type, "upload");
  assert.equal(body.source_uri, null);
  assert.equal(call.options.body.includes(key), false);
});

test("deletes a provider-file mapping by its durable ID or file name", async () => {
  const calls = [];
  const repository = createGoogleGeminiFilesRepository({
    url: base, serviceRoleKey: key,
    fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return response(204, null); }
  });
  await repository.deleteProviderFileRecord({ recordId: row.id });
  await repository.deleteProviderFileRecord({ name: row.google_file_name });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "DELETE");
  assert.match(calls[0].url, /id=eq.44444444/);
  assert.match(calls[1].url, /google_file_name=eq.files%2Fgemini-123/);
});


test("creates a durable idempotent upload attempt and reads the existing attempt after an ignored duplicate", async () => {
  const calls = [];
  const attemptRow = {
    id: row.id, attempt_key: "b".repeat(64), asset_id: row.asset_id, owner_id: row.owner_id,
    project_id: row.project_id, mime_type: row.mime_type, byte_size: row.byte_size,
    sha256: row.sha256, google_display_name: "executive-visuals-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    state: "OUTCOME_UNKNOWN", google_file_name: null, google_file_uri: null,
    provider_expires_at: null, last_error_code: "GEMINI_FILE_UPLOAD_OUTCOME_UNKNOWN",
    attempt_count: 1, updated_at: row.updated_at, reconciled_at: null
  };
  const repository = createGoogleGeminiFilesRepository({
    url: base, serviceRoleKey: key,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (options.method === "POST") return response(201, []);
      return response(200, [attemptRow]);
    }
  });
  const result = await repository.createUploadAttempt({
    attemptKey: attemptRow.attempt_key, displayNameHash: attemptRow.attempt_key,
    displayName: attemptRow.google_display_name, assetId: row.asset_id, ownerId: row.owner_id,
    projectId: row.project_id, mimeType: row.mime_type, sizeBytes: row.byte_size, sha256: row.sha256
  });
  assert.equal(result.id, row.id);
  assert.equal(result.state, "OUTCOME_UNKNOWN");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].url, /google_provider_file_upload_attempts/);
  assert.match(calls[0].options.headers.prefer, /resolution=ignore-duplicates/);
  assert.match(calls[1].url, /attempt_key=eq/);
  assert.equal(calls[0].options.body.includes(key), false);
});

test("updates an upload attempt through an exact ID and bounded state transition", async () => {
  let call;
  const repository = createGoogleGeminiFilesRepository({
    url: base, serviceRoleKey: key,
    fetchImpl: async (url, options) => { call = { url: String(url), options }; return response(200, [{ id: row.id }]); }
  });
  assert.equal(await repository.updateUploadAttempt({
    attemptId: row.id, state: "PROVIDER_CREATED",
    providerFileName: "files/gemini-123",
    providerFileUri: "https://generativelanguage.googleapis.com/v1beta/files/gemini-123",
    providerExpiresAt: row.expires_at
  }), row.id);
  assert.equal(call.options.method, "PATCH");
  assert.match(call.url, /google_provider_file_upload_attempts/);
  const body = JSON.parse(call.options.body);
  assert.equal(body.state, "PROVIDER_CREATED");
  assert.equal(body.google_file_name, "files/gemini-123");
  await assert.rejects(() => repository.updateUploadAttempt({ attemptId: row.id, state: "DELETING" }));
  await assert.rejects(() => repository.updateUploadAttempt({ state: "COMPLETED" }));
});

test("requires safe server configuration and bounds the timeout", () => {
  assert.throws(() => createGoogleGeminiFilesRepository({ url: "http://attacker.example", serviceRoleKey: key }));
  assert.throws(() => createGoogleGeminiFilesRepository({ url: base, serviceRoleKey: "" }));
  assert.throws(() => createGoogleGeminiFilesRepository({ url: base, serviceRoleKey: key, timeoutMs: 100 }));
});

test("persists GCS registration provenance without changing the private asset identity", async () => {
  let body;
  const repository = createGoogleGeminiFilesRepository({
    url: base, serviceRoleKey: key,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return response(201, [{ id: row.id }]);
    }
  });
  await repository.recordProviderFile({
    provider: row.provider, assetId: row.asset_id, ownerId: row.owner_id,
    projectId: row.project_id, name: row.google_file_name, uri: row.google_file_uri,
    mimeType: row.mime_type, sizeBytes: row.byte_size, sha256: row.sha256,
    state: row.state, uploadedAt: row.uploaded_at, expiresAt: row.expires_at,
    sourceType: "gcs_registration", sourceUri: "gs://private-media-bucket/private/image.png"
  });
  assert.equal(body.source_type, "gcs_registration");
  assert.equal(body.source_uri, "gs://private-media-bucket/private/image.png");
});

test("lists expired active and retryable mappings with bounded service-role queries", async () => {
  let call;
  const repository = createGoogleGeminiFilesRepository({
    url: base, serviceRoleKey: key,
    fetchImpl: async (url, options) => { call = { url: String(url), options }; return response(200, [row]); }
  });
  const result = await repository.listExpiredProviderFiles({ before: "2026-11-05T00:00:00.000Z", limit: 25 });
  assert.equal(result.length, 1);
  assert.equal(result[0].assetId, row.asset_id);
  assert.equal(result[0].ownerId, row.owner_id);
  assert.equal(result[0].name, row.google_file_name);
  const params = new URL(call.url).searchParams;
  assert.equal(params.get("state"), "in.(ACTIVE,EXPIRED)");
  assert.equal(params.get("limit"), "25");
  assert.equal(params.get("expires_at"), "lte.2026-11-05T00:00:00.000Z");
  assert.equal(call.options.headers.apikey, key);
});

test("updates provider-file state only through a bounded exact record selector", async () => {
  const calls = [];
  const repository = createGoogleGeminiFilesRepository({
    url: base, serviceRoleKey: key,
    fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return response(200, [{ id: row.id }]); }
  });
  assert.equal(await repository.updateProviderFileState({ recordId: row.id, state: "EXPIRED" }), row.id);
  assert.equal(calls[0].options.method, "PATCH");
  assert.equal(JSON.parse(calls[0].options.body).state, "EXPIRED");
  await assert.rejects(() => repository.updateProviderFileState({ recordId: row.id, state: "DELETING" }));
  await assert.rejects(() => repository.updateProviderFileState({ state: "DELETED" }));
});
