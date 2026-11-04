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
function harness({ metadata = sourceFile, download = bytes, load = null, denied = false, uploadLocation = "https://www.googleapis.com/upload/drive/v3/files?upload_id=private-session" } = {}) {
  const calls = [], scopes = [];
  const assets = { async create(args) {
    calls.push({ kind: "asset-create", args });
    return { id: assetId, ownerId, projectId, name: args.originalName, mediaType: args.mediaType,
      size: args.bytes.byteLength, sha256: args.metadata.sha256, storageBucket: "executive-visuals-media" };
  }};
  const loaded = load || { asset: { id: assetId, ownerId, projectId, name: "master.mp4",
    mediaType: "video/mp4", size: bytes.length, sha256, storageBucket: "executive-visuals-media" }, bytes };
  const bridge = createGoogleDrivePrivateFileBridge({
    getUserAccessToken: async args => { scopes.push(args); return "x".repeat(40); },
    assets,
    loadPrivateAsset: async () => { if (denied) throw new Error("denied"); return loaded; },
    fetchImpl: async (url, options = {}) => {
      calls.push({ kind: "fetch", url, options });
      if (url.includes("/drive/v3/files/") && url.includes("alt=media")) {
        return response({ data: download, headers: { "content-length": String(metadata.size) } });
      }
      if (url.includes("/drive/v3/files/")) return response({ json: metadata });
      if (url.includes("uploadType=resumable")) return response({ headers: {
        location: uploadLocation
      }});
      if (options.method === "PUT") return response({ json: {
        id: "driveFile_987654321", name: "master.mp4", mimeType: "video/mp4",
        size: String(bytes.length), webViewLink: "https://drive.google.com/file/d/driveFile_987654321/view"
      }});
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
