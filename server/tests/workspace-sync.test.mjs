import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceStore, validateSnapshot, MAX_WORKSPACE_BYTES, WORKSPACE_TABLE } from "../workspace-sync.mjs";

const URL_ = "https://project.example.supabase.co";
const KEY = "sb_publishable_test_key_123456";
const tokenFor = user => user + "-access-token-0123456789";
const userOf = token => token.replace(/^Bearer /, "").split("-access-token")[0];

/** A fake storage service that behaves like the database rule: each token only ever sees its own row. */
function fakeService({ failWith } = {}) {
  const rows = new Map();
  const calls = [];
  let clock = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (failWith) return failWith(url, init);
    const user = userOf(init.headers.authorization);
    const u = new URL(url);
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
    const row = rows.get(user);
    if (init.method === "GET") return reply(200, row ? [{ data: row.data, revision: row.revision, updated_at: row.updated_at }] : []);
    const body = JSON.parse(init.body);
    if (init.method === "POST") {
      if (row) return reply(409, { code: "23505", message: "duplicate key" });
      const created = { data: body.data, revision: body.revision, updated_at: "t" + ++clock };
      rows.set(user, created);
      return reply(201, [{ revision: created.revision, updated_at: created.updated_at }]);
    }
    if (init.method === "PATCH") {
      const want = Number(u.searchParams.get("revision").replace("eq.", ""));
      if (!row || row.revision !== want) return reply(200, []);
      Object.assign(row, { data: body.data, revision: body.revision, updated_at: "t" + ++clock });
      return reply(200, [{ revision: row.revision, updated_at: row.updated_at }]);
    }
    return reply(405, {});
  };
  return { fetchImpl, rows, calls };
}

const make = opts => {
  const service = fakeService(opts);
  return { ...service, store: createWorkspaceStore({ url: URL_, publishableKey: KEY, fetchImpl: service.fetchImpl }) };
};

test("a new account has nothing saved, then saves and reads back its workspace", async () => {
  const { store } = make();
  const t = tokenFor("ann");
  assert.deepEqual(await store.get(t), { found: false, revision: 0, updatedAt: null, data: null });
  const first = await store.put(t, { data: { shots: [{ scene: "A" }] }, expectedRevision: 0 });
  assert.equal(first.revision, 1);
  const read = await store.get(t);
  assert.equal(read.found, true);
  assert.equal(read.revision, 1);
  assert.deepEqual(read.data, { shots: [{ scene: "A" }] });
  const second = await store.put(t, { data: { shots: [] }, expectedRevision: 1 });
  assert.equal(second.revision, 2);
  assert.deepEqual((await store.get(t)).data, { shots: [] });
});

test("a stale device cannot overwrite newer work and learns the current revision", async () => {
  const { store } = make();
  const t = tokenFor("bo");
  await store.put(t, { data: { v: 1 }, expectedRevision: 0 });
  await store.put(t, { data: { v: 2 }, expectedRevision: 1 });
  await assert.rejects(store.put(t, { data: { v: "stale" }, expectedRevision: 1 }), e => {
    assert.equal(e.status, 409);
    assert.equal(e.code, "WORKSPACE_CONFLICT");
    assert.equal(e.currentRevision, 2);
    return true;
  });
  assert.deepEqual((await store.get(t)).data, { v: 2 });
});

test("two devices both claiming a first save: the second is told about the conflict", async () => {
  const { store } = make();
  const t = tokenFor("cy");
  await store.put(t, { data: { device: "phone" }, expectedRevision: 0 });
  await assert.rejects(store.put(t, { data: { device: "laptop" }, expectedRevision: 0 }), e => e.code === "WORKSPACE_CONFLICT" && e.currentRevision === 1);
});

test("people only ever see their own workspace", async () => {
  const { store } = make();
  await store.put(tokenFor("dee"), { data: { secret: "dee's plan" }, expectedRevision: 0 });
  const other = await store.get(tokenFor("eli"));
  assert.equal(other.found, false);
  assert.equal(JSON.stringify(other).includes("dee"), false);
});

test("requests use the public key and the user's own token, nothing else", async () => {
  const { store, calls } = make();
  const t = tokenFor("fay");
  await store.get(t);
  await store.put(t, { data: {}, expectedRevision: 0 });
  assert.ok(calls.length >= 2);
  for (const { url, init } of calls) {
    assert.ok(url.startsWith(URL_ + "/rest/v1/" + WORKSPACE_TABLE));
    assert.equal(init.headers.apikey, KEY);
    assert.equal(init.headers.authorization, "Bearer " + t);
    assert.ok(!Object.keys(init.headers).some(h => /service|secret/i.test(h)));
  }
});

