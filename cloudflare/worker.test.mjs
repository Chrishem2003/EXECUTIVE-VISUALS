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
    return new Response(JSON.stringify({ user: { id: userId, email: "editor@example.test" }, authMode: "supabase" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const env = { DB, API_ORIGIN: "https://executive-visuals.onrender.com" };
  const create = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
    method: "POST",
    headers: { authorization: "Bearer staging-test-token", "content-type": "application/json" },
    body: JSON.stringify({ name: "D1 staging project", settings: { fps: 24 } })
  }), env);
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(created.project.name, "D1 staging project");
  assert.equal(created.project.ownerId, userId);
  assert.equal(created.storage, "cloudflare-d1-staging");

  const list = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
    headers: { authorization: "Bearer staging-test-token" }
  }), env);
  assert.equal(list.status, 200);
  const projects = await list.json();
  assert.equal(projects.projects.length, 1);
  assert.equal(projects.projects[0].id, created.project.id);
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

test("D1 Worker health reports staging binding without exposing data", async () => {
  const DB = makeD1();
  const response = await worker.fetch(new Request("https://staging.example/api/d1/health"), { DB });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready", database: "executive-visuals-staging", metadataOnly: true, r2Enabled: false });
  DB.close();
});
