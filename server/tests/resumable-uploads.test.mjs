import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  ensureResumableUploadSchema, createUploadSession, getUploadSession,
  appendUploadChunk, prepareUploadCompletion, releaseUploadSession,
  abortUploadSession, cleanupExpiredUploadSessions
} from "../resumable-uploads.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ev-resumable-upload-"));
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE assets(id TEXT PRIMARY KEY); INSERT INTO users(id) VALUES('owner'),('other'); INSERT INTO projects(id) VALUES('project-1');");
  ensureResumableUploadSchema(db);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db };
}
const canWriteProject = () => true;
const create = (f, extra = {}) => createUploadSession({
  db:f.db,mediaRoot:f.root,ownerId:"owner",originalName:"sample.wav",
  mediaType:"audio/wav",totalSize:8,maxUploadBytes:1024,canWriteProject,...extra
});

test("creates an owner-scoped session and reports the committed offset", async t => {
  const f=await fixture(t), session=await create(f);
  assert.equal(session.offset,0);
  assert.equal(getUploadSession(f.db,"owner",session.id).offset,0);
  assert.equal(getUploadSession(f.db,"other",session.id),null);
});

test("accepts sequential chunks and resumes from the persisted offset", async t => {
  const f=await fixture(t), session=await create(f);
  const first=await appendUploadChunk({db:f.db,mediaRoot:f.root,ownerId:"owner",id:session.id,offset:0,request:Readable.from([Buffer.from("RIFF")]),expectedChunkSize:4});
  assert.equal(first.offset,4);
  await assert.rejects(appendUploadChunk({db:f.db,mediaRoot:f.root,ownerId:"owner",id:session.id,offset:0,request:Readable.from([Buffer.from("WAVE")]),expectedChunkSize:4}),e=>e.code==="UPLOAD_OFFSET_MISMATCH");
  const second=await appendUploadChunk({db:f.db,mediaRoot:f.root,ownerId:"owner",id:session.id,offset:4,request:Readable.from([Buffer.from("WAVE")]),expectedChunkSize:4});
  assert.equal(second.complete,true);
  const prepared=await prepareUploadCompletion({db:f.db,ownerId:"owner",id:session.id});
  assert.equal((await readFile(prepared.path)).toString(),"RIFFWAVE");
  assert.equal(prepared.sha256.length,64);
  assert.equal(releaseUploadSession(f.db,"owner",session.id),true);
});

test("rejects chunks that exceed the declared file size", async t => {
  const f=await fixture(t), session=await create(f);
  await assert.rejects(appendUploadChunk({db:f.db,mediaRoot:f.root,ownerId:"owner",id:session.id,offset:0,request:Readable.from([Buffer.from("123456789")]),expectedChunkSize:9}),e=>e.code==="UPLOAD_EXCEEDS_DECLARED_SIZE");
});

test("rolls back partial chunk writes after a stream failure", async t => {
  const f=await fixture(t), session=await create(f);
  const broken=Readable.from((async function*(){yield Buffer.from("RIFF");throw new Error("connection dropped");})());
  await assert.rejects(appendUploadChunk({db:f.db,mediaRoot:f.root,ownerId:"owner",id:session.id,offset:0,request:broken,expectedChunkSize:8}),/connection dropped/);
  assert.equal(getUploadSession(f.db,"owner",session.id).offset,0);
});

test("rejects incomplete and cross-owner finalization", async t => {
  const f=await fixture(t), session=await create(f);
  await assert.rejects(prepareUploadCompletion({db:f.db,ownerId:"owner",id:session.id}),e=>e.code==="UPLOAD_INCOMPLETE");
  await assert.rejects(prepareUploadCompletion({db:f.db,ownerId:"other",id:session.id}),e=>e.code==="UPLOAD_SESSION_NOT_FOUND");
});

test("enforces total upload size and checksum format", async t => {
  const f=await fixture(t);
  await assert.rejects(create(f,{totalSize:2048}),e=>e.code==="UPLOAD_TOO_LARGE");
  await assert.rejects(create(f,{expectedSha256:"not-a-hash"}),e=>e.code==="INVALID_SHA256");
});

test("allows owner cancellation and removes partial data", async t => {
  const f=await fixture(t), session=await create(f);
  assert.equal(await abortUploadSession(f.db,"owner",session.id),true);
  assert.equal(getUploadSession(f.db,"owner",session.id),null);
});

test("cleans expired open sessions but does not sweep active writes", async t => {
  const f=await fixture(t), session=await create(f);
  f.db.prepare("UPDATE upload_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(session.id);
  assert.equal(await cleanupExpiredUploadSessions(f.db),1);
  assert.equal(getUploadSession(f.db,"owner",session.id),null);
});

test("rejects a completed file whose SHA-256 differs from the declared checksum", async t => {
  const f=await fixture(t), session=await create(f,{expectedSha256:"0".repeat(64)});
  await appendUploadChunk({db:f.db,mediaRoot:f.root,ownerId:"owner",id:session.id,offset:0,request:Readable.from([Buffer.from("RIFFWAVE")]),expectedChunkSize:8});
  await assert.rejects(prepareUploadCompletion({db:f.db,ownerId:"owner",id:session.id}),e=>e.code==="UPLOAD_CHECKSUM_MISMATCH");
  assert.equal(getUploadSession(f.db,"owner",session.id).status,"open");
});

test("rechecks project write permission when reading and appending chunks", async t => {
  const f=await fixture(t), session=await create(f,{projectId:"project-1"});
  assert.equal(getUploadSession(f.db,"owner",session.id,()=>false),null);
  await assert.rejects(appendUploadChunk({
    db:f.db,mediaRoot:f.root,ownerId:"owner",id:session.id,offset:0,
    request:Readable.from([Buffer.from("RIFF")]),expectedChunkSize:4,
    canWriteProject:()=>false
  }),e=>e.code==="UPLOAD_SESSION_NOT_FOUND");
  assert.equal(getUploadSession(f.db,"owner",session.id).offset,0);
});

test("limits each owner to ten active upload sessions", async t => {
  const f=await fixture(t);
  for(let i=0;i<10;i++) await create(f);
  await assert.rejects(create(f),e=>e.code==="TOO_MANY_UPLOAD_SESSIONS");
});
