import assert from "node:assert/strict";

const endpoints = {
  stagingApp: "https://executive-visuals-1.onrender.com/api/health",
  stagingWorker: "https://executive-visuals-d1-staging.chrishem.workers.dev/edge-health",
  stagingD1: "https://executive-visuals-d1-staging.chrishem.workers.dev/api/d1/health",
  stagingUnauthenticatedProjects: "https://executive-visuals-1.onrender.com/api/d1/projects?limit=1",
  productionApp: "https://executive-visuals.onrender.com/api/health"
};

async function getJson(name, url, { expectedStatus = 200, retries = 5 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json", "cache-control": "no-cache" },
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
const smokeEmail = "ev-staging-smoke@example.com";
const smokePassword = "Staging-only-password-2026!";
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
}).catch(async error => {
  if (!String(error.message).includes("HTTP 409")) throw error;
  return postJson("Staging smoke login", stagingOrigin + "/api/auth/login", {
    body: { email: smokeEmail, password: smokePassword },
    expectedStatus: 200
  });
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

const runLabel = process.env.GITHUB_RUN_ID || String(Date.now());
const projectResponse = await postJson("Authenticated D1 project creation", stagingOrigin + "/api/d1/projects", {
  body: { name: `CI D1 round-trip ${runLabel}`, description: "Automated isolated staging acceptance project", settings: { source: "github-actions", runId: runLabel } },
  cookie: sessionCookie,
  expectedStatus: 201
});
const project = projectResponse.payload.project;
assert.match(project?.id || "", /^[0-9a-f-]{36}$/i);
assert.equal(projectResponse.payload.storage, "cloudflare-d1-staging");

const projectList = await getJson("Authenticated D1 project list", stagingOrigin + "/api/d1/projects?limit=50", { expectedStatus: 200 });
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

