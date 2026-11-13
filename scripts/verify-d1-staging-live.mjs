import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const endpoints = {
  stagingApp: "https://executive-visuals-1.onrender.com/api/health",
  stagingWorker: "https://executive-visuals-d1-staging.chrishem.workers.dev/edge-health",
  stagingD1: "https://executive-visuals-d1-staging.chrishem.workers.dev/api/d1/health",
  stagingUnauthenticatedProjects: "https://executive-visuals-1.onrender.com/api/d1/projects?limit=1",
  productionApp: "https://executive-visuals.onrender.com/api/health"
};

async function getJson(name, url, { expectedStatus = 200, retries = 5, cookie } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json", "cache-control": "no-cache", ...(cookie ? { cookie } : {}) },
        signal: AbortSignal.timeout(20_000)
      });
      const raw = await response.text();
      let body;
      try { body = JSON.parse(raw); }
      catch { throw new Error(`${name} returned non-JSON (HTTP ${response.status}).`); }
      if (response.status === expectedStatus) return { status: response.status, body };
      if (response.status >= 500 && attempt < retries) {
        lastError = new Error(`${name} returned HTTP ${response.status}.`);
      } else {
        throw new Error(`${name} expected HTTP ${expectedStatus}, received ${response.status}: ${JSON.stringify(body)}`);
      }
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(2_000 * attempt, 8_000)));
  }
  throw lastError || new Error(`${name} could not be reached.`);
}

const runLabel = process.env.GITHUB_RUN_ID || String(Date.now());
const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "1";

const staging = await getJson("Staging application health", endpoints.stagingApp);
assert.equal(staging.body.status, "ok");
assert.equal(staging.body.staging?.d1WorkspaceEnabled, true);
assert.equal(staging.body.staging?.localAuthEnabled, true);

const worker = await getJson("Staging Worker health", endpoints.stagingWorker);
assert.deepEqual(worker.body, {
  status: "ok",
  edge: "cloudflare-workers",
  d1Bound: true,
  apiProxyConfigured: true,
  stagingOnly: true
});

const d1 = await getJson("D1 schema health", endpoints.stagingD1);
assert.equal(d1.body.status, "ready");
assert.equal(d1.body.database, "executive-visuals-staging");
assert.equal(d1.body.metadataOnly, true);
assert.equal(d1.body.r2Enabled, false);

const unauthenticated = await getJson("Unauthenticated D1 project access", endpoints.stagingUnauthenticatedProjects, { expectedStatus: 401 });
assert.equal(unauthenticated.body.error?.code, "AUTH_REQUIRED");

const production = await getJson("Production application health", endpoints.productionApp);
assert.equal(production.body.status, "ok");
assert.equal(production.body.staging?.d1WorkspaceEnabled, false);
assert.equal(production.body.authMode, "supabase");

console.log("PASS: isolated staging app, Worker, D1 schema and unauthenticated-access gates are healthy.");
console.log("PASS: production remains on Supabase authentication with the D1 staging bridge disabled.");

const stagingOrigin = "https://executive-visuals-1.onrender.com";
const smokeEmail = `ev-ci+${runLabel}-${runAttempt}@ev-staging.test`;
const smokePassword = randomBytes(24).toString("base64url");
const mutationHeaders = {
  "content-type": "application/json",
  origin: stagingOrigin,
  "sec-fetch-site": "same-origin",
  accept: "application/json"
};

async function postJson(name, url, { body, cookie, expectedStatus }) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...mutationHeaders, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); }
  catch { throw new Error(`${name} returned non-JSON (HTTP ${response.status}).`); }
  if (response.status !== expectedStatus) {
    throw new Error(`${name} expected HTTP ${expectedStatus}, received ${response.status}: ${JSON.stringify(payload)}`);
  }
  const cookies = response.headers.getSetCookie?.() || [response.headers.get("set-cookie")].filter(Boolean);
  return { payload, cookie: cookies.map(value => value.split(";")[0]).join("; ") };
}

let sessionCookie = "";
const registration = await postJson("Staging smoke registration", stagingOrigin + "/api/auth/register", {
  body: { email: smokeEmail, password: smokePassword },
  expectedStatus: 201
});
sessionCookie = registration.cookie;
assert.ok(sessionCookie, "Staging auth must issue a session cookie.");

