import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGoogleDrivePrivateFileBridge } from "../google-drive-private-file-bridge.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const bytes = new Uint8Array([1, 2, 3, 4, 5]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const sourceFile = { id: "driveFile_123456789", name: "private clip.mp4", mimeType: "video/mp4",
  size: String(bytes.length), trashed: false, capabilities: { canDownload: true } };
function response({ status = 200, json = null, data = bytes, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get(name) { return headers[name.toLowerCase()] ?? null; } },
    async text() { return json === null ? "" : JSON.stringify(json); },
    async arrayBuffer() { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); },
    body: new ReadableStream({
      start(controller) {
        if (data.byteLength) controller.enqueue(data);
        controller.close();
      }
    })
  };
}
function harness({ metadata = sourceFile, download = bytes, load = null, denied = false, cleanup = async () => {}, uploadError = false, initError = false, uploadLocation = "https://www.googleapis.com/upload/drive/v3/files?upload_id=private-session", folder = { id: "driveFolder_123456789", mimeType: "application/vnd.google-apps.folder", trashed: false, capabilities: { canAddChildren: true } }, uploadChecksum = createHash("md5").update(bytes).digest("hex"), uploadSteps = [], attempts = null, existingDriveFile = null, generatedFileId = "driveFile_987654321" } = {}) {
  const calls = [], scopes = [];
  let uploadStepIndex = 0;
  const assets = { async create(args) {
    calls.push({ kind: "asset-create", args });
    return { id: assetId, ownerId, projectId, name: args.originalName, mediaType: args.mediaType,
      size: args.bytes.byteLength, sha256: args.metadata.sha256, storageBucket: "executive-visuals-media" };
  }};
  const loaded = load || { asset: { id: assetId, ownerId, projectId, name: "master.mp4",
    mediaType: "video/mp4", size: bytes.length, sha256, storageBucket: "executive-visuals-media" }, bytes, cleanup };
  const bridge = createGoogleDrivePrivateFileBridge({
    getUserAccessToken: async args => { scopes.push(args); return "x".repeat(40); },
    assets,
    loadPrivateAsset: async () => { if (denied) throw new Error("denied"); return loaded; },
    attempts,
    fetchImpl: async (url, options = {}) => {
      calls.push({ kind: "fetch", url, options });
      if (url.includes("/drive/v3/files/generateIds")) return response({ json: { ids: [generatedFileId] } });
      if (url.includes("fields=id,name,mimeType,size,md5Checksum,webViewLink,appProperties,trashed")) {
        return existingDriveFile ? response({ json: existingDriveFile }) : response({ status: 404 });
      }
      if (url.includes("/drive/v3/files/") && url.includes("fields=id,mimeType,trashed,capabilities")) return response({ json: folder });
      if (url.includes("/drive/v3/files/") && url.includes("alt=media")) {
        return response({ data: download, headers: { "content-length": String(metadata.size) } });
      }
      if (url.includes("/drive/v3/files/")) return response({ json: metadata });
      if (url.includes("uploadType=resumable")) {
        if (initError) throw new Error("simulated interrupted Drive session initiation");
        return response({ headers: { location: uploadLocation } });
      }
      if (options.method === "PUT") {
        if (uploadSteps[uploadStepIndex]) {
          const step = uploadSteps[uploadStepIndex++];
          if (step.throw) throw new Error("simulated interrupted Drive upload");
          return response(step);
        }
        if (uploadError) throw new Error("simulated interrupted Drive upload");
        return response({ json: {
          id: "driveFile_987654321", name: "master.mp4", mimeType: "video/mp4",
          size: String(bytes.length), md5Checksum: uploadChecksum, webViewLink: "https://drive.google.com/file/d/driveFile_987654321/view",
          appProperties: { source: "executive-visuals", assetId }
        }});
      }
      throw new Error("Unexpected URL");
    }
  });
  return { bridge, calls, scopes };
}

