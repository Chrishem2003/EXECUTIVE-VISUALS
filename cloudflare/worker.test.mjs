import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "./worker.mjs";

const migration = await readFile(new URL("../migrations/d1/0001_initial.sql", import.meta.url), "utf8");
const userId = "11111111-1111-4111-8111-111111111111";

function makeD1(apply = true) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  if (apply) sqlite.exec(migration);
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() { return sqlite.prepare(sql).get(...values) ?? null; },
            async all() { return { results: sqlite.prepare(sql).all(...values) }; },
            async run() { return sqlite.prepare(sql).run(...values); },
            __run() { return sqlite.prepare(sql).run(...values); }
          };
        }
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(statement => ({ success: true, meta: statement.__run() }));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    countUsers() { return sqlite.prepare("SELECT COUNT(*) AS count FROM ev_users").get().count; },
    close() { sqlite.close(); }
  };
  return db;
}

test("D1 Worker requires schema migration before serving staging routes", async () => {
  const DB = makeD1(false);
  const response = await worker.fetch(new Request("https://staging.example/api/d1/projects"), { DB, API_ORIGIN: "https://executive-visuals.onrender.com" });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "D1_MIGRATION_REQUIRED");
  DB.close();
});

test("D1 Worker authenticates through the existing API before creating staging records", async t => {
  const DB = makeD1();
  t.mock.method(globalThis, "fetch", async request => {
    assert.equal(new URL(request.url).pathname, "/api/me");
    assert.equal(request.headers.get("authorization"), "Bearer staging-test-token");
    assert.equal(request.headers.get("origin"), "https://executive-visuals.onrender.com");
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", "ev_supabase_access=rotated-access; HttpOnly; Secure");
    headers.append("set-cookie", "ev_supabase_refresh=rotated-refresh; HttpOnly; Secure");
    return new Response(JSON.stringify({ user: { id: userId, email: "editor@example.test" }, authMode: "supabase" }), { status: 200, headers });
  });
  const env = { DB, API_ORIGIN: "https://executive-visuals.onrender.com" };
  const create = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
    method: "POST",
    headers: { authorization: "Bearer staging-test-token", "content-type": "application/json" },
    body: JSON.stringify({ name: "D1 staging project", settings: { fps: 24 } })
  }), env);
  const createdResponse = await create.json();
  assert.equal(create.status, 201, JSON.stringify(createdResponse));
  assert.deepEqual(create.headers.getSetCookie().sort(), ["ev_supabase_access=rotated-access; HttpOnly; Secure", "ev_supabase_refresh=rotated-refresh; HttpOnly; Secure"].sort());
  const created = createdResponse;
  assert.equal(created.project.name, "D1 staging project");
  assert.match(created.project.ownerId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(created.project.ownerId, userId);
  assert.equal(created.storage, "cloudflare-d1-staging");

  const list = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
    headers: { authorization: "Bearer staging-test-token" }
  }), env);
  assert.equal(list.status, 200);
  const projects = await list.json();
  assert.equal(projects.projects.length, 1);
  assert.equal(projects.projects[0].id, created.project.id);
  assert.deepEqual(projects.page, { limit: 50, offset: 0 });

  const secondCreate = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
    method: "POST", headers: { authorization: "Bearer staging-test-token", "content-type": "application/json" },
    body: JSON.stringify({ name: "Second bounded page project" })
  }), env);
  assert.equal(secondCreate.status, 201);
  const second = await worker.fetch(new Request("https://staging.example/api/d1/projects?limit=1&offset=1", {
    headers: { authorization: "Bearer staging-test-token" }
  }), env);
  assert.equal(second.status, 200);
  const secondPage = await second.json();
  assert.equal(secondPage.projects.length, 1);
  assert.equal(secondPage.page.limit, 1);
  assert.equal(secondPage.page.offset, 1);

  const invalidPage = await worker.fetch(new Request("https://staging.example/api/d1/projects?limit=1000", {
    headers: { authorization: "Bearer staging-test-token" }
  }), env);
  assert.equal(invalidPage.status, 400);
  DB.close();
});

test("D1 Worker never writes an identity when the upstream session is unauthenticated", async t => {
  const DB = makeD1();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED" } }), { status: 401 }));
  const response = await worker.fetch(new Request("https://staging.example/api/d1/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "No identity" }) }), { DB, API_ORIGIN: "https://executive-visuals.onrender.com" });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
  assert.equal(DB.countUsers(), 0);
  DB.close();
});

test("D1 Worker treats identity redirects as unauthenticated without following them", async t => {
  const DB = makeD1();
  let followed = false;
  t.mock.method(globalThis, "fetch", async request => {
    assert.equal(new URL(request.url).pathname, "/api/me");
    assert.equal(request.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://executive-visuals.onrender.com/login" } });
  });
  const response = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "No identity" })
  }), { DB, API_ORIGIN: "https://executive-visuals.onrender.com" });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
  assert.equal(DB.countUsers(), 0);
  assert.equal(followed, false);
  DB.close();
});

