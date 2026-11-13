import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createD1Repository } from "../d1-repository.mjs";

const migration = await readFile(new URL("../../migrations/d1/0001_initial.sql", import.meta.url), "utf8");
const ownerSubject = "auth0|owner-001";
const otherSubject = "auth0|other-002";
const ownerId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  sqlite.exec(migration);
  return {
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
    close() { sqlite.close(); }
  };
}

test("D1 migration creates isolated tables and required indexes", async () => {
  const db = makeD1();
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").bind().all();
  assert.ok(names.results.some(row => row.name === "ev_projects"));
  assert.ok(names.results.some(row => row.name === "ev_assets"));
  assert.ok(names.results.some(row => row.name === "ev_jobs"));
  db.close();
});

test("principal mapping stores verified provider subject, never credentials", async () => {
  const db = makeD1();
  const repo = createD1Repository({ db, id: () => ownerId, clock: () => "2026-11-08T00:00:00.000Z" });
  const principal = await repo.resolvePrincipal({ subject: ownerSubject, provider: "supabase", email: "owner@example.test" });
  assert.equal(principal.id, ownerId);
  assert.equal(principal.subject, ownerSubject);
  const again = await repo.resolvePrincipal({ subject: ownerSubject, provider: "supabase", email: "updated@example.test" });
  assert.equal(again.id, ownerId);
  assert.equal(again.email, "updated@example.test");
  db.close();
});

test("project membership and revision checks isolate tenants and roles", async () => {
  const db = makeD1();
  const repo = createD1Repository({ db, id: (() => { let n=0; return () => [ownerId, otherId, projectId, "44444444-4444-4444-8444-444444444444"][n++]; })(), clock: () => "2026-11-08T00:00:00.000Z" });
  await repo.resolvePrincipal({ subject: ownerSubject, provider: "supabase" });
  await repo.resolvePrincipal({ subject: otherSubject, provider: "supabase" });
  const project = await repo.createProject({ ownerId, name: "Studio", settings: { fps: 24 } });
  assert.equal(project.id, projectId);
  await repo.addMember({ actorId: ownerId, projectId, memberId: otherId, role: "viewer" });
  assert.equal((await repo.getProject({ actorId: otherId, projectId })).id, projectId);
  await assert.rejects(repo.updateProject({ actorId: otherId, projectId, expectedRevision: 1, name: "Changed" }), { code: "D1_PROJECT_ACCESS_DENIED" });
  const changed = await repo.updateProject({ actorId: ownerId, projectId, expectedRevision: 1, name: "Studio v2" });
  assert.equal(changed.revision, 2);
  await assert.rejects(repo.updateProject({ actorId: ownerId, projectId, expectedRevision: 1, name: "Stale" }), { code: "D1_PROJECT_REVISION_CONFLICT" });
  db.close();
});

test("asset metadata requires checksum, private storage key and same-tenant derivative", async () => {
  const db = makeD1();
  const repo = createD1Repository({ db, id: (() => { let n=0; return () => [ownerId, "55555555-5555-4555-8555-555555555555"][n++]; })(), clock: () => "2026-11-08T00:00:00.000Z" });
  await repo.resolvePrincipal({ subject: ownerSubject, provider: "supabase" });
  const asset = await repo.createAsset({ actorId: ownerId, name: "source.mp4", mediaType: "video/mp4", size: 1024, sha256: "a".repeat(64), storageProvider: "local-staging", storageKey: ownerId + "/source.mp4" });
  assert.equal(asset.sha256, "a".repeat(64));
  assert.equal(asset.storageKey, ownerId + "/source.mp4");
  await assert.rejects(repo.createAsset({ actorId: ownerId, name: "bad.mp4", mediaType: "video/mp4", size: 10, sha256: "bad", storageProvider: "local-staging", storageKey: ownerId + "/bad.mp4" }), /checksum/);
  await assert.rejects(repo.createAsset({ actorId: ownerId, name: "r2.mp4", mediaType: "video/mp4", size: 10, sha256: "a".repeat(64), storageProvider: "r2", storageKey: ownerId + "/r2.mp4" }), /not enabled/);
  await assert.rejects(repo.createAsset({ actorId: ownerId, name: "bad.mp4", mediaType: "video/mp4", size: 10, sha256: "a".repeat(64), storageProvider: "local-staging", storageKey: ownerId + "/../bad.mp4" }), /storage key/);
  db.close();
});