test("bad input is refused before anything is sent", async () => {
  const { store, calls } = make();
  const t = tokenFor("gus");
  await assert.rejects(store.get("short"), e => e.status === 401);
  await assert.rejects(store.put(t, { data: [1], expectedRevision: 0 }), e => e.code === "INVALID_WORKSPACE");
  await assert.rejects(store.put(t, { data: null, expectedRevision: 0 }), e => e.code === "INVALID_WORKSPACE");
  await assert.rejects(store.put(t, { data: {}, expectedRevision: -1 }), e => e.code === "INVALID_REVISION");
  await assert.rejects(store.put(t, { data: {}, expectedRevision: 1.5 }), e => e.code === "INVALID_REVISION");
  await assert.rejects(store.put(t, { data: {} }), e => e.code === "INVALID_REVISION");
  const big = { blob: "x".repeat(MAX_WORKSPACE_BYTES + 10) };
  await assert.rejects(store.put(t, { data: big, expectedRevision: 0 }), e => e.status === 413 && /too large/.test(e.message));
  assert.equal(calls.length, 0, "nothing reached the storage service");
});

test("validateSnapshot measures bytes, not characters", () => {
  assert.equal(validateSnapshot({ a: 1 }).bytes, 7);
  const multibyte = { t: "é".repeat(Math.ceil(MAX_WORKSPACE_BYTES / 2)) };
  assert.throws(() => validateSnapshot(multibyte), e => e.code === "WORKSPACE_TOO_LARGE");
  const circular = {}; circular.self = circular;
  assert.throws(() => validateSnapshot(circular), e => e.code === "INVALID_WORKSPACE");
});

test("storage problems become safe, plain messages with no internals", async () => {
  const respond = (status, body) => async () => ({ ok: false, status, text: async () => JSON.stringify(body) });
  const t = tokenFor("hal");
  const cases = [
    [respond(401, { message: "JWT expired" }), 401, "SESSION_EXPIRED"],
    [respond(403, { message: "denied" }), 401, "SESSION_EXPIRED"],
    [respond(404, { code: "42P01", message: "relation public.ev_workspace_snapshots does not exist" }), 503, "WORKSPACE_NOT_SET_UP"],
    [respond(404, { code: "PGRST205", message: "Could not find the table" }), 503, "WORKSPACE_NOT_SET_UP"],
    [respond(500, { message: "SELECT secret FROM internal_stuff failed at line 3" }), 502, "WORKSPACE_STORAGE_ERROR"]
  ];
  for (const [failWith, status, code] of cases) {
    const { store } = make({ failWith });
    await assert.rejects(store.get(t), e => {
      assert.equal(e.status, status);
      assert.equal(e.code, code);
      assert.ok(!/internal_stuff|JWT|relation|line 3/.test(e.message), "internal detail leaked: " + e.message);
      return true;
    });
  }
});

test("garbage responses and timeouts are reported, not thrown raw", async () => {
  const t = tokenFor("ivy");
  const garbage = make({ failWith: async () => ({ ok: true, status: 200, text: async () => "<html>nope</html>" }) });
  await assert.rejects(garbage.store.get(t), e => e.code === "WORKSPACE_BAD_RESPONSE");
  const slow = make({ failWith: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } });
  await assert.rejects(slow.store.get(t), e => e.status === 504 && e.code === "WORKSPACE_TIMEOUT");
  const empty = make({ failWith: async () => ({ ok: true, status: 200, text: async () => "[]" }) });
  assert.equal((await empty.store.get(t)).found, false);
});

test("setup refuses missing or unsafe configuration", () => {
  assert.throws(() => createWorkspaceStore({ url: "", publishableKey: KEY, fetchImpl: () => {} }), /requires/);
  assert.throws(() => createWorkspaceStore({ url: URL_, publishableKey: "", fetchImpl: () => {} }), /requires/);
  assert.throws(() => createWorkspaceStore({ url: "http://project.example.supabase.co", publishableKey: KEY, fetchImpl: () => {} }), /HTTPS/);
  assert.throws(() => createWorkspaceStore({ url: "https://user:pw@x.co", publishableKey: KEY, fetchImpl: () => {} }), /HTTPS/);
  assert.doesNotThrow(() => createWorkspaceStore({ url: "http://localhost:54321", publishableKey: KEY, fetchImpl: () => {} }));
});