test("D1 Worker health reports staging binding without exposing data", async () => {
  const DB = makeD1();
  const response = await worker.fetch(new Request("https://staging.example/api/d1/health"), { DB });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready", database: "executive-visuals-staging", metadataOnly: true, r2Enabled: false });
  DB.close();
});


test("D1 staging CORS allows only the configured app origin and bearer headers", async () => {
  const env = { APP_ORIGIN: "https://executive-visuals.onrender.com" };
  const allowed = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
    method: "OPTIONS",
    headers: { origin: env.APP_ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "authorization" }
  }), env);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), env.APP_ORIGIN);
  assert.match(allowed.headers.get("access-control-allow-headers"), /authorization/i);
  assert.equal(allowed.headers.get("access-control-allow-credentials"), null);

  const denied = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
    method: "OPTIONS",
    headers: { origin: "https://attacker.example", "access-control-request-method": "GET" }
  }), env);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("staging Worker blocks production business APIs instead of proxying them", async t => {
  let upstreamCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { upstreamCalls++; return new Response("unexpected"); });
  const response = await worker.fetch(new Request("https://staging.example/api/projects"), { API_ORIGIN: "https://executive-visuals.onrender.com" });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "STAGING_ROUTE_NOT_FOUND");
  assert.equal(upstreamCalls, 0);
});

test("staging Worker proxies only login/logout authentication routes", async t => {
  t.mock.method(globalThis, "fetch", async request => {
    assert.equal(new URL(request.url).pathname, "/api/auth/login");
    assert.equal(request.method, "POST");
    return new Response(JSON.stringify({ user: { id: userId }, authMode: "supabase" }), { status: 200, headers: { "content-type": "application/json", "set-cookie": "ev_supabase_access=test; HttpOnly; Secure" } });
  });
  const response = await worker.fetch(new Request("https://staging.example/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "editor@example.test", password: "not-a-real-password" })
  }), { API_ORIGIN: "https://executive-visuals.onrender.com" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /ev_supabase_access=test/);
});

test("D1 Worker exposes authenticated revisioned workspace documents", async t => {
  const DB = makeD1();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    user: { id: userId, email: "editor@example.test" }, authMode: "supabase"
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const env = { DB, API_ORIGIN: "https://executive-visuals.onrender.com" };
  const createdResponse = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
    method: "POST", headers: { authorization: "Bearer staging-test-token", "content-type": "application/json" },
    body: JSON.stringify({ name: "Workspace-backed project" })
  }), env);
  assert.equal(createdResponse.status, 201);
  const { project } = await createdResponse.json();
  const read = await worker.fetch(new Request(`https://staging.example/api/d1/projects/${project.id}/workspace`, {
    headers: { authorization: "Bearer staging-test-token" }
  }), env);
  assert.equal(read.status, 200);
  const initial = await read.json();
  assert.equal(initial.revision, 1);
  assert.deepEqual(initial.document, {});
  const update = await worker.fetch(new Request(`https://staging.example/api/d1/projects/${project.id}/workspace`, {
    method: "PUT",
    headers: { authorization: "Bearer staging-test-token", "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1, document: { brief: "Persisted in D1", frameRate: 24 } })
  }), env);
  assert.equal(update.status, 200);
  const saved = await update.json();
  assert.equal(saved.revision, 2);
  assert.equal(saved.document.brief, "Persisted in D1");
  DB.close();
});



test("D1 daily quota exhaustion is reported as temporary unavailability, not a missing migration", async () => {
  const DB = {
    prepare() {
      return { bind() { return { async first() { throw new Error("Your account has exceeded D1's free tier daily row read limit."); } }; } };
    }
  };
  const response = await worker.fetch(new Request("https://staging.example/api/d1/health"), { DB });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error.code, "D1_UNAVAILABLE");
  assert.notEqual(payload.error.code, "D1_MIGRATION_REQUIRED");
});

test("D1 daily read/write quota errors are surfaced as bounded 503 responses", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    user: { id: userId, email: "editor@example.test" }, authMode: "supabase"
  }), { status: 200, headers: { "content-type": "application/json" } }));
  for (const quota of ["row read", "row write"]) {
    const DB = makeD1();
    const originalPrepare = DB.prepare.bind(DB);
    DB.prepare = sql => {
      if (sql.includes("sqlite_master")) return originalPrepare(sql);
      throw new Error(`Your account has exceeded D1's free tier daily ${quota} limit.`);
    };
    const response = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
      headers: { authorization: "Bearer staging-test-token" }
    }), { DB, API_ORIGIN: "https://executive-visuals.onrender.com" });
    assert.equal(response.status, 503, quota);
    const payload = await response.json();
    assert.equal(payload.error.code, "D1_QUOTA_EXCEEDED", quota);
    assert.match(payload.error.message, /UTC daily reset/);
    DB.close();
  }
});
