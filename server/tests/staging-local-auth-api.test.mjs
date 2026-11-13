import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STAGING_ORIGIN = "https://executive-visuals-1.onrender.com";
const STAGING_WORKER = "https://executive-visuals-d1-staging.chrishem.workers.dev";
const ALLOWED_EMAIL = "ev-staging-smoke@example.com";
const TEST_PASSWORD = "Staging-only-password-2026!";

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

test("production staging local auth enforces origin and allowlist through real HTTP routes", async t => {
  const port = await unusedPort();
  const dataDir = await mkdtemp(join(tmpdir(), "ev-staging-local-auth-"));
  const webDir = join(dataDir, "web");
  await mkdir(webDir, { recursive: true });
  await writeFile(join(webDir, "index.html"), "<!doctype html><html><body>staging auth test</body></html>");

  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      AUTH_MODE: "local",
      STAGING_LOCAL_AUTH_ENABLED: "true",
      STAGING_LOCAL_AUTH_ORIGIN: STAGING_ORIGIN,
      STAGING_LOCAL_AUTH_ALLOWLIST: ALLOWED_EMAIL,
      CORS_ORIGINS: STAGING_ORIGIN,
      D1_STAGING_WORKER_URL: STAGING_WORKER,
      API_HOST: "127.0.0.1",
      API_PORT: String(port),
      DATA_DIR: dataDir,
      MEDIA_ROOT: join(dataDir, "media"),
      WEB_ROOT: webDir,
      AUTH_RATE_LIMIT: "1000",
      DISABLE_WORKER: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const base = "http://127.0.0.1:" + port;

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    await rm(dataDir, { recursive: true, force: true });
  }
  t.after(stop);

  async function waitForApi() {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("Staging API exited before startup. " + stderr);
      try {
        const response = await fetch(base + "/api/health");
        if (response.ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Staging API did not become ready. stdout=" + stdout + " stderr=" + stderr);
  }

  function request(path, { method = "GET", body, origin, secFetchSite, cookie } = {}) {
    const headers = new Headers();
    if (body !== undefined) headers.set("content-type", "application/json");
    if (origin !== undefined) headers.set("origin", origin);
    if (secFetchSite !== undefined) headers.set("sec-fetch-site", secFetchSite);
    if (cookie) headers.set("cookie", cookie);
    return fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  await waitForApi();

  const health = await (await request("/api/health")).json();
  assert.equal(health.status, "ok");
  assert.equal(health.authMode, "local");
  assert.deepEqual(health.staging, { d1WorkspaceEnabled: true, localAuthEnabled: true });

  const missingOrigin = await request("/api/auth/register", {
    method: "POST",
    body: { email: ALLOWED_EMAIL, password: TEST_PASSWORD }
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await missingOrigin.json()).error.code, "CSRF_ORIGIN_REQUIRED");

  const foreignOrigin = await request("/api/auth/register", {
    method: "POST",
    origin: "https://attacker.example",
    secFetchSite: "cross-site",
    body: { email: ALLOWED_EMAIL, password: TEST_PASSWORD }
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal((await foreignOrigin.json()).error.code, "ORIGIN_DENIED");

  const disallowedEmail = await request("/api/auth/register", {
    method: "POST",
    origin: STAGING_ORIGIN,
    secFetchSite: "same-origin",
    body: { email: "not-allowlisted@example.com", password: TEST_PASSWORD }
  });
  assert.equal(disallowedEmail.status, 403);
  assert.equal((await disallowedEmail.json()).error.code, "STAGING_EMAIL_NOT_ALLOWED");

  const registered = await request("/api/auth/register", {
    method: "POST",
    origin: STAGING_ORIGIN,
    secFetchSite: "same-origin",
    body: { email: ALLOWED_EMAIL, password: TEST_PASSWORD }
  });
  assert.equal(registered.status, 201, await registered.clone().text());
  assert.equal((await registered.json()).authMode, "local");
  const sessionCookie = registered.headers.get("set-cookie")?.split(";")[0];
  assert.ok(sessionCookie, "registration must issue an opaque session cookie");

  const identity = await request("/api/me", { cookie: sessionCookie });
  assert.equal(identity.status, 200);
  const identityBody = await identity.json();
  assert.equal(identityBody.user.email, ALLOWED_EMAIL);
  assert.equal(identityBody.authMode, "local");

  const duplicate = await request("/api/auth/register", {
    method: "POST",
    origin: STAGING_ORIGIN,
    secFetchSite: "same-origin",
    body: { email: ALLOWED_EMAIL, password: TEST_PASSWORD }
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "ACCOUNT_EXISTS");

  const foreignLogin = await request("/api/auth/login", {
    method: "POST",
    origin: "https://attacker.example",
    secFetchSite: "cross-site",
    body: { email: ALLOWED_EMAIL, password: TEST_PASSWORD }
  });
  assert.equal(foreignLogin.status, 403);
  assert.equal((await foreignLogin.json()).error.code, "ORIGIN_DENIED");

  const login = await request("/api/auth/login", {
    method: "POST",
    origin: STAGING_ORIGIN,
    secFetchSite: "same-origin",
    body: { email: ALLOWED_EMAIL, password: TEST_PASSWORD }
  });
  assert.equal(login.status, 200, await login.clone().text());
  assert.equal((await login.json()).authMode, "local");
  assert.ok(login.headers.get("set-cookie"), "login must issue a session cookie");

  const anonymousD1 = await request("/api/d1/projects");
  assert.equal(anonymousD1.status, 401);
  assert.equal((await anonymousD1.json()).error.code, "AUTH_REQUIRED");
});
