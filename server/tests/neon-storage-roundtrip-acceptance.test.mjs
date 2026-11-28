import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runNeonStorageRoundtrip } from "../verify-neon-storage-roundtrip.mjs";

function fakeStorage({ failVerify = false } = {}) {
  const objects = new Map();
  const calls = [];
  return {
    calls,
    async checkReadiness() {
      calls.push("readiness");
      return { ready: true, storage: "private", provider: "neon-object-storage" };
    },
    async upload(path, bytes, contentType) {
      calls.push("upload");
      objects.set(path, Buffer.from(bytes));
      return { path, size: bytes.byteLength, contentType };
    },
    async verifyObject(path, expected) {
      calls.push("verify");
      if (failVerify) throw new Error("synthetic checksum mismatch");
      const bytes = objects.get(path);
      assert.ok(bytes);
      assert.equal(bytes.byteLength, expected.expectedSize);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.expectedSha256);
      return { path, size: bytes.byteLength, sha256: expected.expectedSha256 };
    },
    async createSignedUrl(path, expiry) {
      calls.push("sign");
      assert.ok(objects.has(path));
      return "https://storage.example.test/bucket/" + path + "?X-Amz-Expires=" + expiry;
    },
    async remove(path) {
      calls.push("remove");
      objects.delete(path);
      return true;
    },
    objects
  };
}

test("Neon acceptance verifies readiness, upload, authenticated read, signed download and cleanup", async () => {
  const storage = fakeStorage();
  const result = await runNeonStorageRoundtrip({
    storage,
    fetchImpl: async url => {
      const path = new URL(url).pathname.split("/").slice(2).join("/");
      const bytes = storage.objects.get(path);
      return { ok: Boolean(bytes), status: bytes ? 200 : 404, arrayBuffer: async () => bytes };
    }
  });
  assert.deepEqual(result, {
    ready: true,
    provider: "neon-object-storage",
    privacy: "private",
    uploadVerified: true,
    authenticatedReadVerified: true,
    presignedDownloadVerified: true,
    checksumVerified: true,
    cleanupPending: false,
    cleanupVerified: true
  });
  assert.deepEqual(storage.calls, ["readiness", "upload", "verify", "sign", "remove"]);
  assert.equal(storage.objects.size, 0);
});

test("Neon acceptance removes its temporary object when read-back fails", async () => {
  const storage = fakeStorage({ failVerify: true });
  await assert.rejects(
    () => runNeonStorageRoundtrip({ storage, fetchImpl: async () => { throw new Error("must not download"); } }),
    /synthetic checksum mismatch/
  );
  assert.equal(storage.calls.at(-1), "remove");
  assert.equal(storage.objects.size, 0);
});

test("Neon acceptance refuses a bucket that is not confirmed private", async () => {
  const storage = fakeStorage();
  storage.checkReadiness = async () => ({ ready: true, storage: "public" });
  await assert.rejects(
    () => runNeonStorageRoundtrip({ storage }),
    /private bucket/
  );
  assert.deepEqual(storage.calls, []);
});

test("Neon acceptance rejects a non-HTTPS signed download URL and still cleans up", async () => {
  const storage = fakeStorage();
  storage.createSignedUrl = async path => {
    storage.calls.push("sign");
    return "http://storage.example.test/" + path + "?X-Amz-Expires=120";
  };
  await assert.rejects(() => runNeonStorageRoundtrip({ storage }), /invalid or unsafe/);
  assert.equal(storage.calls.at(-1), "remove");
  assert.equal(storage.objects.size, 0);
});
