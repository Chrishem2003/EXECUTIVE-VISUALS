#!/usr/bin/env node
/**
 * Deployment smoke test. Reproduces the Docker runtime layout (package.json,
 * server/, dist/ and the account script only) in a temp directory and checks
 * two things:
 *   1. NODE_ENV=production with AUTH_MODE=local must refuse to start (local
 *      passwords are development-only; production needs AUTH_MODE=supabase).
 *   2. With the same files and a persistent data dir, but NODE_ENV=staging so
 *      local sign-in is allowed, the server serves the app, signs in an
 *      operator-made account, accepts an upload, runs a local FFmpeg job,
 *      returns the result, blocks unconfigured gateways, and keeps its data
 *      across a restart.
 * It cannot prove Supabase auth or cloud storage. Run `npm run build` first.
 *
 *   npm run smoke:production
 */
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(new URL("..", import.meta.url).pathname);
const checks = [];
const step = async (name, fn) => { await fn(); checks.push(name); console.log(`ok  ${name}`); };

const freePort = () => new Promise(done => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); }); });
const sh = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: "utf8", ...options });

const work = await mkdtemp(join(tmpdir(), "ev-smoke-"));
const app = join(work, "app");
const data = join(work, "data");
let child;
let failed = false;

try {
  await mkdir(join(app, "scripts"), { recursive: true });
  await cp(join(root, "server"), join(app, "server"), { recursive: true, filter: source => !source.includes(`${join(root, "server")}/tests`) });
  await cp(join(root, "package.json"), join(app, "package.json"));
  await cp(join(root, "scripts/create-user.mjs"), join(app, "scripts/create-user.mjs"));
  if (existsSync(join(root, "dist"))) await cp(join(root, "dist"), join(app, "dist"), { recursive: true });
  else { await mkdir(join(app, "dist")); await writeFile(join(app, "dist/index.html"), "<!doctype html><title>stub</title>"); console.warn("warn dist/ is missing; run npm run build for a realistic check"); }

  await mkdir(data, { recursive: true }); // stands in for the mounted volume
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const email = "operator@example.test";
  const password = "smoke-test-passphrase-123";
  const env = { ...process.env, NODE_ENV: "staging", API_HOST: "127.0.0.1", API_PORT: String(port), DATA_DIR: data, DB_FILE: join(data, "executive-visuals.sqlite"), MEDIA_ROOT: join(data, "media"), WEB_ROOT: "./dist", AUTH_MODE: "local", REQUIRE_PERSISTENT_DATA_DIR: "true", AUTH_RATE_LIMIT: "1000" };
  delete env.EV_PASSWORD;

  await step("production refuses local password auth, as designed", async () => {
    const attempt = sh(process.execPath, ["server/index.mjs"], { cwd: app, env: { ...env, NODE_ENV: "production" }, timeout: 15000 });
    assert.notEqual(attempt.status, 0, "the server must not start");
    assert.match(attempt.stderr, /AUTH_MODE=local is development-only/);
  });

  await step("the account script creates the first operator account", async () => {
    const made = sh(process.execPath, ["scripts/create-user.mjs", email], { cwd: app, env: { ...env, EV_PASSWORD: password } });
    assert.equal(made.status, 0, made.stderr);
  });

  child = spawn(process.execPath, ["server/index.mjs"], { cwd: app, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", chunk => { log += chunk; });
  child.stderr.on("data", chunk => { log += chunk; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`The server exited early:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* still starting */ }
    await new Promise(done => setTimeout(done, 100));
    if (i === 99) throw new Error(`The server did not start:\n${log}`);
  }

  await step("health reports FFmpeg and stays free of secrets", async () => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.status, "ok");
    assert.equal(health.media.ffmpeg, true, "FFmpeg must be installed for media jobs");
    assert.equal(health.media.ffprobe, true);
    assert.ok(!JSON.stringify(health).match(/KEY|SECRET|TOKEN/i));
  });

  await step("the app shell is served with security headers", async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") || "", /text\/html/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
  });

  let cookie = "";
  await step("the operator account can sign in; a wrong password cannot", async () => {
    const bad = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "wrong-password-123" }) });
    assert.equal(bad.status, 401);
    const good = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    assert.equal(good.status, 200);
    cookie = good.headers.get("set-cookie").split(";")[0];
    assert.match(good.headers.get("set-cookie"), /HttpOnly/i);
  });

  const api = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...(init.headers || {}), cookie } });

  await step("the provider catalog lists every engine as off by default", async () => {
    const catalog = await (await api("/api/providers")).json();
    assert.ok(catalog.providers.length >= 10);
    assert.equal(catalog.summary.ready, 1, "only local media should be ready on a clean install");
  });

  await step("the studio catalog serves forms for finishing, transforms and lip-sync", async () => {
    const studio = await (await api("/api/studio/capabilities")).json();
    assert.ok(studio.finishing.length >= 6 && studio.transform.length >= 5 && studio.lipsync.params.length >= 1);
  });

  let sourceId = "";
  await step("a video uploads and is checksummed", async () => {
    const clip = join(work, "clip.mp4");
    const made = sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x240:r=25:d=4", "-f", "lavfi", "-i", "sine=f=440:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
    assert.equal(made.status, 0, made.stderr);
    const r = await api("/api/assets", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": encodeURIComponent("clip.mp4") }, body: await readFile(clip) });
    assert.equal(r.status, 201);
    const { asset } = await r.json();
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    sourceId = asset.id;
  });

  await step("a local speed job runs on the queue and the result downloads", async () => {
    const submitted = await api("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobType: "media.speed", sourceAssetId: sourceId, factor: 2 }) });
    assert.equal(submitted.status, 202);
    const { job } = await submitted.json();
    let current = job;
    for (let i = 0; i < 300 && !["succeeded", "failed", "cancelled", "blocked"].includes(current.status); i++) {
      await new Promise(done => setTimeout(done, 200));
      current = (await (await api(`/api/jobs/${job.id}`)).json()).job;
    }
    assert.equal(current.status, "succeeded", JSON.stringify(current.error));
    const outputId = current.output.outputAsset.id;
    const file = await api(`/api/assets/${outputId}/file`);
    assert.equal(file.status, 200);
    const out = join(work, "out.mp4");
    await writeFile(out, Buffer.from(await file.arrayBuffer()));
    const probe = JSON.parse(sh("ffprobe", ["-v", "error", "-show_format", "-of", "json", out]).stdout);
    assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.4, `expected about 2 s, got ${probe.format.duration}`);
  });

  await step("gateway engines refuse to run until you configure them", async () => {
    const r = await api("/api/studio/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobType: "studio.enhance", operation: "denoise", sourceAssetId: sourceId, params: {} }) });
    assert.equal(r.status, 202);
    const { job } = await r.json();
    let current = job;
    for (let i = 0; i < 100 && !["succeeded", "failed", "cancelled", "blocked"].includes(current.status); i++) {
      await new Promise(done => setTimeout(done, 200));
      current = (await (await api(`/api/jobs/${job.id}`)).json()).job;
    }
    assert.equal(current.status, "blocked", `expected blocked, got ${current.status}`);
    assert.match(current.error?.code || "", /ENHANCE_GATEWAY_DISABLED/);
  });

  await step("a restart keeps the account and data (persistent storage)", async () => {
    child.kill("SIGTERM");
    await new Promise(done => child.once("close", done));
    child = spawn(process.execPath, ["server/index.mjs"], { cwd: app, env, stdio: ["ignore", "pipe", "pipe"] });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ } await new Promise(done => setTimeout(done, 100)); }
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie").split(";")[0];
    const assets = await (await api("/api/assets")).json();
    assert.ok(assets.assets.length >= 2, "uploaded and derived assets should survive a restart");
  });
} catch (error) {
  failed = true;
  console.error(`FAIL ${error.message}`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await rm(work, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log(`\n${checks.length} production smoke checks passed.`);
