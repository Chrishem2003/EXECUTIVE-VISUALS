import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_WRITE_MS = 15 * 60 * 1000;
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const isoAfter = ms => new Date(Date.now() + ms).toISOString();
const partialPath = (root, id) => join(resolve(root), "uploads", ".partial", id + ".part");

export function ensureResumableUploadSchema(db) {
  db.exec(\`
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      total_size INTEGER NOT NULL CHECK(total_size > 0),
      expected_sha256 TEXT,
      received_size INTEGER NOT NULL DEFAULT 0 CHECK(received_size >= 0 AND received_size <= total_size),
      storage_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','writing','finalizing')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS upload_sessions_owner_idx ON upload_sessions(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS upload_sessions_expiry_idx ON upload_sessions(expires_at, status);
  \`);
}

function sessionView(row) {
  return {
    id: row.id, projectId: row.project_id, name: row.original_name,
    mediaType: row.media_type, totalSize: row.total_size,
    receivedSize: row.received_size, offset: row.received_size,
    expectedSha256: row.expected_sha256, status: row.status,
    expiresAt: row.expires_at
  };
}

export async function createUploadSession({
  db, mediaRoot, ownerId, projectId = null, originalName, mediaType,
  totalSize, expectedSha256 = null, maxUploadBytes, canWriteProject
}) {
  if (!ownerId || !originalName || !mediaType) throw error(400, "INVALID_UPLOAD", "Owner, file name and media type are required.");
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) throw error(400, "INVALID_UPLOAD_SIZE", "Upload size must be a positive safe integer.");
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0 || totalSize > maxUploadBytes) throw error(413, "UPLOAD_TOO_LARGE", "Upload exceeds the configured size limit.");
  if (projectId && !canWriteProject(db, ownerId, projectId)) throw error(404, "PROJECT_NOT_FOUND", "Project not found or you do not have editor access.");
  if (expectedSha256 != null && !/^[a-f0-9]{64}$/i.test(expectedSha256)) throw error(400, "INVALID_SHA256", "Expected SHA-256 must contain exactly 64 hexadecimal characters.");

  const id = randomUUID();
  const path = partialPath(mediaRoot, id);
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o600);
  await handle.close();
  const expiresAt = isoAfter(SESSION_TTL_MS);
  try {
    db.prepare("INSERT INTO upload_sessions(id,owner_id,project_id,original_name,media_type,total_size,expected_sha256,storage_path,expires_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, ownerId, projectId || null, originalName, mediaType, totalSize, expectedSha256?.toLowerCase() || null, path, expiresAt);
  } catch (cause) {
    await rm(path, { force: true }).catch(() => {});
    throw cause;
  }
  return { id, projectId: projectId || null, name: originalName, mediaType, totalSize, receivedSize: 0, offset: 0, expectedSha256: expectedSha256?.toLowerCase() || null, status: "open", expiresAt };
}

export function getUploadSession(db, ownerId, id) {
  const row = db.prepare("SELECT * FROM upload_sessions WHERE id=? AND owner_id=?").get(id, ownerId);
  if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
  return sessionView(row);
}

export async function appendUploadChunk({
  db, mediaRoot, ownerId, id, offset, request,
  expectedChunkSize, maxChunkBytes = 8 * 1024 * 1024
}) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw error(400, "INVALID_UPLOAD_OFFSET", "Upload-Offset must be a non-negative safe integer.");
  if (!Number.isSafeInteger(expectedChunkSize) || expectedChunkSize <= 0 || expectedChunkSize > maxChunkBytes) throw error(413, "CHUNK_TOO_LARGE", "Chunk size must be between 1 byte and the configured chunk limit.");
  const row = db.prepare("SELECT * FROM upload_sessions WHERE id=? AND owner_id=?").get(id, ownerId);
  if (!row || Date.parse(row.expires_at) <= Date.now()) throw error(404, "UPLOAD_SESSION_NOT_FOUND", "Upload session not found or expired.");
  if (row.status !== "open") throw error(409, "UPLOAD_BUSY", "This upload session is already processing another operation.");
  if (offset !== row.received_size) throw error(409, "UPLOAD_OFFSET_MISMATCH", "Chunk offset does not match the server's committed offset.",);
  if (offset + expectedChunkSize > row.total_size) throw error(413, "UPLOAD_EXCEEDS_DECLARED_SIZE", "Chunk would exceed the declared upload size.");

  const reservation = db.prepare("UPDATE upload_sessions SET status='writing',updated_at=? WHERE id=? AND owner_id=? AND status='open' AND received_size=?")
    .run(new Date().toISOString(), id, ownerId, offset);
  if (reservation.changes !== 1) throw error(409, "UPLOAD_BUSY", "Another chunk is being written. Retry using the latest offset.");

  let handle;
  let written = 0;
  try {
    handle = await open(row.storage_path, "r+");
    for await (const value of request) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (written + chunk.length > expectedChunkSize || offset + written + chunk.length > row.total_size) {
        throw error(413, "CHUNK_SIZE_MISMATCH", "Received more bytes than declared for this chunk.");
      }
      let cursor = 0;
      while (cursor < chunk.length) {
        const result = await handle.write(chunk, cursor, chunk.length - cursor, offset + written + cursor);
        if (!result.bytesWritten) throw new Error("Upload chunk write made no progress.");
        cursor += result.bytesWritten;
      }
      written += chunk.length;
    }
    if (written !== expectedChunkSize) throw error(400, "CHUNK_SIZE_MISMATCH", "Received byte count does not match Content-Length.");
    await handle.sync();
    await handle.close();
    handle = null;
    const nextOffset = offset + written;
    const update = db.prepare("UPDATE upload_sessions SET received_size=?,status='open',expires_at=?,updated_at=? WHERE id=? AND owner_id=? AND status='writing' AND received_size=?")
      .run(nextOffset, isoAfter(SESSION_TTL_MS), new Date().toISOString(), id, ownerId, offset);
    if (update.changes !== 1) throw error(409, "UPLOAD_STATE_CHANGED", "Upload session changed while the chunk was being committed.");
    return { id, offset: nextOffset, receivedSize: nextOffset, totalSize: row.total_size, complete: nextOffset === row.total_size };
  } catch (cause) {
    if (handle) await handle.close().catch(() => {});
    const repair = await open(row.storage_path, "r+").catch(() => null);
    if (repair) { await repair.truncate(offset).catch(() => {}); await repair.close().catch(() => {}); }
    db.prepare("UPDATE upload_sessions SET status='open',updated_at=? WHERE id=? AND owner_id=? AND status='writing'")
      .run(new Date().toISOString(), id, ownerId);
    throw cause;
  }
}

export async function prepareUploadCompletion({ db, ownerId, id }) {
  const row = db.prepare("SELECT * FROM upload_sessions WHERE id=? AND owner_id=?").get(id, ownerId);
  if (!row || Date.parse(row.expires_at) <= Date.now()) throw error(404, "UPLOAD_SESSION_NOT_FOUND", "Upload session not found or expired.");
  if (row.status !== "open") throw error(409, "UPLOAD_BUSY", "Upload session is currently busy.");
  if (row.received_size !== row.total_size) throw error(409, "UPLOAD_INCOMPLETE", "Upload is incomplete; continue from the returned offset.");
  const lock = db.prepare("UPDATE upload_sessions SET status='finalizing',updated_at=? WHERE id=? AND owner_id=? AND status='open' AND received_size=total_size")
    .run(new Date().toISOString(), id, ownerId);
  if (lock.changes !== 1) throw error(409, "UPLOAD_BUSY", "Upload session is currently busy.");
  try {
    const path = row.storage_path;
    const info = await stat(path);
    if (info.size !== row.total_size) throw error(422, "UPLOAD_SIZE_MISMATCH", "Stored upload size does not match the declared size.");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    const sha256 = digest.digest("hex");
    if (row.expected_sha256 && sha256 !== row.expected_sha256) throw error(422, "UPLOAD_CHECKSUM_MISMATCH", "Uploaded file failed SHA-256 verification.");
    return { session: sessionView({ ...row, status: "finalizing" }), path, sha256, storagePath: row.storage_path };
  } catch (cause) {
    db.prepare("UPDATE upload_sessions SET status='open',updated_at=? WHERE id=? AND owner_id=? AND status='finalizing'")
      .run(new Date().toISOString(), id, ownerId);
    throw cause;
  }
}

export function releaseUploadSession(db, ownerId, id) {
  return db.prepare("DELETE FROM upload_sessions WHERE id=? AND owner_id=? AND status='finalizing'").run(id, ownerId).changes === 1;
}

export async function resetUploadFinalization(db, ownerId, id) {
  db.prepare("UPDATE upload_sessions SET status='open',updated_at=? WHERE id=? AND owner_id=? AND status='finalizing'")
    .run(new Date().toISOString(), id, ownerId);
}

export async function cleanupExpiredUploadSessions(db, { now = new Date(), staleWriteMs = STALE_WRITE_MS } = {}) {
  const cutoff = new Date(now.getTime() - staleWriteMs).toISOString();
  const rows = db.prepare("SELECT id,storage_path FROM upload_sessions WHERE expires_at<=? AND (status='open' OR (status='writing' AND updated_at<=?))")
    .all(now.toISOString(), cutoff);
  for (const row of rows) {
    const deleted = db.prepare("DELETE FROM upload_sessions WHERE id=? AND storage_path=?").run(row.id, row.storage_path);
    if (deleted.changes === 1) await rm(row.storage_path, { force: true }).catch(() => {});
  }
  return rows.length;
}

export async function abortUploadSession(db, ownerId, id) {
  const row = db.prepare("SELECT storage_path,status FROM upload_sessions WHERE id=? AND owner_id=?").get(id, ownerId);
  if (!row) return false;
  if (row.status !== "open") throw error(409, "UPLOAD_BUSY", "Cannot cancel an upload while a chunk or finalization is in progress.");
  const deleted = db.prepare("DELETE FROM upload_sessions WHERE id=? AND owner_id=? AND status='open'").run(id, ownerId);
  if (deleted.changes !== 1) return false;
  await rm(row.storage_path, { force: true }).catch(() => {});
  return true;
}
