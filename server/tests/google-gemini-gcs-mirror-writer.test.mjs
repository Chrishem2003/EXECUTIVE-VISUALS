import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32cBase64,computeFileChecksums } from "../google-cloud-storage-checksum.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoogleGeminiGcsMirrorWriter } from "../google-gemini-gcs-mirror-writer.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const sourceBytes=Buffer.from([1,2,3,4]);
const sha256=createHash("sha256").update(sourceBytes).digest("hex");
const crc32c=crc32cBase64(sourceBytes);
const generation = "1762300800000000";
const metageneration = "3";
const token = "oauth-test-access-token-123456";
const sessionUri = "https://storage.googleapis.com/upload/storage/v1/b/private-media-bucket/o?uploadType=resumable&upload_id=opaque-session-secret";
const env = {
  GOOGLE_CLOUD_PROJECT_ID: "test-gcp-project-12345",
  GEMINI_GCS_ALLOWED_BUCKETS: "private-media-bucket",
  GEMINI_GCS_MIRROR_BUCKET: "private-media-bucket"
};
function metadata(objectName, overrides = {}) {
  return {
    bucket: "private-media-bucket", name: objectName, generation, metageneration,
    size: "4", contentType: "video/mp4", crc32c,
    metadata: {
      executivevisualsassetid: assetId,
      executivevisualsownerid: ownerId,
      executivevisualsprojectid: projectId,
      executivevisualssha256: sha256,
      executivevisualscrc32c: crc32c
    },
    ...overrides
  };
}
async function fixture({ metadataOverrides = {}, recordError = null, putFailure = null, attemptRepository = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ev-gcs-mirror-test-"));
  const filePath = join(root, "source.mp4");
  await writeFile(filePath, sourceBytes);
  const calls = [], records = [];
  const objectName = "mirrors/" + ownerId + "/" + projectId + "/" + assetId + "/fixed-id.mp4";
  const sourceRepository = {
    async recordVerifiedSource(source) {
      records.push(source);
      if (recordError) throw recordError;
      return { ...source, id: "55555555-5555-4555-8555-555555555555", state: "ACTIVE" };
    }
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === "POST") return new Response(null, { status: 200, headers: { location: sessionUri } });
    if (options.method === "PUT") {
      if (putFailure) throw putFailure;
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), Buffer.from([1,2,3,4]));
      assert.equal(options.headers["content-length"], "4");
      assert.equal(options.headers["x-goog-hash"], "crc32c=" + crc32c);
      assert.equal(options.headers.authorization, undefined);
      return new Response(JSON.stringify({ generation }), { status: 200 });
    }
    if (options.method === "GET") return new Response(JSON.stringify(metadata(objectName, metadataOverrides)), { status: 200 });
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error("Unexpected GCS request");
  };
  const writer = createGoogleGeminiGcsMirrorWriter({
    env, fetchImpl, sourceRepository, attemptRepository,
    getAccessToken: async options => {
      assert.deepEqual(options.scopes, [
        "https://www.googleapis.com/auth/devstorage.read_write",
        "https://www.googleapis.com/auth/cloud-platform"
      ]);
      return token;
    },
    makeId: () => "fixed-id"
  });
  return { root, filePath, writer, calls, records, objectName };
}

