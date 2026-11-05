import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// Fake Supabase: identity from the token, and a per-user table like the real row-level rule.
const rows = new Map();
const seen = [];
let tableMissing = false;
const userFor = authorization => String(authorization || "").replace(/^Bearer /, "").split("-token-")[0];
const provider = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  res.setHeader("content-type", "application/json");
  const user = userFor(req.headers.authorization);
  if (req.url === "/auth/v1/user") { res.end(JSON.stringify({ id: user, email: user + "@example.test" })); return; }
  if (req.url.startsWith("/rest/v1/ev_workspace_snapshots")) {
    seen.push({ method: req.method, apikey: req.headers.apikey, authorization: req.headers.authorization });
    if (tableMissing) { res.statusCode = 404; res.end(JSON.stringify({ code: "42P01", message: "relation \"public.ev_workspace_snapshots\" does not exist" })); return; }
    const row = rows.get(user);
    if (req.method === "GET") { res.end(JSON.stringify(row ? [row] : [])); return; }
    const body = JSON.parse(raw);
    if (req.method === "POST") {
      if (row) { res.statusCode = 409; res.end(JSON.stringify({ code: "23505" })); return; }
      rows.set(user, { data: body.data, revision: 1, updated_at: "now" }); res.statusCode = 201; res.end(JSON.stringify([{ revision: 1, updated_at: "now" }])); return;
    }
    if (req.method === "PATCH") {
      const want = Number(new URL(req.url, "http://x").searchParams.get("revision").replace("eq.", ""));
      if (!row || row.revision !== want) { res.end("[]"); return; }
      Object.assign(row, { data: body.data, revision: body.revision, updated_at: "later" });
      res.end(JSON.stringify([{ revision: row.revision, updated_at: row.updated_at }])); return;
    }
  }
  res.statusCode = 404; res.end(JSON.stringify({ message: "not found" }));
});
const providerPort = await listen(provider);
const probe = createServer(); const apiPort = await listen(probe); await new Promise(resolve => probe.close(resolve));
const dataDir = await mkdtemp(join(tmpdir(), "ev-workspace-api-"));
const webDir = join(dataDir, "web"); await mkdir(webDir, { recursive: true });
await writeFile(join(webDir, "index.html"), "<!doctype html><html><body>test</body></html>");
const child = spawn(process.execPath, ["server/index.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "development", AUTH_MODE: "supabase", SUPABASE_URL: "http://127.0.0.1:" + providerPort, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", API_HOST: "127.0.0.1", API_PORT: String(apiPort), DATA_DIR: dataDir, MEDIA_ROOT: join(dataDir, "media"), WEB_ROOT: webDir, DISABLE_WORKER: "true", AUTH_RATE_LIMIT: "100" },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderr = ""; child.stderr.on("data", chunk => stderr += chunk.toString());
const base = "http://127.0.0.1:" + apiPort;
for (let i = 0; i < 80; i++) {
  if (child.exitCode !== null) throw new Error("API exited: " + stderr);
  try { if ((await fetch(base + "/api/health")).ok) break; } catch { /* not up yet */ }
  await new Promise(resolve => setTimeout(resolve, 100));
}
const call = (method, token, body) => fetch(base + "/api/workspace", { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const tokenFor = user => user + "-token-0123456789abcdef";

test("workspace saving through the real server routes", async t => {
  t.after(async () => { child.kill("SIGTERM"); provider.close(); await rm(dataDir, { recursive: true, force: true }); });

  assert.equal((await call("GET")).status, 401, "signed-out visitors get nothing");
  assert.equal((await call("PUT", null, { data: {}, expectedRevision: 0 })).status, 401);

  const ann = tokenFor("ann");
  const empty = await (await call("GET", ann)).json();
  assert.deepEqual([empty.enabled, empty.found, empty.revision], [true, false, 0]);

  const saved = await call("PUT", ann, { data: { shots: [{ scene: "Opening" }], prompt: "hello" }, expectedRevision: 0 });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);

  const read = await (await call("GET", ann)).json();
  assert.deepEqual(read.data, { shots: [{ scene: "Opening" }], prompt: "hello" });

  const next = await (await call("PUT", ann, { data: { shots: [] }, expectedRevision: 1 })).json();
  assert.equal(next.revision, 2);

  const stale = await call("PUT", ann, { data: { shots: ["stale"] }, expectedRevision: 1 });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.error.code, "WORKSPACE_CONFLICT");
  assert.equal(staleBody.currentRevision, 2);

  const other = await (await call("GET", tokenFor("ben"))).json();
  assert.equal(other.found, false, "another person never sees Ann's work");
  assert.ok(!JSON.stringify(other).includes("Opening"));

  const tooBig = await call("PUT", ann, { data: { blob: "x".repeat(950_000) }, expectedRevision: 2 });
  assert.equal(tooBig.status, 413);
  assert.equal((await tooBig.json()).error.code, "WORKSPACE_TOO_LARGE");
  assert.equal((await call("PUT", ann, { data: [], expectedRevision: 2 })).status, 400);
  assert.equal((await call("PUT", ann, { data: {}, expectedRevision: "two" })).status, 400);

  for (const entry of seen) {
    assert.equal(entry.apikey, "sb_publishable_test", "only the public key is sent");
    assert.ok(entry.authorization.startsWith("Bearer ann-token-") || entry.authorization.startsWith("Bearer ben-token-"));
  }

  tableMissing = true;
  const notSetUp = await call("GET", ann);
  assert.equal(notSetUp.status, 503);
  const message = (await notSetUp.json()).error;
  assert.equal(message.code, "WORKSPACE_NOT_SET_UP");
  assert.ok(!/relation|public\./.test(message.message), "database internals are not shown");
});
