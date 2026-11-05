import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  await new Promise((resolveClose, reject) => probe.close(error => error ? reject(error) : resolveClose()));
  return address.port;
}

test("Supabase public auth config is exposed safely and allowed by the HTML CSP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "executive-visuals-supabase-auth-"));
  const dataDir = join(directory, "data");
  const mediaRoot = join(dataDir, "media");
  const webRoot = join(directory, "web");
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>auth test</title>");
  const port = await unusedPort();
  const serviceRoleSentinel = "service_role_must_never_be_exposed";
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "development",
      AUTH_MODE: "supabase",
      SUPABASE_URL: "https://auth-test.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key",
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleSentinel,
      API_HOST: "127.0.0.1",
      API_PORT: String(port),
      DATA_DIR: dataDir,
      DB_FILE: join(dataDir, "executive-visuals.sqlite"),
      MEDIA_ROOT: mediaRoot,
      WEB_ROOT: webRoot,
      DISABLE_WORKER: "true",
      REQUIRE_PERSISTENT_DATA_DIR: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const base = "http://127.0.0.1:" + port;
  try {
    let healthResponse;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("API exited before health check: " + stderr);
      try {
        healthResponse = await fetch(base + "/api/health");
        if (healthResponse.ok) break;
      } catch {}
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    assert.ok(healthResponse?.ok, "API did not become healthy: " + stderr);
    const health = await healthResponse.json();
    assert.equal(health.authMode, "supabase");
    assert.deepEqual(health.supabase, {
      url: "https://auth-test.supabase.co",
      publishableKey: "sb_publishable_test_key"
    });
    assert.equal(JSON.stringify(health).includes(serviceRoleSentinel), false);
    assert.equal(JSON.stringify(health).includes("SUPABASE_SERVICE_ROLE_KEY"), false);

    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    const csp = page.headers.get("content-security-policy") || "";
    assert.ok(csp.includes("connect-src 'self' https://auth-test.supabase.co"));
    assert.equal(csp.includes(serviceRoleSentinel), false);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise(resolveExit => child.once("exit", resolveExit)),
      new Promise(resolveDelay => setTimeout(resolveDelay, 1500))
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});
