import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plan = {
  creativePromise: "A grounded story that makes the audience see a familiar problem differently.",
  audienceContract: "Small business owners get a practical, credible explanation.",
  strategicThesis: "Lead with observable proof before the emotional payoff.",
  emotionalJourney: ["Curiosity", "Recognition", "Discovery", "Confidence"],
  hookAngles: ["Open on the transformation", "Begin with a customer question", "Reveal an overlooked detail"],
  visualGrammar: ["Show process details", "Use motivated camera movement", "Protect visual continuity"],
  soundIdentity: ["Prioritize authentic ambience", "Keep dialogue clear"],
  storyBeats: ["Hook", "Context", "Demonstration", "Proof", "Invitation"],
  productionPillars: ["Evidence first", "Human relevance", "Accessible delivery"],
  distributionCuts: ["Vertical master", "Short proof cut"],
  proofAndTrustChecks: ["Verify claims", "Confirm rights", "Disclose synthetic media where needed"],
  assumptions: ["A demonstration can be filmed"],
  openQuestions: ["Which product result is approved for publication?"],
  riskFlags: ["Do not imply unverified savings"],
  creativeRoutes: [
    { name: "Process-led", angle: "Follow the work from source to result.", tradeoff: "Credible detail, slower opening." },
    { name: "Human-led", angle: "Start with the person affected by the problem.", tradeoff: "Immediate empathy, less technical detail." }
  ]
};

const gatewayPort = await new Promise(resolve => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
});
let gatewayRequests = 0, malformed = false, ownedProjectId = "";
const gateway = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  gatewayRequests++;
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/v1/chat/completions");
  assert.equal(req.headers.authorization, "Bearer creative-director-test-secret");
  const payload = JSON.parse(body);
  assert.equal(payload.model, "creative-director-test-model");
  assert.equal(payload.temperature, 0.35);
  assert.match(payload.messages[0].content, /untrusted creative input/);
  assert.match(payload.messages.at(-1).content, /Community solar workshop/);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    model: "creative-director-test-model",
    choices: [{ message: { content: malformed ? "not JSON" : JSON.stringify(plan) } }],
    usage: { prompt_tokens: 80, completion_tokens: 250, total_tokens: 330 }
  }));
});
await new Promise(resolve => gateway.listen(gatewayPort, "127.0.0.1", resolve));

const port = await new Promise(resolve => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)); });
});
const dataDir = await mkdtemp(join(tmpdir(), "ev-creative-director-api-"));
const webDir = join(dataDir, "web");
await mkdir(webDir, { recursive: true });
await writeFile(join(webDir, "index.html"), "<!doctype html><html><body>test</body></html>");
const child = spawn(process.execPath, ["server/index.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env, NODE_ENV: "development", AUTH_MODE: "local", AUTH_RATE_LIMIT: "1000",
    API_HOST: "127.0.0.1", API_PORT: String(port), DATA_DIR: dataDir,
    MEDIA_ROOT: join(dataDir, "media"), WEB_ROOT: webDir, DISABLE_WORKER: "true",
    AI_GATEWAY_ENABLED: "true", AI_GATEWAY_URL: "http://127.0.0.1:" + gatewayPort + "/v1",
    AI_GATEWAY_MODEL: "creative-director-test-model", AI_GATEWAY_API_KEY: "creative-director-test-secret",
    AI_GATEWAY_ALLOW_REMOTE: "false", AI_GATEWAY_TIMEOUT_MS: "5000"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
child.stderr.on("data", chunk => stderr += chunk.toString());
const base = "http://127.0.0.1:" + port;
async function waitForApi() {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("API exited early: " + stderr);
    try { const response = await fetch(base + "/api/health"); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("API did not start: " + stderr);
}
async function register(email) {
  const response = await fetch(base + "/api/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "local-test-password-123" })
  });
  assert.equal(response.status, 201, await response.text());
  return response.headers.get("set-cookie").split(";")[0];
}
async function request(path, options = {}, cookie) {
  return fetch(base + path, { ...options, headers: { ...(options.headers || {}), ...(cookie ? { cookie } : {}) } });
}
await waitForApi();

test("Creative Director endpoint requires authentication and never exposes gateway credentials", async () => {
  const anonymous = await request("/api/creative/director", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { title: "Test", brief: "Test brief" } })
  });
  assert.equal(anonymous.status, 401);
  const cookie = await register("creative-director-owner@example.test");
  const projectResponse = await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Creative Director test project" }) }, cookie);
  assert.equal(projectResponse.status, 201);
  ownedProjectId = (await projectResponse.json()).project.id;
  const response = await request("/api/creative/director", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: ownedProjectId, input: {
      title: "Community solar workshop",
      brief: "A community workshop demonstrates how solar equipment is repaired and reused.",
      audience: "Small businesses", channel: "YouTube", style: "Documentary", duration: "60 seconds",
      proof: "Workshop demonstration; verify product performance."
    } })
  }, cookie);
  if (response.status !== 200) throw new Error("Creative Director request failed: " + response.status + " " + await response.text());
  const body = await response.json();
  assert.equal(body.plan.source, "model");
  assert.equal(body.plan.title, "Community solar workshop");
  assert.equal(body.plan.creativeRoutes.length, 2);
  assert.equal(body.model, "creative-director-test-model");
  assert.deepEqual(body.usage, { promptTokens: 80, completionTokens: 250, totalTokens: 330 });
  assert.match(body.plan.inputHash, /^[a-f0-9]{64}$/);
  assert.ok(body.recordId);
  assert.equal(JSON.stringify(body).includes("creative-director-test-secret"), false);
  assert.equal(gatewayRequests, 1);
});

test("Creative Director project access is owner-scoped and blocks another user's inference", async () => {
  const other = await register("creative-director-other@example.test");
  const before = gatewayRequests;
  const response = await request("/api/creative/director", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: ownedProjectId, input: { title: "Private project", brief: "Do not process this for another user." } })
  }, other);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "PROJECT_NOT_FOUND");
  assert.equal(gatewayRequests, before);
});

test("Creative Director endpoint rejects malformed model output without saving a plan", async () => {
  malformed = true;
  const cookie = await register("creative-director-invalid@example.test");
  const response = await request("/api/creative/director", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { title: "Community solar workshop", brief: "A short test brief." } })
  }, cookie);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, "CREATIVE_DIRECTOR_OUTPUT_INVALID");
  assert.equal(gatewayRequests, 2);
});

test("Creative Director endpoint validates input before spending a model request", async () => {
  const cookie = await register("creative-director-empty@example.test");
  const before = gatewayRequests;
  const response = await request("/api/creative/director", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { title: " ", brief: " " } })
  }, cookie);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "CREATIVE_DIRECTOR_BRIEF_REQUIRED");
  assert.equal(gatewayRequests, before);
});

test.after(async () => {
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
  await new Promise(resolve => gateway.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});
