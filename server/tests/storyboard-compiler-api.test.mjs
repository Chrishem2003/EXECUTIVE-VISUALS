import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const output = {
  logline: "A short, verifiable process story that makes the result understandable.",
  globalContinuityRules: ["Keep the workshop layout consistent", "Preserve product geometry", "Maintain screen direction"],
  characterSuggestions: [],
  scenes: [
    {
      title: "The challenge", slugline: "INT. WORKSHOP - DAY", purpose: "Introduce the problem and the process.",
      storyBeat: "The problem", location: "Workshop", timeOfDay: "Day",
      shots: [{
        shotType: "Establishing", framing: "Wide", angle: "Eye level", movement: "Slow push",
        lens: "24mm", action: "Reveal the workshop and the material being repaired.", dialogue: "", narration: "",
        visualPrompt: "Documentary workshop establishing image with natural light and real tools.",
        motionPrompt: "A slow controlled push reveals the work area.", negativePrompt: "No invented labels or logos.",
        lighting: "Soft daylight", soundCue: "Authentic room tone", continuityIn: "Begin on workshop entrance.",
        continuityOut: "Settle on the workbench.", proofReference: "", transitionOut: "cut", durationSeconds: 10, characterRefs: []
      }]
    },
    {
      title: "The demonstration", slugline: "INT. WORKSHOP - CONTINUOUS", purpose: "Show a real action that supports the story.",
      storyBeat: "The proof", location: "Work bench", timeOfDay: "Day",
      shots: [{
        shotType: "Insert", framing: "Close-up", angle: "Overhead", movement: "Locked",
        lens: "50mm", action: "Show the hands completing one clear step in the process.", dialogue: "", narration: "",
        visualPrompt: "A precise close-up of hands working on a real component, neutral background and accurate geometry.",
        motionPrompt: "Hold the frame steady while the hands complete the step.", negativePrompt: "No fabricated performance claims.",
        lighting: "Soft side light", soundCue: "Tool contact and workshop ambience", continuityIn: "Match the previous workbench position.",
        continuityOut: "Hold on the completed step.", proofReference: "Verify the process with the production owner.", transitionOut: "sound_bridge", durationSeconds: 10, characterRefs: []
      }]
    }
  ]
};
let gatewayRequests = 0, malformed = false;
const gateway = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  gatewayRequests++;
  assert.equal(req.url, "/v1/chat/completions");
  assert.equal(req.headers.authorization, "Bearer storyboard-test-secret");
  const payload = JSON.parse(body);
  assert.equal(payload.model, "storyboard-test-model");
  assert.match(payload.messages.at(-1).content, /Story plan test/);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: "storyboard-test-model", choices: [{ message: { content: malformed ? "invalid" : JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600 } }));
});
const gatewayPort = await new Promise(resolve => gateway.listen(0, "127.0.0.1", () => resolve(gateway.address().port)));
const port = await new Promise(resolve => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)); });
});
const dataDir = await mkdtemp(join(tmpdir(), "ev-storyboard-api-"));
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
    AI_GATEWAY_MODEL: "storyboard-test-model", AI_GATEWAY_API_KEY: "storyboard-test-secret",
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
  const response = await fetch(base + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "local-test-password-123" }) });
  if (response.status !== 201) throw new Error("Registration failed: " + response.status + " " + await response.text());
  return response.headers.get("set-cookie").split(";")[0];
}
async function request(path, options = {}, cookie) {
  return fetch(base + path, { ...options, headers: { ...(options.headers || {}), ...(cookie ? { cookie } : {}) } });
}
await waitForApi();

test("storyboard endpoint requires authentication and returns a validated editable plan", async () => {
  const input = {
    creativeDirection: { title: "Story plan test", creativePromise: "Show a practical process without overclaiming.", storyBeats: ["Problem", "People", "Process", "Proof"], visualGrammar: ["Natural light", "Close details"], soundIdentity: ["Workshop ambience"], proofAndTrustChecks: ["Verify the demonstration"] },
    targetDurationSeconds: 20, aspectRatio: "9:16", frameRate: 30, characters: []
  };
  const anonymous = await request("/api/creative/storyboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }) });
  assert.equal(anonymous.status, 401);
  const cookie = await register("storyboard-owner@example.test");
  const projectResponse = await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Storyboard project" }) }, cookie);
  assert.equal(projectResponse.status, 201);
  const projectId = (await projectResponse.json()).project.id;
  const response = await request("/api/creative/storyboard", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, input })
  }, cookie);
  if (response.status !== 200) throw new Error("Storyboard request failed: " + response.status + " " + await response.text());
  const body = await response.json();
  assert.equal(body.storyboard.source, "model");
  assert.equal(body.storyboard.model, "storyboard-test-model");
  assert.equal(body.storyboard.scenes.length, 2);
  assert.equal(body.storyboard.durationSeconds, 20);
  assert.equal(body.storyboard.scenes[1].shots[0].transitionOut, "sound_bridge");
  assert.equal(body.usage.totalTokens, 600);
  assert.ok(body.recordId);
  assert.equal(JSON.stringify(body).includes("storyboard-test-secret"), false);
  assert.equal(gatewayRequests, 1);
});

test("storyboard endpoint enforces project ownership before model inference", async () => {
  const owner = await register("storyboard-owner-two@example.test");
  const created = await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Private storyboard" }) }, owner);
  const projectId = (await created.json()).project.id;
  const other = await register("storyboard-other@example.test");
  const before = gatewayRequests;
  const response = await request("/api/creative/storyboard", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, input: { creativeDirection: { title: "Story plan test", creativePromise: "x", storyBeats: ["a", "b", "c"], visualGrammar: ["a", "b"] }, targetDurationSeconds: 20, aspectRatio: "9:16" } })
  }, other);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "PROJECT_NOT_FOUND");
  assert.equal(gatewayRequests, before);
});

test("storyboard endpoint rejects invalid plans and malformed model output", async () => {
  const cookie = await register("storyboard-invalid@example.test");
  const before = gatewayRequests;
  const invalid = await request("/api/creative/storyboard", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { creativeDirection: { title: "Missing beats" }, targetDurationSeconds: 20, aspectRatio: "9:16" } })
  }, cookie);
  assert.equal(invalid.status, 400);
  assert.equal(gatewayRequests, before);
  malformed = true;
  const response = await request("/api/creative/storyboard", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { creativeDirection: { title: "Story plan test", creativePromise: "x", storyBeats: ["a", "b", "c"], visualGrammar: ["a", "b"] }, targetDurationSeconds: 20, aspectRatio: "9:16" } })
  }, cookie);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "STORYBOARD_OUTPUT_INVALID");
  assert.equal(gatewayRequests, before + 1);
});

test.after(async () => {
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
  await new Promise(resolve => gateway.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});
