import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createSupabaseSessionStore, assertSameOriginMutation } from "../supabase-session-store.mjs";
import { createSupabaseSessionRefreshCoordinator } from "../supabase-session-refresh.mjs";

const key = Buffer.alloc(32, 23).toString("hex");
const requireHash = value => createHash("sha256").update(value, "utf8").digest("hex");
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
test("authenticated encryption binds provider tokens to the session hash and user identity", () => {
  const { db, store } = setup();
  try {
    db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("user-2", "two@example.test");
    const first = store.create({ userId: "user-1", accessToken: "first-access", refreshToken: "first-refresh" });
    const second = store.create({ userId: "user-2", accessToken: "second-access", refreshToken: "second-refresh" });
    const firstRow = db.prepare("SELECT * FROM supabase_sessions WHERE token_hash=?").get(requireHash(first.token));
    const secondRow = db.prepare("SELECT * FROM supabase_sessions WHERE token_hash=?").get(requireHash(second.token));
    db.prepare("UPDATE supabase_sessions SET access_token_ciphertext=?,refresh_token_ciphertext=? WHERE token_hash=?")
      .run(secondRow.access_token_ciphertext, secondRow.refresh_token_ciphertext, firstRow.token_hash);
    assert.equal(store.get(first.token), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM supabase_sessions WHERE token_hash=?").get(firstRow.token_hash).count, 0);
  } finally { db.close(); }
});

test("coalesces concurrent refreshes so a single-use Supabase refresh token is rotated once", async () => {
  let stored={userId:"user-1",accessToken:"expired-access",refreshToken:"single-use-refresh"};
  let refreshCalls=0,rotateCalls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const store={
    get(){return stored?{...stored}:null;},
    rotate(_token,session){rotateCalls++;stored={...stored,accessToken:session.accessToken,refreshToken:session.refreshToken};return true;}
  };
  const coordinator=createSupabaseSessionRefreshCoordinator({
    store,
    async refreshSession({refreshToken}){refreshCalls++;assert.equal(refreshToken,"single-use-refresh");await gate;return{accessToken:"fresh-access",refreshToken:"fresh-refresh",user:{id:"user-1",email:"one@example.test"}};},
    async getUser(){return{id:"user-1"};}
  });
  try{
    const first=coordinator.refresh({token:"opaque-browser-session-token",config:{supabaseUrl:"https://example.supabase.co"}});
    const second=coordinator.refresh({token:"opaque-browser-session-token",config:{supabaseUrl:"https://example.supabase.co"}});
    await Promise.resolve();
    assert.equal(refreshCalls,1);
    release();
    const [a,b]=await Promise.all([first,second]);
    assert.equal(rotateCalls,1);
    assert.equal(a.stored.refreshToken,"fresh-refresh");
    assert.equal(b.stored.refreshToken,"fresh-refresh");
    assert.equal(a.user.id,"user-1");
    assert.equal(b.user.id,"user-1");
  }finally{release();}
});
test("accepts another process's completed rotation when this process sees the single-use refresh rejected",async()=>{
 let stored={userId:"user-1",accessToken:"expired-access",refreshToken:"old-refresh"};
 const store={get(){return stored?{...stored}:null;},rotate(){return false;}};
 const coordinator=createSupabaseSessionRefreshCoordinator({
  store,
  async refreshSession(){stored={...stored,accessToken:"other-process-access",refreshToken:"other-process-refresh"};return null;},
  async getUser({accessToken}){return accessToken==="other-process-access"?{id:"user-1"}:null;}
 });
 const result=await coordinator.refresh({token:"opaque-browser-session-token",config:{}});
 assert.equal(result.stored.refreshToken,"other-process-refresh");
 assert.equal(result.user.id,"user-1");
});
