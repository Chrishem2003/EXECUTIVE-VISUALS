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
console.log("NOTE: authenticated project creation and workspace persistence require the dedicated staging account acceptance test.");