test("imports a user-selected Drive file into owner/project private asset storage", async () => {
  const h = harness();
  const result = await h.bridge.importFile({ ownerId, projectId, fileId: sourceFile.id });
  assert.equal(result.asset.id, assetId);
  const create = h.calls.find(x => x.kind === "asset-create").args;
  assert.equal(create.ownerId, ownerId);
  assert.equal(create.projectId, projectId);
  assert.equal(create.mediaType, "video/mp4");
  assert.equal(create.metadata.providerFileId, sourceFile.id);
  assert.equal(create.metadata.sha256, sha256);
  assert.deepEqual(h.scopes[0].scopes, ["https://www.googleapis.com/auth/drive.file"]);
});

test("rejects unsupported Google-native documents, trashed, non-downloadable and oversized files", async () => {
  for (const metadata of [
    { ...sourceFile, mimeType: "application/vnd.google-apps.document" },
    { ...sourceFile, trashed: true },
    { ...sourceFile, capabilities: { canDownload: false } },
    { ...sourceFile, capabilities: {} },
    { ...sourceFile, size: String(251 * 1024 * 1024) }
  ]) {
    const h = harness({ metadata });
    await assert.rejects(() => h.bridge.importFile({ ownerId, projectId, fileId: sourceFile.id }),
      error => error.code === "GOOGLE_DRIVE_FILE_UNSUPPORTED");
    assert.equal(h.calls.some(x => x.kind === "asset-create"), false);
  }
});

test("rejects mismatched or oversized Drive downloads before private storage", async () => {
  const h = harness({ download: new Uint8Array([1, 2]) });
  await assert.rejects(() => h.bridge.importFile({ ownerId, projectId, fileId: sourceFile.id }),
    error => error.code === "GOOGLE_DRIVE_SIZE_MISMATCH");
  assert.equal(h.calls.some(x => x.kind === "asset-create"), false);
});

test("exports a verified private asset to Drive using OAuth resumable upload", async () => {
  const h = harness();
  const result = await h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId });
  assert.equal(result.id, "driveFile_987654321");
  assert.equal(result.webViewLink, "https://drive.google.com/file/d/driveFile_987654321/view");
  const init = h.calls.find(x => x.url?.includes("uploadType=resumable"));
  assert.equal(init.options.method, "POST");
  assert.equal(init.options.headers["x-upload-content-length"], String(bytes.length));
  const upload = h.calls.find(x => x.options?.method === "PUT");
  assert.equal(upload.options.body.byteLength, bytes.length);
});




test("uses a persisted pre-generated Drive file ID and marks a verified export complete", async () => {
  let record = null;
  const attempts = {
    async get() { return record; },
    async claim() { return "44444444-4444-4444-8444-444444444444"; },
    async createOrGet(value) {
      record = { ...value, state: "PREPARED", sessionUri: null, webViewLink: null };
      return record;
    },
    async saveSession(value) {
      record = { ...record, state: "UPLOADING", sessionUri: value.sessionUri };
      return record;
    },
    async mark(value) {
      record = { ...record, state: value.state, sessionUri: value.state === "COMPLETED" ? null : record.sessionUri,
        webViewLink: value.webViewLink || null };
      return record;
    }
  };
  const h = harness({ attempts });
  const result = await h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId });
  assert.equal(result.id, "driveFile_987654321");
  assert.equal(record.state, "COMPLETED");
  assert.equal(record.driveFileId, "driveFile_987654321");
  const init = h.calls.find(x => x.url?.includes("uploadType=resumable"));
  assert.equal(JSON.parse(init.options.body).id, "driveFile_987654321");
  assert.ok(h.calls.some(x => x.url?.includes("/files/generateIds")));
});


