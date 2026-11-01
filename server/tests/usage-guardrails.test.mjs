import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.mjs";
import { reserveRemoteRequest } from "../usage-guardrails.mjs";

test("remote usage guardrail reserves requests before dispatch and blocks over-limit calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-remote-usage-"));
  const db = openDatabase(join(root, "usage.sqlite"));
  try {
    db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("remote-owner", "remote@example.test");
    const remote = { provider: "remote-text", remote: true };
    const local = { provider: "local-text", remote: false };
    assert.deepEqual(reserveRemoteRequest(db, {
      ownerId: "remote-owner", provider: local, capability: "text.generate", limit: 1
    }), { reserved: false, reason: "local_provider" });
    const first = reserveRemoteRequest(db, {
      ownerId: "remote-owner", provider: remote, capability: "text.generate", limit: 1
    });
    assert.equal(first.reserved, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM remote_usage_reservations WHERE owner_id=?").get("remote-owner").count, 1);
    assert.throws(() => reserveRemoteRequest(db, {
      ownerId: "remote-owner", provider: remote, capability: "image.generate", limit: 1
    }), error => error.code === "REMOTE_USAGE_LIMIT_REACHED" && error.limit === 1 && error.used === 1);
    assert.throws(() => reserveRemoteRequest(db, {
      ownerId: "remote-owner", provider: remote, capability: "text.generate", limit: 0
    }), error => error.code === "REMOTE_USAGE_LIMIT_REACHED");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("remote usage guardrail rejects malformed limits and does not count local calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-remote-usage-invalid-"));
  const db = openDatabase(join(root, "usage.sqlite"));
  try {
    db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("remote-owner", "remote@example.test");
    assert.throws(() => reserveRemoteRequest(db, {
      ownerId: "remote-owner", provider: { provider: "remote", remote: true },
      capability: "text.generate", limit: -1
    }), error => error.code === "REMOTE_USAGE_LIMIT_CONFIG_INVALID");
    assert.deepEqual(reserveRemoteRequest(db, {
      ownerId: "remote-owner", provider: { provider: "local", remote: false },
      capability: "text.generate", limit: 0
    }), { reserved: false, reason: "local_provider" });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