test("streams a create-only resumable upload, verifies exact metadata, then records the source", async () => {
  const f = await fixture();
  try {
    const result = await f.writer.mirrorAsset({
      assetId, ownerId, projectId, mediaType: "video/mp4",
      filePath: f.filePath, sizeBytes: 4, sha256
    });
    assert.equal(result.gcsUri, "gs://private-media-bucket/" + f.objectName);
    assert.equal(result.generation, generation);
    assert.equal(result.source.state, "ACTIVE");
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0].metageneration, metageneration);
    assert.equal(f.records[0].sha256, sha256);
    assert.equal(f.calls[0].options.method, "POST");
    assert.equal(f.calls[0].url.includes("ifGenerationMatch=0"), true);
    const initiation = JSON.parse(f.calls[0].options.body);
    assert.equal(initiation.name, f.objectName);
    assert.equal(initiation.metadata.executivevisualsassetid, assetId);
    assert.equal(initiation.metadata.executivevisualsownerid, ownerId);
    assert.equal(initiation.metadata.executivevisualscrc32c,crc32c);
    assert.equal(f.calls.some(call => call.url === sessionUri), true);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(JSON.stringify(result).includes("opaque-session-secret"), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("deletes only the exact uploaded generation when registry persistence fails", async () => {
  const f = await fixture({ recordError: new Error("registry unavailable") });
  try {
    await assert.rejects(
      () => f.writer.mirrorAsset({ assetId, ownerId, projectId, mediaType: "video/mp4", filePath: f.filePath, sizeBytes: 4, sha256 }),
      /registry unavailable/
    );
    const deletion = f.calls.find(call => call.options.method === "DELETE");
    assert.ok(deletion);
    assert.ok(deletion.url.includes("ifGenerationMatch=" + generation));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("fails closed and compensates when uploaded object ownership metadata mismatches", async () => {
  const f = await fixture({ metadataOverrides: { metadata: { executivevisualsassetid: assetId, executivevisualsownerid: "99999999-9999-4999-8999-999999999999", executivevisualsprojectid: projectId, executivevisualssha256: sha256 } } });
  try {
    await assert.rejects(
      () => f.writer.mirrorAsset({ assetId, ownerId, projectId, mediaType: "video/mp4", filePath: f.filePath, sizeBytes: 4, sha256 }),
      error => error.code === "GEMINI_GCS_MIRROR_INTEGRITY_MISMATCH"
    );
    assert.equal(f.records.length, 0);
    assert.ok(f.calls.some(call => call.options.method === "DELETE"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects a mirror bucket outside the explicit allowlist", () => {
  assert.throws(() => createGoogleGeminiGcsMirrorWriter({
    env: { ...env, GEMINI_GCS_MIRROR_BUCKET: "unapproved-bucket" },
    getAccessToken: async () => token,
    sourceRepository: { recordVerifiedSource: async () => true }
  }), error => error.code === "GEMINI_GCS_MIRROR_BUCKET_FORBIDDEN");
});

test("rejects a source file whose current size no longer matches the authorized receipt", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => f.writer.mirrorAsset({ assetId, ownerId, projectId, mediaType: "video/mp4", filePath: f.filePath, sizeBytes: 5, sha256 }),
      error => error.code === "GEMINI_GCS_SOURCE_FILE_MISMATCH"
    );
    assert.equal(f.calls.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("marks a transport failure during resumable upload as outcome-unknown without retrying or unsafe deletion", async () => {
  const f = await fixture({ putFailure: new Error("connection lost after request dispatch") });
  try {
    await assert.rejects(
      () => f.writer.mirrorAsset({ assetId, ownerId, projectId, mediaType: "video/mp4", filePath: f.filePath, sizeBytes: 4, sha256 }),
      error => error.outcomeUnknown === true && error.cleanupPending === true
    );
    assert.equal(f.calls.filter(call => call.options.method === "POST").length, 1);
    assert.equal(f.calls.some(call => call.options.method === "DELETE"), false);
    assert.equal(f.records.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("persists encrypted-session lifecycle transitions and retains verified object for recovery if registry write fails", async () => {
  const transitions = [];
  const attemptRepository = {
    async createAttempt(input) { transitions.push({ op:"create", input }); assert.equal(input.crc32c,crc32c); return { id:"44444444-4444-4444-8444-444444444444" }; },
    async recordSession(input) { transitions.push({ op:"session", input }); },
    async transition(input) { transitions.push({ op:"transition", input }); }
  };
  const f = await fixture({ recordError:new Error("registry unavailable"), attemptRepository });
  try {
    await assert.rejects(
      () => f.writer.mirrorAsset({ assetId, ownerId, projectId, mediaType:"video/mp4", filePath:f.filePath, sizeBytes:4, sha256 }),
      /registry unavailable/
    );
    assert.deepEqual(transitions.map(x=>x.op),["create","session","transition"]);
    assert.equal(transitions[1].input.sessionUri,sessionUri);
    assert.equal(transitions[2].input.expectedState,"UPLOADING");
    assert.equal(transitions[2].input.state,"OBJECT_VERIFIED");
    assert.equal(f.calls.some(call=>call.options.method==="DELETE"),false);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("marks ambiguous GCS upload outcomes in the durable attempt ledger", async () => {
  const transitions=[];
  const attemptRepository={
    async createAttempt(){return {id:"44444444-4444-4444-8444-444444444444"};},
    async recordSession(){},
    async transition(input){transitions.push(input);}
  };
  const f=await fixture({putFailure:new Error("connection lost"),attemptRepository});
  try {
    await assert.rejects(
      () => f.writer.mirrorAsset({assetId,ownerId,projectId,mediaType:"video/mp4",filePath:f.filePath,sizeBytes:4,sha256}),
      error=>error.outcomeUnknown===true
    );
    assert.equal(transitions.length,1);
    assert.equal(transitions[0].expectedState,"UPLOADING");
    assert.equal(transitions[0].state,"OUTCOME_UNKNOWN");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("rejects same-size source bytes whose SHA-256 differs from the durable asset receipt",async()=>{
 const f=await fixture();
 try{
  await writeFile(f.filePath,new Uint8Array([4,3,2,1]));
  await assert.rejects(
   ()=>f.writer.mirrorAsset({assetId,ownerId,projectId,mediaType:"video/mp4",filePath:f.filePath,sizeBytes:4,sha256}),
   error=>error.code==="GEMINI_GCS_SOURCE_FILE_MISMATCH"
  );
  assert.equal(f.calls.length,0);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("uses the standard CRC32C base64 encoding for a known test vector",()=>{
 assert.equal(crc32cBase64(Buffer.from("123456789")),"4waSgw==");
});

test("computes streaming SHA-256 and CRC32C for a private source file",async()=>{
 const f=await fixture();
 try{
  assert.deepEqual(await computeFileChecksums(f.filePath),{sha256,crc32c});
 }finally{await rm(f.root,{recursive:true,force:true});}
});