test("requires provider reconciliation when completed upload metadata fails checksum validation", async () => {
  const leaseToken = "44444444-4444-4444-8444-444444444444";
  const marks = [];
  let record = null;
  const attempts = {
    async get() { return record; },
    async createOrGet(value) { record = { ...value, state: "PREPARED", sessionUri: null }; return record; },
    async claim() { return leaseToken; },
    async saveSession(value) { record = { ...record, state: "UPLOADING", sessionUri: value.sessionUri }; return record; },
    async mark(value) { marks.push(value); record = { ...record, state: value.state }; return record; }
  };
  const h = harness({ attempts, uploadChecksum: "00000000000000000000000000000000" });
  await assert.rejects(() => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
    error => error.code === "GOOGLE_DRIVE_UPLOAD_RESPONSE_INVALID");
  assert.equal(marks.at(-1).state, "RECONCILIATION_REQUIRED");
  assert.equal(marks.at(-1).leaseToken, leaseToken);
});

test("releases the export lease as outcome-unknown after ambiguous session initiation", async () => {
  const leaseToken = "44444444-4444-4444-8444-444444444444";
  const marks = [];
  let record = null;
  const attempts = {
    async get() { return record; },
    async createOrGet(value) { record = { ...value, state: "PREPARED", sessionUri: null }; return record; },
    async claim() { return leaseToken; },
    async saveSession() { throw new Error("session must not be persisted after failed initiation"); },
    async mark(value) { marks.push(value); record = { ...record, state: value.state }; return record; }
  };
  const h = harness({ attempts, initError: true });
  await assert.rejects(() => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
    error => error.code === "GOOGLE_DRIVE_REQUEST_FAILED");
  assert.equal(marks.length, 1);
  assert.equal(marks[0].state, "OUTCOME_UNKNOWN");
  assert.equal(marks[0].leaseToken, leaseToken);
});

test("recovers an ambiguous initiation using the same reserved Drive file ID", async () => {
  const leaseToken = "44444444-4444-4444-8444-444444444444";
  let record = {
    attemptKey: "a".repeat(64), ownerId, projectId, assetId, parentFolderId: null,
    driveFileId: "driveFile_987654321", mimeType: "video/mp4", byteSize: bytes.length,
    sha256, state: "OUTCOME_UNKNOWN", sessionUri: null
  };
  const attempts = {
    async get() { return record; },
    async createOrGet() { throw new Error("an existing attempt must not be recreated"); },
    async claim() { return leaseToken; },
    async saveSession(value) { record = { ...record, state: "UPLOADING", sessionUri: value.sessionUri }; return record; },
    async mark(value) { record = { ...record, state: value.state }; return record; }
  };
  const h = harness({ attempts });
  const result = await h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId });
  assert.equal(result.id, "driveFile_987654321");
  const init = h.calls.find(x => x.url?.includes("uploadType=resumable"));
  assert.equal(JSON.parse(init.options.body).id, "driveFile_987654321");
  assert.equal(h.calls.filter(x => x.url?.includes("/files/generateIds")).length, 0);
  assert.equal(record.state, "COMPLETED");
});

test("reconciles a quarantined export under a dedicated lease without starting another upload", async () => {
  const leaseToken = "44444444-4444-4444-8444-444444444444";
  const expectedMd5 = createHash("md5").update(bytes).digest("hex");
  const driveFile = { id: "driveFile_987654321", name: "master.mp4", mimeType: "video/mp4",
    size: String(bytes.length), md5Checksum: expectedMd5,
    webViewLink: "https://drive.google.com/file/d/driveFile_987654321/view",
    appProperties: { source: "executive-visuals", assetId }, trashed: false };
  const record = { attemptKey: "a".repeat(64), ownerId, projectId, assetId, parentFolderId: null,
    driveFileId: driveFile.id, mimeType: "video/mp4", byteSize: bytes.length, sha256,
    state: "RECONCILIATION_REQUIRED", sessionUri: null };
  const marks = [];
  const attempts = {
    async get() { return record; },
    async createOrGet() { throw new Error("reconciliation must not create a new attempt"); },
    async claim() { throw new Error("ordinary upload claim must not be used for reconciliation"); },
    async claimForReconciliation() { return leaseToken; },
    async saveSession() { throw new Error("reconciliation must not persist an upload session"); },
    async mark(value) { marks.push(value); return { ...record, state: value.state }; }
  };
  const h = harness({ attempts, existingDriveFile: driveFile });
  const result = await h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId });
  assert.equal(result.id, driveFile.id);
  assert.equal(marks.at(-1).state, "COMPLETED");
  assert.equal(marks.at(-1).leaseToken, leaseToken);
  assert.equal(h.calls.some(x => x.url?.includes("uploadType=resumable")), false);
  assert.equal(h.calls.some(x => x.url?.includes("/files/generateIds")), false);
});

