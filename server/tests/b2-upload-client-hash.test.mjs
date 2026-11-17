import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Blob } from "../../src/core/streaming-sha256.ts";

const nodeSha256 = bytes => createHash("sha256").update(bytes).digest("hex");

test("incremental Blob hashing matches the standard SHA-256 empty-input vector", async () => {
  assert.equal(
    await sha256Blob(new Blob([])),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});

test("incremental Blob hashing matches Node SHA-256 across multiple chunk boundaries", async () => {
  const source = Buffer.alloc(3 * 1024 * 1024 + 123, 0x5a);
  const blob = new Blob([source]);
  assert.equal(await sha256Blob(blob, { chunkBytes: 1024 * 1024 }), nodeSha256(source));
});

test("incremental Blob hashing supports arbitrary binary content and a final partial chunk", async () => {
  const source = Buffer.from(Array.from({ length: 512 * 1024 + 19 }, (_, index) => index % 251));
  assert.equal(await sha256Blob(new Blob([source]), { chunkBytes: 128 * 1024 }), nodeSha256(source));
});

test("incremental Blob hashing stops when the caller aborts", async () => {
  const controller = new AbortController();
  let updates = 0;
  await assert.rejects(
    () => sha256Blob(new Blob([Buffer.alloc(1024 * 1024)]), {
      chunkBytes: 128 * 1024,
      signal: controller.signal,
      onProgress: () => { updates += 1; controller.abort(); }
    }),
    error => error?.name === "AbortError" && /cancelled/i.test(error.message)
  );
  assert.equal(updates, 1);
});

test("incremental Blob hashing rejects unsafe chunk sizes", async () => {
  await assert.rejects(() => sha256Blob(new Blob(["x"]), { chunkBytes: 1024 }), /between 64 KiB and 32 MiB/);
});