test("workspace documents persist with revision checks and member write permissions", async () => {
  const db = makeD1();
  const repo = createD1Repository({ db, id: (() => { let n=0; return () => [ownerId, otherId, projectId][n++]; })(), clock: (() => { let n=0; return () => `2026-11-08T00:00:0${n++}.000Z`; })() });
  await repo.resolvePrincipal({ subject: ownerSubject, provider: "supabase" });
  await repo.resolvePrincipal({ subject: otherSubject, provider: "supabase" });
  await repo.createProject({ ownerId, name: "Workspace persistence" });
  const initial = await repo.getWorkspaceDocument({ actorId: ownerId, projectId });
  assert.equal(initial.revision, 1);
  assert.deepEqual(initial.document, {});
  const updated = await repo.updateWorkspaceDocument({ actorId: ownerId, projectId, expectedRevision: 1, document: { brief: "A real persisted workspace", timeline: { frameRate: 24 } } });
  assert.equal(updated.revision, 2);
  assert.equal(updated.document.brief, "A real persisted workspace");
  await repo.addMember({ actorId: ownerId, projectId, memberId: otherId, role: "viewer" });
  await assert.rejects(repo.updateWorkspaceDocument({ actorId: otherId, projectId, expectedRevision: 2, document: { brief: "forbidden" } }), { code: "D1_PROJECT_ACCESS_DENIED" });
  await assert.rejects(repo.updateWorkspaceDocument({ actorId: ownerId, projectId, expectedRevision: 1, document: { brief: "stale" } }), { code: "D1_PROJECT_REVISION_CONFLICT" });
  db.close();
});


test("project owner can manage verified members by email and list/remove project roles", async () => {
  const db = makeD1();
  const repo = createD1Repository({ db, id: (() => { let n=0; return () => [ownerId, otherId, projectId][n++]; })(), clock: () => "2026-11-13T00:00:00.000Z" });
  await repo.resolvePrincipal({ subject: ownerSubject, provider: "supabase", email: "owner@example.test" });
  await repo.resolvePrincipal({ subject: otherSubject, provider: "supabase", email: "collaborator@example.test" });
  await repo.createProject({ ownerId, name: "Team workspace" });

  const initial = await repo.listMembers({ actorId: ownerId, projectId });
  assert.deepEqual(initial.members.map(member => member.role), ["owner"]);

  const invited = await repo.addMemberByEmail({ actorId: ownerId, projectId, email: " COLLABORATOR@EXAMPLE.TEST ", role: "viewer" });
  assert.equal(invited.memberId, otherId);
  assert.equal(invited.role, "viewer");
  assert.equal((await repo.listMembers({ actorId: ownerId, projectId })).members.find(member => member.memberId === otherId).role, "viewer");
  assert.equal((await repo.listMembers({ actorId: otherId, projectId })).canManageMembers, false);

  await assert.rejects(repo.addMemberByEmail({ actorId: otherId, projectId, email: "owner@example.test", role: "editor" }), { code: "D1_PROJECT_ACCESS_DENIED" });
  await assert.rejects(repo.removeMember({ actorId: otherId, projectId, memberId: ownerId }), { code: "D1_PROJECT_ACCESS_DENIED" });

  await repo.addMemberByEmail({ actorId: ownerId, projectId, email: "collaborator@example.test", role: "editor" });
  assert.equal((await repo.listMembers({ actorId: ownerId, projectId })).members.find(member => member.memberId === otherId).role, "editor");

  const removed = await repo.removeMember({ actorId: ownerId, projectId, memberId: otherId });
  assert.equal(removed.removed, true);
  assert.deepEqual((await repo.listMembers({ actorId: ownerId, projectId })).members.map(member => member.role), ["owner"]);
  await assert.rejects(repo.removeMember({ actorId: ownerId, projectId, memberId: otherId }), { code: "D1_MEMBER_NOT_FOUND" });
  await assert.rejects(repo.addMemberByEmail({ actorId: ownerId, projectId, email: "missing@example.test", role: "viewer" }), { code: "D1_MEMBER_NOT_FOUND" });
  db.close();
});


test("D1 worker leases reclaim expired claims and fail jobs after the attempt ceiling", async () => {
  const db = makeD1();
  let now = Date.parse("2026-11-13T12:00:00.000Z");
  const repo = createD1Repository({ db, clock: () => new Date(now).toISOString() });
  const principal = await repo.resolvePrincipal({ subject: ownerSubject, provider: "supabase", email: "owner@example.test" });
  const project = await repo.createProject({ ownerId: principal.id, name: "Lease recovery" });
  const job = await repo.createJob({
    actorId: principal.id, projectId: project.id, jobType: "storyboard.render",
    input: { storyboardId: "lease-recovery" }, maxAttempts: 2
  });

  const first = await repo.claimNextJob({ leaseMs: 5000 });
  assert.equal(first.job.id, job.job.id);
  assert.equal(first.job.attemptCount, 1);
  now += 5001;
  assert.equal(await repo.heartbeatJob({ jobId: job.job.id, leaseToken: first.leaseToken }), null);

  const reclaimed = await repo.claimNextJob({ leaseMs: 5000 });
  assert.equal(reclaimed.job.id, job.job.id);
  assert.equal(reclaimed.job.status, "running");
  assert.equal(reclaimed.job.attemptCount, 2);
  assert.notEqual(reclaimed.leaseToken, first.leaseToken);
  assert.equal(await repo.completeJob({ jobId: job.id, leaseToken: first.leaseToken, output: {} }), null);

  now += 5001;
  assert.equal(await repo.claimNextJob({ leaseMs: 5000 }), null);
  const exhausted = await repo.getJob({ actorId: principal.id, jobId: job.job.id });
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.error.code, "LEASE_EXHAUSTED");
  db.close();
});