test("keeps a quarantined export blocked when its reserved Drive file is not found", async () => {
  const leaseToken = "44444444-4444-4444-8444-444444444444";
  const record = { attemptKey: "a".repeat(64), ownerId, projectId, assetId, parentFolderId: null,
    driveFileId: "driveFile_987654321", mimeType: "video/mp4", byteSize: bytes.length, sha256,
    state: "RECONCILIATION_REQUIRED", sessionUri: null };
  const marks = [];
  const attempts = {
    async get() { return record; },
    async createOrGet() { throw new Error("reconciliation must not create a new attempt"); },
    async claim() { throw new Error("ordinary upload claim must not be used for reconciliation"); },
    async claimForReconciliation() { return leaseToken; },
    async saveSession() { throw new Error("quarantined export must not restart"); },
    async mark(value) { marks.push(value); return { ...record, state: value.state }; }
  };
  const h = harness({ attempts });
  await assert.rejects(() => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
    error => error.code === "GOOGLE_DRIVE_EXPORT_RECONCILIATION_REQUIRED");
  assert.equal(marks.at(-1).state, "RECONCILIATION_REQUIRED");
  assert.equal(marks.at(-1).leaseToken, leaseToken);
  assert.equal(h.calls.some(x => x.url?.includes("uploadType=resumable")), false);
  assert.equal(h.calls.some(x => x.url?.includes("/files/generateIds")), false);
});

test("releases the reconciliation lease when provider metadata conflicts", async () => {
  const leaseToken = "44444444-4444-4444-8444-444444444444";
  const record = { attemptKey: "a".repeat(64), ownerId, projectId, assetId, parentFolderId: null,
    driveFileId: "driveFile_987654321", mimeType: "video/mp4", byteSize: bytes.length, sha256,
    state: "RECONCILIATION_REQUIRED", sessionUri: null };
  const marks = [];
  const attempts = {
    async get() { return record; },
    async createOrGet() { throw new Error("reconciliation must not create a new attempt"); },
    async claim() { throw new Error("ordinary upload claim must not be used"); },
    async claimForReconciliation() { return leaseToken; },
    async saveSession() { throw new Error("reconciliation must not upload"); },
    async mark(value) { marks.push(value); return { ...record, state: value.state }; }
  };
  const conflictingFile = { id: record.driveFileId, name: "wrong.mp4", mimeType: "video/mp4",
    size: String(bytes.length), md5Checksum: "0".repeat(32),
    appProperties: { source: "executive-visuals", assetId }, trashed: false };
  const h = harness({ attempts, existingDriveFile: conflictingFile });
  await assert.rejects(() => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
    error => error.code === "GOOGLE_DRIVE_EXPORT_RECONCILIATION_CONFLICT");
  assert.equal(marks.at(-1).state, "RECONCILIATION_REQUIRED");
  assert.equal(marks.at(-1).leaseToken, leaseToken);
  assert.equal(marks.at(-1).errorCode, "GOOGLE_DRIVE_EXPORT_RECONCILIATION_CONFLICT");
  assert.equal(h.calls.some(x => x.url?.includes("uploadType=resumable")), false);
});

