import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "./worker.mjs";
import { createD1Repository } from "../server/d1-repository.mjs";

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
  assert.match(allowed.headers.get("access-control-allow-methods"), /DELETE/i);
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




test("D1 Worker exposes owner-managed member listing, email add/update, role enforcement and removal", async t => {
  const DB = makeD1();
  const memberUserId = "22222222-2222-4222-8222-222222222222";
  const identities = {
    "Bearer owner-token": { id: userId, email: "owner@example.test" },
    "Bearer member-token": { id: memberUserId, email: "member@example.test" }
  };
  t.mock.method(globalThis, "fetch", async request => {
    const user = identities[request.headers.get("authorization")];
    if (!user) return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
    return new Response(JSON.stringify({ user, authMode: "supabase" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const env = { DB, API_ORIGIN: "https://executive-visuals.onrender.com" };
  const ownerHeaders = { authorization: "Bearer owner-token", "content-type": "application/json" };
  const memberHeaders = { authorization: "Bearer member-token", "content-type": "application/json" };

  const create = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
    method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Collaborative staging project" })
  }), env);
  assert.equal(create.status, 201);
  const { project } = await create.json();

  const resolveMember = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
    headers: memberHeaders
  }), env);
  assert.equal(resolveMember.status, 200);

  const membersUrl = `https://staging.example/api/d1/projects/${project.id}/members`;
  const addViewer = await worker.fetch(new Request(membersUrl, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ email: " MEMBER@EXAMPLE.TEST ", role: "viewer" })
  }), env);
  assert.equal(addViewer.status, 201, await addViewer.clone().text());
  const addedMember = (await addViewer.json()).member;
  assert.equal(addedMember.role, "viewer");
  const memberPrincipalId = addedMember.memberId;

  const list = await worker.fetch(new Request(membersUrl, { headers: ownerHeaders }), env);
  assert.equal(list.status, 200);
  const memberList = await list.json();
  assert.deepEqual(memberList.members.map(member => member.role), ["owner", "viewer"]);
  assert.equal(memberList.canManageMembers, true);

  const forbiddenInvite = await worker.fetch(new Request(membersUrl, {
    method: "POST", headers: memberHeaders,
    body: JSON.stringify({ email: "owner@example.test", role: "editor" })
  }), env);
  assert.equal(forbiddenInvite.status, 403);
  assert.equal((await forbiddenInvite.json()).error.code, "D1_PROJECT_ACCESS_DENIED");

  const workspaceUrl = `https://staging.example/api/d1/projects/${project.id}/workspace`;
  const viewerWrite = await worker.fetch(new Request(workspaceUrl, {
    method: "PUT", headers: memberHeaders,
    body: JSON.stringify({ expectedRevision: 1, document: { forbidden: true } })
  }), env);
  assert.equal(viewerWrite.status, 403);
  assert.equal((await viewerWrite.json()).error.code, "D1_PROJECT_ACCESS_DENIED");

  const invalidRole = await worker.fetch(new Request(membersUrl, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ email: "member@example.test", role: "owner" })
  }), env);
  assert.equal(invalidRole.status, 400, await invalidRole.clone().text());

  const promoteReviewer = await worker.fetch(new Request(membersUrl, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ email: "member@example.test", role: "reviewer" })
  }), env);
  assert.equal(promoteReviewer.status, 201);
  assert.equal((await promoteReviewer.json()).member.role, "reviewer");

  const reviewerList = await worker.fetch(new Request(membersUrl, { headers: ownerHeaders }), env);
  assert.equal(reviewerList.status, 200);
  assert.deepEqual((await reviewerList.json()).members.map(member => member.role), ["owner", "reviewer"]);

  const reviewerWrite = await worker.fetch(new Request(workspaceUrl, {
    method: "PUT", headers: memberHeaders,
    body: JSON.stringify({ expectedRevision: 1, document: { forbidden: "reviewer is read-only" } })
  }), env);
  assert.equal(reviewerWrite.status, 403);
  assert.equal((await reviewerWrite.json()).error.code, "D1_PROJECT_ACCESS_DENIED");

  const promote = await worker.fetch(new Request(membersUrl, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ email: "member@example.test", role: "editor" })
  }), env);
  assert.equal(promote.status, 201);
  assert.equal((await promote.json()).member.role, "editor");

  const editorWrite = await worker.fetch(new Request(workspaceUrl, {
    method: "PUT", headers: memberHeaders,
    body: JSON.stringify({ expectedRevision: 1, document: { authorized: true } })
  }), env);
  assert.equal(editorWrite.status, 200);
  assert.equal((await editorWrite.json()).revision, 2);

  const remove = await worker.fetch(new Request(membersUrl + "/" + memberPrincipalId, {
    method: "DELETE", headers: ownerHeaders
  }), env);
  assert.equal(remove.status, 200);
  assert.equal((await remove.json()).removed, true);

  const afterRemoval = await worker.fetch(new Request(`https://staging.example/api/d1/projects/${project.id}`, {
    headers: memberHeaders
  }), env);
  assert.equal(afterRemoval.status, 404);
  assert.equal((await afterRemoval.json()).error.code, "D1_PROJECT_NOT_FOUND");
  DB.close();
});

