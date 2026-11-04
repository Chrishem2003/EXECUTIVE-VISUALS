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
function harness({ authorize = async () => true, ingest, fetchImpl, overrides = {}, maxOutputBytes = 1024 * 1024 } = {}) {
  const calls = [], ingested = [];
  const ingestor = createGoogleOmniPrivateOutputIngestor({
    env: { ...env, ...overrides },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (fetchImpl) return fetchImpl(url, options);
      return new Response(bytes, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(bytes.byteLength) } });
    },
    authorizeOutputIngestion: authorize,
    ingestPrivateOutput: async value => {
      ingested.push(value);
      return ingest ? ingest(value) : {
        id: "asset-private-1", ownerId: "owner-1", projectId: "project-1",
        mediaType: "video/mp4", isPrivate: true
      };
    },
    timeoutMs: 3000,
    maxOutputBytes
  });
  return { ingestor, calls, ingested };
}
const context = { ownerId: "owner-1", projectId: "project-1", jobId: "job-1" };

test("downloads Google URI output and commits it to owner/project private storage", async () => {
  const h = harness();
  const result = await h.ingestor.ingestInteraction(interaction({ uri }), context);
  assert.equal(result.assetId, "asset-private-1");
  assert.equal(result.ownerId, context.ownerId);
  assert.equal(result.projectId, context.projectId);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.headers["x-goog-api-key"], "server-google-key");
  assert.equal(h.calls[0].options.redirect, "error");
  assert.equal(h.ingested[0].bytes.toString(), bytes.toString());
  assert.equal(h.ingested[0].jobId, "job-1");
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
  await assert.rejects(() => h.ingestor.ingestInteraction(interaction({ uri }), {
    ...context, ownerId: "owner-2"
  }), error => error.code === "GEMINI_OMNI_OUTPUT_FORBIDDEN");
});

test("enforces response and configured byte limits before private ingestion", async () => {
  const h = harness({ maxOutputBytes: 1024 * 1024, fetchImpl: async () =>
    new Response(Buffer.alloc(2 * 1024 * 1024), { status: 200, headers: { "content-type": "video/mp4" } }) });
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