test("rejects a durable attempt whose MIME type differs from the private asset", async () => {
  const attempts = {
    async get() { return { ownerId, projectId, assetId, mimeType: "application/pdf",
      sha256, byteSize: bytes.length, parentFolderId: null, state: "PREPARED", driveFileId: "driveFile_987654321" }; },
    async claim() { throw new Error("mismatched attempts must be rejected before claiming"); },
    async createOrGet() { throw new Error("mismatched attempts must not be recreated"); },
    async saveSession() {}, async mark() {}
  };
  const h = harness({ attempts });
  await assert.rejects(() => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
    error => error.code === "GOOGLE_DRIVE_EXPORT_IDEMPOTENCY_CONFLICT");
  assert.equal(h.calls.some(x => x.url?.includes("uploadType=resumable")), false);
});

test("fences expired-session reconciliation with the worker lease", async () => {
  const leaseToken = "44444444-4444-4444-8444-444444444444";
  const marks = [];
  let record = null;
  const attempts = {
    async get() { return record; },
    async createOrGet(value) {
      record = { ...value, state: "PREPARED", sessionUri: null, webViewLink: null };
      return record;
    },
    async claim() { return leaseToken; },
    async saveSession(value) {
      record = { ...record, state: "UPLOADING", sessionUri: value.sessionUri };
      return record;
    },
    async mark(value) { marks.push(value); record = { ...record, state: value.state }; return record; }
  };
  const h = harness({ attempts, uploadSteps: [{ throw: true }, { status: 404 }] });
  await assert.rejects(() => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
    error => error.code === "GOOGLE_DRIVE_UPLOAD_SESSION_EXPIRED");
  assert.equal(marks.length, 1);
  assert.equal(marks[0].state, "RECONCILIATION_REQUIRED");
  assert.equal(marks[0].leaseToken, leaseToken);
});

test("refuses a second worker while a durable Drive export lease is active", async () => {
  const attempts = {
    async get() { return null; },
    async createOrGet(value) { return { ...value, state: "PREPARED", sessionUri: null }; },
    async claim() { return null; },
    async saveSession() { throw new Error("a worker without a lease must not save a session"); },
    async mark() { throw new Error("a worker without a lease must not mutate attempt state"); }
  };
  const h = harness({ attempts });
  await assert.rejects(() => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
    error => error.code === "GOOGLE_DRIVE_EXPORT_IN_PROGRESS");
  assert.equal(h.calls.some(x => x.url?.includes("uploadType=resumable")), false);
});

test("returns an already completed Drive export after provider reconciliation without creating another file", async () => {
  const expectedMd5 = createHash("md5").update(bytes).digest("hex");
  const driveFile = { id: "driveFile_987654321", name: "master.mp4", mimeType: "video/mp4",
    size: String(bytes.length), md5Checksum: expectedMd5,
    webViewLink: "https://drive.google.com/file/d/driveFile_987654321/view",
    appProperties: { source: "executive-visuals", assetId }, trashed: false };
  const attemptRecord = { attemptKey: "a".repeat(64), ownerId, projectId, assetId,
    parentFolderId: null, driveFileId: driveFile.id, mimeType: "video/mp4", byteSize: bytes.length,
    sha256, state: "COMPLETED", sessionUri: null };
  const attempts = {
    async get() { return attemptRecord; },
    async createOrGet() { throw new Error("completed attempts must not create a new ledger row"); },
    async claim() { throw new Error("completed attempts must not acquire a new lease"); },
    async saveSession() { throw new Error("completed attempts must not create a new session"); },
    async mark() { throw new Error("already completed"); }
  };
  const h = harness({ attempts, existingDriveFile: driveFile });
  const result = await h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId });
  assert.equal(result.id, driveFile.id);
  assert.equal(h.calls.some(x => x.url?.includes("uploadType=resumable")), false);
  assert.equal(h.calls.some(x => x.url?.includes("/files/generateIds")), false);
});