test("D1 asset metadata reads are owner-scoped and never expose private storage keys", async t => {
  const DB = makeD1();
  const userA = "11111111-1111-4111-8111-111111111111";
  const userB = "22222222-2222-4222-8222-222222222222";
  t.mock.method(globalThis, "fetch", async request => {
    const userId = request.headers.get("authorization") === "Bearer user-b" ? userB : userA;
    return new Response(JSON.stringify({
      user: { id: userId, email: userId === userA ? "owner@example.test" : "other@example.test" },
      authMode: "supabase"
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const env = { DB, API_ORIGIN: "https://executive-visuals.onrender.com" };
  const create = await worker.fetch(new Request("https://staging.example/api/d1/projects", {
    method: "POST",
    headers: { authorization: "Bearer user-a", "content-type": "application/json" },
    body: JSON.stringify({ name: "Private media project" })
  }), env);
  assert.equal(create.status, 201);
  const { project } = await create.json();
  const repo = createD1Repository({ db: DB });
  const asset = await repo.createAsset({
    actorId: project.ownerId,
    projectId: project.id,
    name: "source.mp4",
    mediaType: "video/mp4",
    size: 1024,
    sha256: "a".repeat(64),
    storageProvider: "local-staging",
    storageKey: "staging/private/source.mp4",
    metadata: { width: 1920, height: 1080 }
  });

  const ownerRead = await worker.fetch(new Request(
    `https://staging.example/api/d1/assets?projectId=${project.id}`,
    { headers: { authorization: "Bearer user-a" } }
  ), env);
  assert.equal(ownerRead.status, 200);
  const ownerPayload = await ownerRead.json();
  assert.equal(ownerPayload.metadataOnly, true);
  assert.equal(ownerPayload.assets.length, 1);
  assert.equal(ownerPayload.assets[0].id, asset.id);
  assert.equal(ownerPayload.assets[0].name, "source.mp4");
  assert.equal(ownerPayload.assets[0].sha256, "a".repeat(64));
  assert.deepEqual(ownerPayload.assets[0].metadata, { width: 1920, height: 1080 });
  assert.equal(Object.hasOwn(ownerPayload.assets[0], "storageKey"), false);
  assert.equal(Object.hasOwn(ownerPayload.assets[0], "ownerId"), false);

  const otherRead = await worker.fetch(new Request(
    `https://staging.example/api/d1/assets?projectId=${project.id}`,
    { headers: { authorization: "Bearer user-b" } }
  ), env);
  assert.equal(otherRead.status, 200);
  assert.deepEqual((await otherRead.json()).assets, []);
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


test("D1 staging enforces the complete owner/editor/reviewer/viewer capability matrix", async t => {
  const DB = makeD1();
  const identities = {
    "Bearer owner": { id: "11111111-1111-4111-8111-111111111111", email: "owner@roles.test" },
    "Bearer editor": { id: "22222222-2222-4222-8222-222222222222", email: "editor@roles.test" },
    "Bearer reviewer": { id: "33333333-3333-4333-8333-333333333333", email: "reviewer@roles.test" },
    "Bearer viewer": { id: "44444444-4444-4444-8444-444444444444", email: "viewer@roles.test" },
    "Bearer outsider": { id: "55555555-5555-4555-8555-555555555555", email: "outsider@roles.test" }
  };
  t.mock.method(globalThis, "fetch", async request => {
    const user = identities[request.headers.get("authorization")];
    if (!user) return new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED" } }), { status: 401 });
    return new Response(JSON.stringify({ user, authMode: "supabase" }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  });
  const env = { DB, API_ORIGIN: "https://executive-visuals.onrender.com" };
  const request = (path, token, method = "GET", body) => worker.fetch(new Request(
    "https://staging.example" + path,
    { method, headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }
  ), env);
  const created = await request("/api/d1/projects", "owner", "POST", { name: "Role matrix project" });
  assert.equal(created.status, 201);
  const { project } = await created.json();
  const membersPath = "/api/d1/projects/" + project.id + "/members";
  const projectPath = "/api/d1/projects/" + project.id;
  const workspacePath = projectPath + "/workspace";

  for (const role of ["editor", "reviewer", "viewer", "outsider"]) {
    const authenticated = await request("/api/d1/projects", role);
    assert.equal(authenticated.status, 200, role + " identity is registered before membership assignment");
  }

  const memberIds = {};
  for (const [role, email] of [["editor", "editor@roles.test"], ["reviewer", "reviewer@roles.test"], ["viewer", "viewer@roles.test"]]) {
    const added = await request(membersPath, "owner", "POST", { email, role });
    assert.equal(added.status, 201, role);
    memberIds[role] = (await added.json()).member.memberId;
  }

  const ownerList = await request(membersPath, "owner");
  assert.equal(ownerList.status, 200);
  assert.equal((await ownerList.json()).canManageMembers, true);

  for (const role of ["editor", "reviewer", "viewer"]) {
    const list = await request(membersPath, role);
    assert.equal(list.status, 200, role);
    assert.equal((await list.json()).canManageMembers, false, role);
    const projectRead = await request(projectPath, role);
    assert.equal(projectRead.status, 200, role + " can read project");
    const workspaceRead = await request(workspacePath, role);
    assert.equal(workspaceRead.status, 200, role + " can read workspace");
  }

  const outsiderProject = await request(projectPath, "outsider");
  assert.equal(outsiderProject.status, 404);
  assert.equal((await outsiderProject.json()).error.code, "D1_PROJECT_NOT_FOUND");
  const outsiderWorkspace = await request(workspacePath, "outsider");
  assert.equal(outsiderWorkspace.status, 404);
  assert.equal((await outsiderWorkspace.json()).error.code, "D1_PROJECT_NOT_FOUND");

  const ownerPatch = await request(projectPath, "owner", "PATCH", { expectedRevision: 1, name: "Owner edit" });
  assert.equal(ownerPatch.status, 200);
  assert.equal((await ownerPatch.json()).project.revision, 2);
  const editorPatch = await request(projectPath, "editor", "PATCH", { expectedRevision: 2, description: "Editor edit" });
  assert.equal(editorPatch.status, 200);
  assert.equal((await editorPatch.json()).project.revision, 3);

  for (const role of ["reviewer", "viewer"]) {
    const denied = await request(projectPath, role, "PATCH", { expectedRevision: 3, name: "Unauthorized " + role });
    assert.equal(denied.status, 403, role + " cannot edit project settings");
    assert.equal((await denied.json()).error.code, "D1_PROJECT_ACCESS_DENIED");
  }

  const ownerWorkspaceWrite = await request(workspacePath, "owner", "PUT", { expectedRevision: 1, document: { owner: true } });
  assert.equal(ownerWorkspaceWrite.status, 200);
  const editorWorkspaceWrite = await request(workspacePath, "editor", "PUT", { expectedRevision: 2, document: { editor: true } });
  assert.equal(editorWorkspaceWrite.status, 200);
  assert.equal((await editorWorkspaceWrite.json()).revision, 3);

  for (const role of ["reviewer", "viewer"]) {
    const denied = await request(workspacePath, role, "PUT", { expectedRevision: 3, document: { forbidden: role } });
    assert.equal(denied.status, 403, role + " cannot edit workspace");
    assert.equal((await denied.json()).error.code, "D1_PROJECT_ACCESS_DENIED");
  }

  const editorInvite = await request(membersPath, "editor", "POST", { email: "outsider@roles.test", role: "viewer" });
  assert.equal(editorInvite.status, 403);
  const reviewerRemove = await request(membersPath + "/" + memberIds.viewer, "reviewer", "DELETE");
  assert.equal(reviewerRemove.status, 403);
  const viewerRemove = await request(membersPath + "/" + memberIds.editor, "viewer", "DELETE");
  assert.equal(viewerRemove.status, 403);

  const ownerRemove = await request(membersPath + "/" + memberIds.viewer, "owner", "DELETE");
  assert.equal(ownerRemove.status, 200);
  assert.equal((await ownerRemove.json()).removed, true);
  const revokedRead = await request(projectPath, "viewer");
  assert.equal(revokedRead.status, 404);
  DB.close();
});


test("D1 staging job and audit APIs enforce project roles, idempotency and tenant isolation", async t => {
  const DB = makeD1();
  const identities = {
    "Bearer owner": { id: "11111111-1111-4111-8111-111111111111", email: "owner@jobs.test" },
    "Bearer editor": { id: "22222222-2222-4222-8222-222222222222", email: "editor@jobs.test" },
    "Bearer reviewer": { id: "33333333-3333-4333-8333-333333333333", email: "reviewer@jobs.test" },
    "Bearer outsider": { id: "44444444-4444-4444-8444-444444444444", email: "outsider@jobs.test" }
  };
  t.mock.method(globalThis, "fetch", async request => {
    const user = identities[request.headers.get("authorization")];
    if (!user) return new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED" } }), { status: 401 });
    return new Response(JSON.stringify({ user, authMode: "supabase" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const env = { DB, API_ORIGIN: "https://executive-visuals.onrender.com" };
  const call = (path, token, method = "GET", body) => worker.fetch(new Request("https://staging.example" + path, {
    method, headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  }), env);
  const createdProject = await call("/api/d1/projects", "owner", "POST", { name: "Job API project" });
  assert.equal(createdProject.status, 201);
  const project = (await createdProject.json()).project;
  const auditPath = "/api/d1/projects/" + project.id + "/audit-events";
  assert.equal((await call("/api/d1/projects", "editor")).status, 200);
  assert.equal((await call("/api/d1/projects", "reviewer")).status, 200);
  const memberPath = "/api/d1/projects/" + project.id + "/members";
  assert.equal((await call(memberPath, "owner", "POST", { email: "editor@jobs.test", role: "editor" })).status, 201);
  assert.equal((await call(memberPath, "owner", "POST", { email: "reviewer@jobs.test", role: "reviewer" })).status, 201);

  const createdJob = await call("/api/d1/jobs", "editor", "POST", {
    projectId: project.id, jobType: "storyboard.render", input: { storyboardId: "sb-1" }, idempotencyKey: "render-sb-1"
  });
  assert.equal(createdJob.status, 201);
  const jobResult = await createdJob.json();
  assert.equal(jobResult.job.status, "queued");
  assert.equal(jobResult.execution, "not-dispatched");
  const repeated = await call("/api/d1/jobs", "editor", "POST", {
    projectId: project.id, jobType: "storyboard.render", input: { storyboardId: "sb-1" }, idempotencyKey: "render-sb-1"
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).job.id, jobResult.job.id);
  const conflictingKey = await call("/api/d1/jobs", "editor", "POST", {
    projectId: project.id, jobType: "storyboard.render", input: { storyboardId: "different" }, idempotencyKey: "render-sb-1"
  });
  assert.equal(conflictingKey.status, 409);
  assert.equal((await conflictingKey.json()).error.code, "D1_IDEMPOTENCY_CONFLICT");

  const workerEnv = { ...env, D1_WORKER_TOKEN: "staging-worker-secret-0123456789abcdef" };
  const privateCall = (path, body, token = workerEnv.D1_WORKER_TOKEN) => worker.fetch(new Request("https://staging.example" + path, {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body)
  }), workerEnv);
  const noSecret = await worker.fetch(new Request("https://staging.example/api/d1/internal/jobs/claim", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env);
  assert.equal(noSecret.status, 503);
  const deniedClaim = await privateCall("/api/d1/internal/jobs/claim", {}, "wrong-worker-token");
  assert.equal(deniedClaim.status, 401);
  const claimResponse = await privateCall("/api/d1/internal/jobs/claim", { leaseMs: 30000 });
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json();
  assert.equal(claim.claimed, true);
  assert.equal(claim.job.id, jobId);
  assert.equal(claim.job.status, "running");
  assert.equal(claim.job.attemptCount, 1);
  assert.equal(typeof claim.leaseToken, "string");
  const heartbeat = await privateCall("/api/d1/internal/jobs/" + jobId + "/heartbeat", { leaseToken: claim.leaseToken, leaseMs: 45000 });
  assert.equal(heartbeat.status, 200);
  const staleHeartbeat = await privateCall("/api/d1/internal/jobs/" + jobId + "/heartbeat", { leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  assert.equal(staleHeartbeat.status, 409);
  const failedAttempt = await privateCall("/api/d1/internal/jobs/" + jobId + "/fail", { leaseToken: claim.leaseToken, error: { code: "TRANSIENT", message: "retry me" }, retryDelayMs: 0 });
  assert.equal(failedAttempt.status, 200);
  assert.equal((await failedAttempt.json()).job.status, "queued");
  const secondClaimResponse = await privateCall("/api/d1/internal/jobs/claim", {});
  const secondClaim = await secondClaimResponse.json();
  assert.equal(secondClaim.job.attemptCount, 2);
  const completed = await privateCall("/api/d1/internal/jobs/" + jobId + "/complete", { leaseToken: secondClaim.leaseToken, output: { artifactId: "artifact-1" } });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).job.status, "succeeded");
  const staleComplete = await privateCall("/api/d1/internal/jobs/" + jobId + "/complete", { leaseToken: secondClaim.leaseToken, output: {} });
  assert.equal(staleComplete.status, 409);
  const emptyClaim = await privateCall("/api/d1/internal/jobs/claim", {});
  assert.equal((await emptyClaim.json()).claimed, false);

  const reviewerJob = await call("/api/d1/jobs", "reviewer", "POST", { projectId: project.id, jobType: "blocked.write", input: {} });
  assert.equal(reviewerJob.status, 403);
  const outsiderJobList = await call("/api/d1/jobs?projectId=" + project.id, "outsider");
  assert.equal(outsiderJobList.status, 200);
  assert.equal((await outsiderJobList.json()).jobs.length, 0);
  const editorJobList = await call("/api/d1/jobs?projectId=" + project.id, "editor");
  assert.equal((await editorJobList.json()).jobs.length, 1);
  const jobId = jobResult.job.id;
  assert.equal((await call("/api/d1/jobs/" + jobId, "reviewer")).status, 200);
  assert.equal((await call("/api/d1/jobs/" + jobId, "outsider")).status, 404);
  assert.equal((await call("/api/d1/jobs/" + jobId, "owner")).status, 200);

  const audit = await call(auditPath, "editor", "POST", {
    eventType: "job.queued", subjectType: "job", subjectId: jobId, details: { requestId: "req-1" }
  });
  assert.equal(audit.status, 201);
  const auditEvent = (await audit.json()).event;
  assert.equal(auditEvent.eventType, "job.queued");
  assert.equal(auditEvent.ownerId, jobResult.job.ownerId);
  const auditList = await call(auditPath, "reviewer");
  assert.equal(auditList.status, 200);
  assert.equal((await auditList.json()).events.length, 1);
  const ownerAudit = await call(auditPath, "owner");
  assert.equal((await ownerAudit.json()).events.length, 1);
  const outsiderAudit = await call(auditPath, "outsider");
  assert.equal(outsiderAudit.status, 404);
  const reviewerAppend = await call(auditPath, "reviewer", "POST", {
    eventType: "forbidden", subjectType: "project", subjectId: project.id, details: {}
  });
  assert.equal(reviewerAppend.status, 403);
  const oversized = await call("/api/d1/jobs", "owner", "POST", { jobType: "x", input: { payload: "x".repeat(70 * 1024) } });
  assert.equal(oversized.status, 413);
  DB.close();
});
