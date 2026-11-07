import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGoogleOmniPrivateOutputIngestor } from "../google-omni-private-output-ingestion.mjs";

const id = "v1_abcdef123456";
const uri = "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media";
const bytes = Buffer.from("mock-mp4-output-bytes");
const env = { GEMINI_API_KEY: "server-google-key" };
function interaction(video, status = "completed") {
  return {
    id, model: "gemini-omni-1.1-flash", status,
    steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", ...video }] }]
  };
}
function harness({ authorize = async () => true, existing = null, findError = false, ingest, fetchImpl, overrides = {}, maxOutputBytes = 1024 * 1024 } = {}) {
  const calls = [], ingested = [], lookups = [];
  const ingestor = createGoogleOmniPrivateOutputIngestor({
    env: { ...env, ...overrides },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (fetchImpl) return fetchImpl(url, options);
      if (String(url).includes("/v1beta/files/") && !String(url).includes(":download")) {
        return new Response(JSON.stringify({ name: "files/generated-video", state: "ACTIVE" }), {
          status: 200, headers: { "content-type": "application/json" }
        });
      }
      return new Response(bytes, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(bytes.byteLength) } });
    },
    authorizeOutputIngestion: authorize,
    findExistingOutput: async scope => {
      if (findError) throw new Error("metadata lookup unavailable");
      lookups.push(scope);
      return existing;
    },
    ingestPrivateOutput: async value => {
      ingested.push(value);
      return ingest ? ingest(value) : {
        id: "asset-private-1", ownerId: "owner-1", projectId: "project-1",
        mediaType: "video/mp4", size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        storageBucket: "executive-visuals-media"
      };
    },
    timeoutMs: 3000,
    fileReadyTimeoutMs: 1000,
    filePollIntervalMs: 10,
    maxOutputBytes
  });
  return { ingestor, calls, ingested, lookups };
}
const context = { ownerId: "owner-1", projectId: "project-1", jobId: "job-1" };

test("downloads Google URI output and commits it to owner/project private storage", async () => {
  const h = harness();
  const result = await h.ingestor.ingestInteraction(interaction({ uri }), context);
  assert.equal(result.assetId, "asset-private-1");
  assert.equal(result.ownerId, context.ownerId);
  assert.equal(result.projectId, context.projectId);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(h.calls.filter(call => call.url).length, 2);
  assert.ok(h.calls[0].url.endsWith("/v1beta/files/generated-video"));
  assert.equal(h.calls[1].url, uri);
  assert.equal(h.calls.find(call => call.url).options.headers["x-goog-api-key"], "server-google-key");
  assert.equal(h.calls[0].options.redirect, "error");
  assert.equal(h.ingested[0].bytes.toString(), bytes.toString());
  assert.equal(h.ingested[0].jobId, "job-1");
  assert.deepEqual(h.ingested[0].metadata, {
    source: "video-generation", providerTaskId: id, outputIndex: 0
  });
});