test("resumes a Drive upload from the provider-confirmed byte range after a lost response", async () => {
  const completed = {
    id: "driveFile_987654321", name: "master.mp4", mimeType: "video/mp4",
    size: String(bytes.length), md5Checksum: createHash("md5").update(bytes).digest("hex"),
    webViewLink: "https://drive.google.com/file/d/driveFile_987654321/view"
  };
  const h = harness({ uploadSteps: [
    { throw: true },
    { status: 308, headers: { range: "bytes=0-1" } },
    { json: completed }
  ]});
  const result = await h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId });
  assert.equal(result.id, completed.id);
  const puts = h.calls.filter(x => x.options?.method === "PUT");
  assert.equal(puts.length, 3);
  assert.equal(puts[1].options.headers["content-range"], `bytes */${bytes.length}`);
  assert.equal(puts[2].options.headers["content-range"], `bytes 2-${bytes.length - 1}/${bytes.length}`);
  assert.equal(puts[2].options.body.byteLength, bytes.length - 2);
});



test("rejects malformed or out-of-bounds Drive resumable byte ranges", async () => {
  for (const range of ["bytes=2-4", "bytes=0-99", "bytes=invalid"]) {
    const h = harness({ uploadSteps: [
      { throw: true },
      { status: 308, headers: { range } }
    ]});
    await assert.rejects(
      () => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
      error => error.code === "GOOGLE_DRIVE_UPLOAD_RANGE_INVALID"
    );
  }
});

test("restarts the current transfer from byte zero when Drive reports no persisted range", async () => {
  const completed = {
    id: "driveFile_987654321", name: "master.mp4", mimeType: "video/mp4",
    size: String(bytes.length), md5Checksum: createHash("md5").update(bytes).digest("hex"),
    webViewLink: "https://drive.google.com/file/d/driveFile_987654321/view"
  };
  const h = harness({ uploadSteps: [
    { throw: true },
    { status: 308 },
    { json: completed }
  ]});
  const result = await h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId });
  assert.equal(result.id, completed.id);
  const puts = h.calls.filter(x => x.options?.method === "PUT");
  assert.equal(puts[2].options.headers["content-range"], `bytes 0-${bytes.length - 1}/${bytes.length}`);
  assert.equal(puts[2].options.body.byteLength, bytes.length);
});

test("does not restart an expired Drive upload session without reconciliation", async () => {
  const h = harness({ uploadSteps: [
    { throw: true },
    { status: 404 }
  ]});
  await assert.rejects(
    () => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
    error => error.code === "GOOGLE_DRIVE_UPLOAD_SESSION_EXPIRED"
  );
  assert.equal(h.calls.filter(x => x.url?.includes("uploadType=resumable")).length, 1);
});

test("preflights a selected Drive destination folder before exporting a private asset", async () => {
  const h = harness();
  await h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId, parentFolderId: "driveFolder_123456789" });
  const folderCheck = h.calls.findIndex(x => x.url?.includes("fields=id,mimeType,trashed,capabilities"));
  const uploadInit = h.calls.findIndex(x => x.url?.includes("uploadType=resumable"));
  assert.ok(folderCheck >= 0);
  assert.ok(uploadInit > folderCheck);
  assert.match(h.calls[folderCheck].url, /supportsAllDrives=true/);
});

test("rejects a non-folder, trashed folder, or folder without add-child capability", async () => {
  for (const folder of [
    { id: "driveFolder_123456789", mimeType: "video/mp4", trashed: false, capabilities: { canAddChildren: true } },
    { id: "driveFolder_123456789", mimeType: "application/vnd.google-apps.folder", trashed: true, capabilities: { canAddChildren: true } },
    { id: "driveFolder_123456789", mimeType: "application/vnd.google-apps.folder", trashed: false, capabilities: { canAddChildren: false } },
    { id: "driveFolder_123456789", mimeType: "application/vnd.google-apps.folder", trashed: false, capabilities: {} }
  ]) {
    const h = harness({ folder });
    await assert.rejects(
      () => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId, parentFolderId: "driveFolder_123456789" }),
      error => error.code === "GOOGLE_DRIVE_FOLDER_UNAVAILABLE"
    );
    assert.equal(h.calls.some(x => x.url?.includes("uploadType=resumable")), false);
  }
});

