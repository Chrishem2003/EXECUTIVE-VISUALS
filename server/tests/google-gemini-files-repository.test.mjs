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