const identityResponse = await fetch(stagingOrigin + "/api/me", {
  headers: { cookie: sessionCookie, accept: "application/json" },
  signal: AbortSignal.timeout(20_000)
});
assert.equal(identityResponse.status, 200, "Staging session must authenticate through /api/me.");
const identity = await identityResponse.json();
assert.equal(identity.user?.email, smokeEmail);
assert.equal(identity.authMode, "local");

const projectResponse = await postJson("Authenticated D1 project creation", stagingOrigin + "/api/d1/projects", {
  body: { name: `CI D1 round-trip ${runLabel}`, description: "Automated isolated staging acceptance project", settings: { source: "github-actions", runId: runLabel } },
  cookie: sessionCookie,
  expectedStatus: 201
});
const project = projectResponse.payload.project;
assert.match(project?.id || "", /^[0-9a-f-]{36}$/i);
assert.equal(projectResponse.payload.storage, "cloudflare-d1-staging");

const projectList = await getJson("Authenticated D1 project list", stagingOrigin + "/api/d1/projects?limit=50", { expectedStatus: 200, cookie: sessionCookie });
assert.ok(projectList.body.projects?.some(item => item.id === project.id), "New project must be visible to its authenticated owner.");

const workspaceUrl = stagingOrigin + "/api/d1/projects/" + encodeURIComponent(project.id) + "/workspace";
const initialWorkspaceResponse = await fetch(workspaceUrl, { headers: { cookie: sessionCookie, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
assert.equal(initialWorkspaceResponse.status, 200);
const initialWorkspace = await initialWorkspaceResponse.json();
assert.equal(initialWorkspace.revision, 1);

const document = { acceptance: "authenticated D1 round-trip", runId: runLabel, savedAt: new Date().toISOString(), timeline: { frameRate: 24, tracks: [] } };
const saveResponse = await fetch(workspaceUrl, {
  method: "PUT",
  headers: { ...mutationHeaders, cookie: sessionCookie },
  body: JSON.stringify({ expectedRevision: initialWorkspace.revision, document }),
  signal: AbortSignal.timeout(20_000)
});
assert.equal(saveResponse.status, 200, await saveResponse.clone().text());
const saved = await saveResponse.json();
assert.equal(saved.revision, initialWorkspace.revision + 1);

const reloadResponse = await fetch(workspaceUrl, { headers: { cookie: sessionCookie, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
assert.equal(reloadResponse.status, 200);
const reloaded = await reloadResponse.json();
assert.equal(reloaded.revision, saved.revision);
assert.deepEqual(reloaded.document, document);

const anonymousRead = await fetch(stagingOrigin + "/api/d1/projects/" + encodeURIComponent(project.id), { headers: { accept: "application/json" } });
assert.equal(anonymousRead.status, 401, "Anonymous access to a created project must remain denied.");

console.log("PASS: allowlisted staging registration/login and /api/me session verification succeeded.");
console.log("PASS: authenticated D1 project create/list and revisioned workspace save/reload succeeded.");
console.log("PASS: anonymous project access remains rejected.");

const isolationEmail = `ev-ci+${runLabel}-${runAttempt}-member@ev-staging.test`;
const isolationPassword = randomBytes(24).toString("base64url");
const isolationAuth = await postJson("Second staging identity registration", stagingOrigin + "/api/auth/register", {
  body: { email: isolationEmail, password: isolationPassword },
  expectedStatus: 201
});
assert.ok(isolationAuth.cookie, "Second staging identity must receive an independent session cookie.");

const secondIdentityResponse = await fetch(stagingOrigin + "/api/me", {
  headers: { cookie: isolationAuth.cookie, accept: "application/json" },
  signal: AbortSignal.timeout(20_000)
});
assert.equal(secondIdentityResponse.status, 200);
assert.equal((await secondIdentityResponse.json()).user?.email, isolationEmail);

const secondUserProjects = await getJson("Second account project list", stagingOrigin + "/api/d1/projects?limit=50", {
  expectedStatus: 200,
  cookie: isolationAuth.cookie
});
assert.equal(secondUserProjects.body.projects?.some(item => item.id === project.id), false,
  "A second account must not see the first account's project.");

const foreignProject = await getJson("Cross-account project read", stagingOrigin + "/api/d1/projects/" + encodeURIComponent(project.id), {
  expectedStatus: 404,
  cookie: isolationAuth.cookie
});
assert.equal(foreignProject.body.error?.code, "D1_PROJECT_NOT_FOUND");

const foreignWorkspaceRead = await fetch(workspaceUrl, {
  headers: { cookie: isolationAuth.cookie, accept: "application/json" },
  signal: AbortSignal.timeout(20_000)
});
assert.equal(foreignWorkspaceRead.status, 404, "A second account must not read another account's workspace.");

const foreignWorkspaceWrite = await fetch(workspaceUrl, {
  method: "PUT",
  headers: { ...mutationHeaders, cookie: isolationAuth.cookie },
  body: JSON.stringify({ expectedRevision: reloaded.revision, document: { unauthorized: true } }),
  signal: AbortSignal.timeout(20_000)
});
assert.equal(foreignWorkspaceWrite.status, 404, "A second account must not write another account's workspace.");

const secondProject = await postJson("Second account D1 project creation", stagingOrigin + "/api/d1/projects", {
  body: { name: `CI tenant isolation ${runLabel}`, description: "Second isolated staging account", settings: { source: "github-actions", runId: runLabel } },
  cookie: isolationAuth.cookie,
  expectedStatus: 201
});
const secondProjectId = secondProject.payload.project?.id;
assert.match(secondProjectId || "", /^[0-9a-f-]{36}$/i);
const secondOwnProject = await getJson("Second account own project read", stagingOrigin + "/api/d1/projects/" + encodeURIComponent(secondProjectId), {
  expectedStatus: 200,
  cookie: isolationAuth.cookie
});
assert.equal(secondOwnProject.body.project.id, secondProjectId);

const firstAccountForeignRead = await getJson("First account cannot read second account project", stagingOrigin + "/api/d1/projects/" + encodeURIComponent(secondProjectId), {
  expectedStatus: 404,
  cookie: sessionCookie
});
assert.equal(firstAccountForeignRead.body.error?.code, "D1_PROJECT_NOT_FOUND");

console.log("PASS: two independent staging identities cannot list, read or write each other's projects/workspaces.");

const stagingWorkerOrigin = "https://executive-visuals-d1-staging.chrishem.workers.dev";
const workerProjectUrl = stagingWorkerOrigin + "/api/d1/projects/" + encodeURIComponent(project.id);
const workerWorkspaceUrl = workerProjectUrl + "/workspace";
const membersUrl = workerProjectUrl + "/members";
const added = await postJson("Owner adds verified collaborator as viewer", membersUrl, {
  body: { email: isolationEmail, role: "viewer" },
  cookie: sessionCookie,
  expectedStatus: 201
});
const member = added.payload.member;
assert.equal(member.email, isolationEmail);
assert.equal(member.role, "viewer");
assert.match(member.memberId || "", /^[0-9a-f-]{36}$/i);

const ownerMemberList = await getJson("Owner reads project members", membersUrl, { expectedStatus: 200, cookie: sessionCookie });
assert.equal(ownerMemberList.body.canManageMembers, true);
assert.ok(ownerMemberList.body.members.some(item => item.memberId === member.memberId && item.role === "viewer"));

const viewerMemberList = await getJson("Viewer reads project members", membersUrl, { expectedStatus: 200, cookie: isolationAuth.cookie });
assert.equal(viewerMemberList.body.canManageMembers, false);

const viewerInvite = await postJson("Viewer cannot invite or change roles", membersUrl, {
  body: { email: smokeEmail, role: "editor" },
  cookie: isolationAuth.cookie,
  expectedStatus: 403
});
assert.equal(viewerInvite.payload.error?.code, "D1_PROJECT_ACCESS_DENIED");

const viewerWorkspaceWrite = await fetch(workerWorkspaceUrl, {
  method: "PUT",
  headers: { ...mutationHeaders, cookie: isolationAuth.cookie },
  body: JSON.stringify({ expectedRevision: reloaded.revision, document: { viewerWrite: "must be denied" } }),
  signal: AbortSignal.timeout(20_000)
});
assert.equal(viewerWorkspaceWrite.status, 403, "Viewer role must not write workspace documents.");

const reviewer = await postJson("Owner promotes collaborator to reviewer", membersUrl, {
  body: { email: isolationEmail, role: "reviewer" },
  cookie: sessionCookie,
  expectedStatus: 201
});
assert.equal(reviewer.payload.member.role, "reviewer");

const reviewerWorkspaceWrite = await fetch(workerWorkspaceUrl, {
  method: "PUT",
  headers: { ...mutationHeaders, cookie: isolationAuth.cookie },
  body: JSON.stringify({ expectedRevision: reloaded.revision, document: { reviewerWrite: "must be denied" } }),
  signal: AbortSignal.timeout(20_000)
});
assert.equal(reviewerWorkspaceWrite.status, 403, "Reviewer role must not write workspace documents.");

const reviewerInvite = await postJson("Reviewer cannot invite or change roles", membersUrl, {
  body: { email: smokeEmail, role: "editor" },
  cookie: isolationAuth.cookie,
  expectedStatus: 403
});
assert.equal(reviewerInvite.payload.error?.code, "D1_PROJECT_ACCESS_DENIED");

const promoted = await postJson("Owner promotes collaborator to editor", membersUrl, {
  body: { email: isolationEmail, role: "editor" },
  cookie: sessionCookie,
  expectedStatus: 201
});
assert.equal(promoted.payload.member.role, "editor");

const editorInvite = await postJson("Editor cannot manage project membership", membersUrl, {
  body: { email: smokeEmail, role: "viewer" },
  cookie: isolationAuth.cookie,
  expectedStatus: 403
});
assert.equal(editorInvite.payload.error?.code, "D1_PROJECT_ACCESS_DENIED");

const editorWrite = await fetch(workerWorkspaceUrl, {
  method: "PUT",
  headers: { ...mutationHeaders, cookie: isolationAuth.cookie },
  body: JSON.stringify({ expectedRevision: reloaded.revision, document: { collaboration: "editor write accepted", runId: runLabel } }),
  signal: AbortSignal.timeout(20_000)
});
assert.equal(editorWrite.status, 200, await editorWrite.clone().text());
const editorSaved = await editorWrite.json();
assert.equal(editorSaved.revision, reloaded.revision + 1);

const ownerReload = await fetch(workerWorkspaceUrl, {
  headers: { cookie: sessionCookie, accept: "application/json" },
  signal: AbortSignal.timeout(20_000)
});
assert.equal(ownerReload.status, 200);
const ownerWorkspace = await ownerReload.json();
assert.deepEqual(ownerWorkspace.document, { collaboration: "editor write accepted", runId: runLabel });

const ownerSelfRemoval = await fetch(membersUrl + "/" + encodeURIComponent(project.ownerId), {
  method: "DELETE",
  headers: { ...mutationHeaders, cookie: sessionCookie, accept: "application/json" },
  signal: AbortSignal.timeout(20_000)
});
assert.equal(ownerSelfRemoval.status, 400, "The implicit project owner cannot remove themselves.");

const ownerStillHasAccess = await fetch(workerProjectUrl, {
  headers: { cookie: sessionCookie, accept: "application/json" },
  signal: AbortSignal.timeout(20_000)
});
assert.equal(ownerStillHasAccess.status, 200, "Owner access must survive a rejected self-removal.");

const removed = await fetch(membersUrl + "/" + encodeURIComponent(member.memberId), {
  method: "DELETE",
  headers: { ...mutationHeaders, cookie: sessionCookie, accept: "application/json" },
  signal: AbortSignal.timeout(20_000)
});
assert.equal(removed.status, 200, await removed.clone().text());
assert.equal((await removed.json()).removed, true);

const revoked = await fetch(workerProjectUrl, {
  headers: { cookie: isolationAuth.cookie, accept: "application/json" },
  signal: AbortSignal.timeout(20_000)
});
assert.equal(revoked.status, 404, "Removing a member must revoke project access immediately.");

console.log("PASS: owner-managed member add/list/update/remove works through the live staging app.");
console.log("PASS: Viewer and Reviewer are read-only; only Owner can manage membership; Editor can write but cannot invite.");
console.log("PASS: owner self-removal is rejected; removing a collaborator revokes access immediately.");