test("rejects a Drive upload whose returned MD5 checksum does not match the private asset", async () => {
  const h = harness({ uploadChecksum: "0".repeat(32) });
  await assert.rejects(
    () => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
    error => error.code === "GOOGLE_DRIVE_UPLOAD_RESPONSE_INVALID"
  );
});

test("cleans up the private asset materialization after a successful Drive export", async () => {
  let cleanupCalls = 0;
  const h = harness({ cleanup: async () => { cleanupCalls++; } });
  await h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId });
  assert.equal(cleanupCalls, 1);
});

test("cleans up the private asset materialization when a resumable Drive upload fails", async () => {
  let cleanupCalls = 0;
  const h = harness({ cleanup: async () => { cleanupCalls++; }, uploadError: true });
  await assert.rejects(() => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
    error => error.code === "GOOGLE_DRIVE_REQUEST_FAILED");
  assert.equal(cleanupCalls, 1);
});

test("does not export when private asset authorization fails or hash does not match", async () => {
  const denied = harness({ denied: true });
  await assert.rejects(() => denied.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
    error => error.code === "GOOGLE_DRIVE_ASSET_FORBIDDEN");
  assert.equal(denied.calls.some(x => x.url?.includes("uploadType=resumable")), false);

  const bad = harness({ load: { asset: {
    id: assetId, ownerId, projectId, name: "master.mp4", mediaType: "video/mp4",
    size: bytes.length, sha256: "f".repeat(64), storageBucket: "executive-visuals-media"
  }, bytes }});
  await assert.rejects(() => bad.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
    error => error.code === "GOOGLE_DRIVE_ASSET_INVALID");
  assert.equal(bad.calls.some(x => x.url?.includes("uploadType=resumable")), false);
});

test("rejects invalid Drive identifiers, project scopes and unsafe upload session hosts", async () => {
  const h = harness();
  await assert.rejects(() => h.bridge.importFile({ ownerId: "bad", fileId: sourceFile.id }),
    error => error.code === "GOOGLE_DRIVE_SCOPE_INVALID");
  await assert.rejects(() => h.bridge.importFile({ ownerId, fileId: "x" }),
    error => error.code === "GOOGLE_DRIVE_FILE_ID_INVALID");
});

test("rejects a Drive media response whose content type conflicts with file metadata", async () => {
  const h = harness();
  const original = h.bridge;
  // A separate bridge isolates the download response header from the fixture.
  const calls = [];
  const bridge = createGoogleDrivePrivateFileBridge({
    getUserAccessToken: async () => "x".repeat(40),
    assets: { create: async () => { throw new Error("must not persist"); } },
    loadPrivateAsset: async () => null,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("alt=media")) return response({ headers: { "content-type": "application/pdf", "content-length": String(bytes.length) } });
      return response({ json: sourceFile });
    }
  });
  await assert.rejects(() => bridge.importFile({ ownerId, projectId, fileId: sourceFile.id }),
    error => error.code === "GOOGLE_DRIVE_MIME_MISMATCH");
  assert.equal(calls.length, 2);
});

test("rejects deceptive resumable upload session paths and hosts before sending media bytes", async () => {
  for (const uploadLocation of [
    "https://www.googleapis.com/upload/drive/v3/files-evil?upload_id=x",
    "https://attacker.example/upload/drive/v3/files?upload_id=x",
    "http://www.googleapis.com/upload/drive/v3/files?upload_id=x",
    "https://www.googleapis.com:444/upload/drive/v3/files?upload_id=x"
  ]) {
    const h = harness({ uploadLocation });
    await assert.rejects(() => h.bridge.uploadPrivateAsset({ ownerId, projectId, assetId }),
      error => error.code === "GOOGLE_DRIVE_UPLOAD_SESSION_INVALID");
    assert.equal(h.calls.some(x => x.options?.method === "PUT"), false);
  }
});
