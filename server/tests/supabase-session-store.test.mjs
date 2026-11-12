import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createSupabaseSessionStore, assertSameOriginMutation } from "../supabase-session-store.mjs";

const key = Buffer.alloc(32, 23).toString("hex");
function setup(now = () => Date.now()) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,auth_source TEXT NOT NULL DEFAULT 'supabase');");
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("user-1", "one@example.test");
  return { db, store: createSupabaseSessionStore({ db, encryptionKey: key, now }) };
}
test("stores only a hash of the opaque session id and authenticated-encrypted provider tokens", () => {
  const { db, store } = setup();
  try {
    const created = store.create({ userId: "user-1", accessToken: "access-token-secret", refreshToken: "refresh-token-secret", expiresIn: 900 });
    assert.match(created.token, /^[A-Za-z0-9_-]{40,64}$/);
    const row = db.prepare("SELECT * FROM supabase_sessions").get();
    assert.notEqual(row.token_hash, created.token);
    assert.equal(row.access_token_ciphertext.includes("access-token-secret"), false);
    assert.equal(row.refresh_token_ciphertext.includes("refresh-token-secret"), false);
    assert.equal(store.get(created.token).accessToken, "access-token-secret");
    assert.equal(store.get(created.token).refreshToken, "refresh-token-secret");
  } finally { db.close(); }
});
test("rotates provider credentials without changing the opaque browser session id", () => {
  const { db, store } = setup();
  try {
    const created = store.create({ userId: "user-1", accessToken: "old-access", refreshToken: "old-refresh" });
    const before = db.prepare("SELECT access_token_ciphertext FROM supabase_sessions").get().access_token_ciphertext;
    assert.equal(store.rotate(created.token, { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 1800 }), true);
    assert.notEqual(db.prepare("SELECT access_token_ciphertext FROM supabase_sessions").get().access_token_ciphertext, before);
    assert.equal(store.get(created.token).accessToken, "new-access");
    assert.equal(store.get(created.token).refreshToken, "new-refresh");
  } finally { db.close(); }
});
test("expires and revokes sessions and rejects malformed identifiers", () => {
  let clock = 1_800_000_000_000; const { db, store } = setup(() => clock);
  try {
    const created = store.create({ userId: "user-1", accessToken: "access", refreshToken: "refresh" });
    assert.equal(store.get("not-a-session"), null); assert.equal(store.delete(created.token), true); assert.equal(store.get(created.token), null);
    const next = store.create({ userId: "user-1", accessToken: "access", refreshToken: "refresh" });
    clock += 31 * 24 * 60 * 60 * 1000; assert.equal(store.get(next.token), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM supabase_sessions").get().count, 0);
  } finally { db.close(); }
});
test("invalid encryption keys fail closed", () => {
  const db = new DatabaseSync(":memory:"); db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE);");
  assert.throws(() => createSupabaseSessionStore({ db, encryptionKey: "too-short" }), /exactly 32 random bytes/); db.close();
});
test("cookie-authenticated mutations require an exact same-origin browser request", () => {
  assert.equal(assertSameOriginMutation({ origin: "https://studio.example.com", expectedOrigin: "https://studio.example.com", secFetchSite: "same-origin" }), true);
  assert.throws(() => assertSameOriginMutation({ origin: "https://evil.example", expectedOrigin: "https://studio.example.com", secFetchSite: "cross-site" }), error => error.code === "CSRF_ORIGIN_DENIED" && error.status === 403);
  assert.throws(() => assertSameOriginMutation({ origin: "", expectedOrigin: "https://studio.example.com" }), error => error.code === "CSRF_ORIGIN_REQUIRED");
});