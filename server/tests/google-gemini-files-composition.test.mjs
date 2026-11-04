import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGoogleGeminiFilesComposition } from "../google-gemini-files-composition.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const bytes = Buffer.from("private composition fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const uri = "https://generativelanguage.googleapis.com/v1beta/files/gemini-composed";
const uploadUrl = "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=composition";

function json(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

test("composes the private asset loader and durable mapping repository into the upload gateway", async () => {
  const calls = [];
  const records = [];
  const repository = {
    findProviderFile: async args => { calls.push(["find", args]); return null; },
    recordProviderFile: async record => { records.push(record); return "mapping-id"; },
    deleteProviderFileRecord: async args => { calls.push(["delete", args]); }
  };
  const fetchImpl = async (url, options) => {
    if (String(url) === "https://generativelanguage.googleapis.com/upload/v1beta/files") {
      return json(200, {}, { "x-goog-upload-url": uploadUrl });
    }
    if (String(url) === uploadUrl) {
      return json(200, { file: {
        name: "files/gemini-composed", uri, mimeType: "image/png",
        sizeBytes: String(bytes.byteLength), state: "ACTIVE"
      }});
    }
    throw new Error("Unexpected URL " + url);
  };
  const gateway = createGoogleGeminiFilesComposition({
    url: "https://supabase.example", serviceRoleKey: "service-role",
    env: { GEMINI_API_KEY: "google-key" }, fetchImpl, repository,
    loadPrivateAsset: async () => ({
      asset: {
        id: assetId, ownerId, projectId, mediaType: "image/png",
        size: bytes.byteLength, sha256, storageBucket: "executive-visuals-media"
      },
      bytes, size: bytes.byteLength, sha256, cleanup: async () => {}
    }),
    now: () => Date.parse("2026-11-05T00:00:00.000Z")
  });
  const result = await gateway.resolveAsset({ assetId, ownerId, projectId, mediaType: "image/png" });
  assert.equal(result.uri, uri);
  assert.equal(calls[0][0], "find");
  assert.equal(calls[0][1].ownerId, ownerId);
  assert.equal(records.length, 1);
  assert.equal(records[0].uri, uri);
});

test("does not make Supabase or Google requests during composition", () => {
  let fetches = 0;
  const repository = {
    findProviderFile: async () => null,
    recordProviderFile: async () => {},
    deleteProviderFileRecord: async () => {}
  };
  createGoogleGeminiFilesComposition({
    url: "https://supabase.example", serviceRoleKey: "service-role",
    env: {}, fetchImpl: async () => { fetches++; },
    loadPrivateAsset: async () => ({}), repository
  });
  assert.equal(fetches, 0);
});

test("requires the service-role repository and validates composition configuration", () => {
  assert.throws(() => createGoogleGeminiFilesComposition({
    url: "https://supabase.example", serviceRoleKey: "service-role",
    repository: {}
  }));
  assert.throws(() => createGoogleGeminiFilesComposition({
    url: "http://attacker.example", serviceRoleKey: "service-role"
  }));
});