test("waits for Google Files to become ACTIVE before downloading generated video", async () => {
  let checks = 0;
  const h = harness({ fetchImpl: async url => {
    if (String(url).includes(":download")) {
      return new Response(bytes, { status: 200, headers: { "content-type": "video/mp4" } });
    }
    checks++;
    return new Response(JSON.stringify({ state: checks === 1 ? "PROCESSING" : "ACTIVE" }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  } });
  const result = await h.ingestor.ingestInteraction(interaction({ uri }), context);
  assert.equal(result.assetId, "asset-private-1");
  assert.equal(checks, 2);
  assert.equal(h.calls.length, 3);
});


test("bounds Google Files metadata before JSON parsing", async () => {
  const h = harness({ fetchImpl: async () => new Response(
    JSON.stringify({ state: "ACTIVE", padding: "x".repeat(70 * 1024) }),
    { status: 200, headers: { "content-type": "application/json" } }
  ) });
  await assert.rejects(() => h.ingestor.ingestInteraction(interaction({ uri }), context), error =>
    error.code === "GEMINI_OMNI_FILE_METADATA_TOO_LARGE");
  assert.equal(h.calls.length, 1);
  assert.equal(h.ingested.length, 0);
});

test("does not download a Google Files object whose processing state failed", async () => {
  const h = harness({ fetchImpl: async () => new Response(JSON.stringify({ state: "FAILED" }), {
    status: 200, headers: { "content-type": "application/json" }
  }) });
  await assert.rejects(() => h.ingestor.ingestInteraction(interaction({ uri }), context), error =>
    error.code === "GEMINI_OMNI_FILE_PROCESSING_FAILED");
  assert.equal(h.calls.length, 1);
  assert.equal(h.ingested.length, 0);
});

test("accepts bounded inline base64 output without a second provider request", async () => {
  const h = harness();
  const result = await h.ingestor.ingestInteraction(interaction({ data: bytes.toString("base64") }), context);
  assert.equal(result.assetId, "asset-private-1");
  assert.equal(h.calls.length, 0);
});

test("requires durable job and owner/project authorization before downloading", async () => {
  const h = harness({ authorize: async () => false });
  await assert.rejects(() => h.ingestor.ingestInteraction(interaction({ uri }), context), error =>
    error.code === "GEMINI_OMNI_OUTPUT_FORBIDDEN");
  assert.equal(h.calls.length, 0);
  assert.equal(h.ingested.length, 0);
});

test("rejects arbitrary output URLs and malformed interaction output", async () => {
  const h = harness();
  await assert.rejects(() => h.ingestor.ingestInteraction(interaction({
    uri: "https://attacker.example/output.mp4"
  }), context), error => error.code === "GEMINI_OMNI_INVALID_RESPONSE");
  const unauthorized = harness({ authorize: async () => false });
  await assert.rejects(() => unauthorized.ingestor.ingestInteraction(interaction({ uri }), {
    ...context, ownerId: "owner-2"
  }), error => error.code === "GEMINI_OMNI_OUTPUT_FORBIDDEN");
});

test("enforces response and configured byte limits before private ingestion", async () => {
  const h = harness({ maxOutputBytes: 1024 * 1024, fetchImpl: async url => String(url).includes(":download")
    ? new Response(Buffer.alloc(2 * 1024 * 1024), { status: 200, headers: { "content-type": "video/mp4" } })
    : new Response(JSON.stringify({ state: "ACTIVE" }), { status: 200, headers: { "content-type": "application/json" } }) });
  await assert.rejects(() => h.ingestor.ingestInteraction(interaction({ uri }), context), error =>
    error.code === "GEMINI_OMNI_OUTPUT_TOO_LARGE");
  assert.equal(h.ingested.length, 0);
});

test("rejects invalid private asset service results and failed ingestion", async () => {
  const invalid = harness({ ingest: async () => ({
    id: "asset-1", ownerId: "someone-else", projectId: "project-1",
    mediaType: "video/mp4", isPrivate: true
  }) });
  await assert.rejects(() => invalid.ingestor.ingestInteraction(interaction({ data: bytes.toString("base64") }), context), error =>
    error.code === "GEMINI_OMNI_OUTPUT_ASSET_INVALID");
  const failed = harness({ ingest: async () => { throw new Error("storage unavailable"); } });
  await assert.rejects(() => failed.ingestor.ingestInteraction(interaction({ data: bytes.toString("base64") }), context), error =>
    error.code === "GEMINI_OMNI_OUTPUT_INGEST_FAILED");
});

test("reuses an existing owner/project-scoped asset on retry without downloading or uploading again", async () => {
  const existing = {
    id: "asset-existing-1",
    ownerId: context.ownerId,
    projectId: context.projectId,
    mediaType: "video/mp4",
    storageBucket: "executive-visuals-media",
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
  const h = harness({ existing });
  const result = await h.ingestor.ingestInteraction(interaction({ uri }), context);
  assert.equal(result.assetId, existing.id);
  assert.equal(result.reused, true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.lookups.length, 1);
  assert.equal(h.ingested.length, 0);
});

test("fails closed when output idempotency metadata cannot be checked", async () => {
  const h = harness({ findError: true });
  await assert.rejects(() => h.ingestor.ingestInteraction(interaction({ uri }), context), error =>
    error.code === "GEMINI_OMNI_OUTPUT_IDEMPOTENCY_LOOKUP_FAILED");
  assert.equal(h.calls.length, 0);
  assert.equal(h.ingested.length, 0);
});

test("rejects a cloud asset response outside the private storage contract", async () => {
  for (const patch of [
    { storageBucket: "public-assets" },
    { sha256: "0".repeat(64) },
    { size: bytes.byteLength + 1 }
  ]) {
    const h = harness({ ingest: async () => ({
      id: "asset-1", ownerId: context.ownerId, projectId: context.projectId,
      mediaType: "video/mp4", size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      storageBucket: "executive-visuals-media", ...patch
    }) });
    await assert.rejects(() => h.ingestor.ingestInteraction(
      interaction({ data: bytes.toString("base64") }), context
    ), error => error.code === "GEMINI_OMNI_OUTPUT_ASSET_INVALID");
  }
});
