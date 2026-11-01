import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, json } from "../db.mjs";
import { executeStudioJob, prepareStudioJob } from "../studio.mjs";
import { executeWorkflowRun } from "../workflow-executor.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(32)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64)]);
const ENV = ["ENHANCE", "AVATAR"].flatMap(p => ["ENABLED", "URL", "MODEL", "OUTPUT_HOSTS", "POLL_MS", "ALLOW_REMOTE", "API_KEY"].map(s => `${p}_GATEWAY_${s}`)).concat(["REMOTE_AI_DAILY_REQUEST_LIMIT"]);
const future = () => new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

async function harness(handler) {
  const saved = Object.fromEntries(ENV.map(key => [key, process.env[key]]));
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  for (const prefix of ["ENHANCE", "AVATAR"]) {
    process.env[`${prefix}_GATEWAY_ENABLED`] = "true";
    process.env[`${prefix}_GATEWAY_URL`] = url;
    process.env[`${prefix}_GATEWAY_MODEL`] = "test-model";
    process.env[`${prefix}_GATEWAY_POLL_MS`] = "200";
    process.env[`${prefix}_GATEWAY_API_KEY`] = "secret-key";
  }
  delete process.env.REMOTE_AI_DAILY_REQUEST_LIMIT;
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(id,email) VALUES('u1','a@example.com')").run();
  db.prepare("INSERT INTO projects(id,owner_id,name) VALUES('p1','u1','Test project')").run();
  const mediaRoot = await mkdtemp(join(tmpdir(), "studio-"));
  const user = { id: "u1" };
  const setCharacters = characters => db.prepare("INSERT INTO project_workspace_documents(project_id,document_json) VALUES('p1',?) ON CONFLICT(project_id) DO UPDATE SET document_json=excluded.document_json").run(json({ characters }));
  async function asset(id, name, mediaType, buffer) {
    await mkdir(join(mediaRoot, "u1"), { recursive: true });
    await writeFile(join(mediaRoot, "u1", name), buffer);
    db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path) VALUES(?,?,'p1',?,?,?,?,?)").run(id, "u1", name, mediaType, buffer.length, "0".repeat(64), `u1/${name}`);
  }
  function insertJob(prepared, id) {
    db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,input_json) VALUES(?,?,?,?,'running',?)").run(id, "u1", prepared.projectId, prepared.jobType, JSON.stringify(prepared.input));
    return db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  }
  async function run(body) {
    const prepared = prepareStudioJob(db, user, { projectId: "p1", ...body });
    return executeStudioJob({ db, job: insertJob(prepared, `job-${Math.random().toString(16).slice(2)}`), mediaRoot });
  }
  const close = async () => {
    await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  };
  return { db, user, asset, run, insertJob, setCharacters, requests, close, mediaRoot };
}

const authorized = (extra = {}) => ({ id: "c1", name: "Host", consent: { kind: "authorized", scopes: ["likeness", "face-animation", "voice"], evidenceReference: "release-2026-001", expiresAt: future(), ...extra } });
const avatarBody = { jobType: "studio.avatar", identityProfileId: "c1", params: { avatarRef: "av_1", script: "Welcome to the show." } };

test("enhancement sends the file, stores a derived asset and records usage", async () => {
  const h = await harness((req, res) => { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); });
  try {
    await h.asset("a1", "photo.png", "image/png", PNG);
    const result = await h.run({ jobType: "studio.enhance", sourceAssetId: "a1", operation: "upscale", params: { scale: 4 } });
    assert.equal(result.outputAsset.mediaType, "image/png");
    const stored = h.db.prepare("SELECT * FROM assets WHERE id=?").get(result.outputAsset.id);
    assert.equal(stored.derivative_of, "a1");
    assert.equal(JSON.parse(stored.metadata_json).generated, true);
    assert.equal(h.requests[0].headers.authorization, "Bearer secret-key");
    assert.match(h.requests[0].body.toString("latin1"), /name="operation"\r\n\r\nupscale/);
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM model_usage_events WHERE provider='enhance'").get().n, 1);
  } finally { await h.close(); }
});

test("watermark removal requires a rights attestation", async () => {
  const h = await harness((req, res) => { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); });
  try {
    await h.asset("a1", "photo.png", "image/png", PNG);
    await assert.rejects(() => h.run({ jobType: "studio.enhance", sourceAssetId: "a1", operation: "remove-watermark" }), { code: "RIGHTS_ATTESTATION_REQUIRED" });
    await h.run({ jobType: "studio.enhance", sourceAssetId: "a1", operation: "remove-watermark", rightsAttested: true });
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='studio.rights_attested'").get().n, 1);
  } finally { await h.close(); }
});

test("an async result on an unlisted host is blocked and never fetched", async () => {
  const h = await harness((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ url: "https://169.254.169.254/latest/meta-data" })); });
  try {
    await h.asset("a1", "photo.png", "image/png", PNG);
    await assert.rejects(() => h.run({ jobType: "studio.enhance", sourceAssetId: "a1", operation: "denoise" }), { code: "ENHANCE_GATEWAY_OUTPUT_HOST_BLOCKED" });
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test("a gateway job is polled to completion", async () => {
  let polls = 0;
  const h = await harness((req, res) => {
    if (req.method === "POST") { res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "job-9" })); return; }
    if (req.url.endsWith("/jobs/job-9")) { polls += 1; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(polls < 2 ? { status: "running", progress: 40 } : { status: "succeeded", output: { url: "/v1/files/out.mp4" } })); return; }
    res.writeHead(200, { "content-type": "video/mp4" }); res.end(MP4);
  });
  try {
    await h.asset("v1", "clip.mp4", "video/mp4", MP4);
    const result = await h.run({ jobType: "studio.enhance", sourceAssetId: "v1", operation: "stabilize" });
    assert.equal(result.outputAsset.mediaType, "video/mp4");
    assert.ok(polls >= 2);
  } finally { await h.close(); }
});

test("presenter video needs documented, unexpired consent that covers every scope used", async () => {
  const h = await harness((req, res) => { res.writeHead(200, { "content-type": "video/mp4" }); res.end(MP4); });
  try {
    await assert.rejects(async () => prepareStudioJob(h.db, h.user, { ...avatarBody }), { code: "PROJECT_REQUIRED" });
    h.setCharacters([{ id: "c1", name: "Host", consent: { kind: "not-granted", scopes: [], evidenceReference: "", expiresAt: "" } }]);
    assert.throws(() => prepareStudioJob(h.db, h.user, { ...avatarBody, projectId: "p1" }), { code: "IDENTITY_PERMISSION_REQUIRED", status: 422 });
    h.setCharacters([authorized({ scopes: ["likeness"] })]);
    assert.throws(() => prepareStudioJob(h.db, h.user, { ...avatarBody, projectId: "p1" }), { code: "IDENTITY_PERMISSION_REQUIRED" });
    h.setCharacters([authorized({ expiresAt: "2020-01-01" })]);
    assert.throws(() => prepareStudioJob(h.db, h.user, { ...avatarBody, projectId: "p1" }), { code: "IDENTITY_PERMISSION_EXPIRED" });
    h.setCharacters([authorized()]);
    const ok = await h.run(avatarBody);
    assert.equal(ok.outputAsset.mediaType, "video/mp4");
    assert.equal(JSON.parse(h.requests[0].body.toString()).avatar, "av_1");
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='studio.identity_used'").get().n, 1);
    h.setCharacters([{ id: "c1", name: "Host", consent: { kind: "fictional", scopes: [], evidenceReference: "", expiresAt: "" } }]);
    assert.ok((await h.run(avatarBody)).outputAsset.id);
  } finally { await h.close(); }
});

test("withdrawing consent stops a presenter job that is already queued", async () => {
  const h = await harness((req, res) => { res.writeHead(200, { "content-type": "video/mp4" }); res.end(MP4); });
  try {
    h.setCharacters([authorized()]);
    const prepared = prepareStudioJob(h.db, h.user, { ...avatarBody, projectId: "p1" });
    const job = h.insertJob(prepared, "job-queued");
    h.setCharacters([{ id: "c1", name: "Host", consent: { kind: "not-granted", scopes: [], evidenceReference: "", expiresAt: "" } }]);
    await assert.rejects(() => executeStudioJob({ db: h.db, job, mediaRoot: h.mediaRoot }), { code: "IDENTITY_PERMISSION_REQUIRED" });
    assert.equal(h.requests.length, 0, "no request may reach the provider after consent is withdrawn");
  } finally { await h.close(); }
});

test("a voice reference needs voice consent as well", async () => {
  const h = await harness((req, res) => { res.writeHead(200, { "content-type": "video/mp4" }); res.end(MP4); });
  try {
    h.setCharacters([authorized({ scopes: ["face-animation"] })]);
    assert.throws(() => prepareStudioJob(h.db, h.user, { ...avatarBody, projectId: "p1", params: { ...avatarBody.params, voiceRef: "voice_1" } }), { code: "IDENTITY_PERMISSION_REQUIRED" });
  } finally { await h.close(); }
});

test("the shared remote-usage limit applies to a remote engine and sends nothing once reached", async () => {
  const h = await harness((req, res) => { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); });
  try {
    process.env.ENHANCE_GATEWAY_URL = "https://gateway.example.test/v1";
    process.env.ENHANCE_GATEWAY_ALLOW_REMOTE = "true";
    process.env.REMOTE_AI_DAILY_REQUEST_LIMIT = "0";
    await h.asset("a1", "photo.png", "image/png", PNG);
    await assert.rejects(() => h.run({ jobType: "studio.enhance", sourceAssetId: "a1", operation: "denoise" }), { code: "REMOTE_USAGE_LIMIT_REACHED" });
    assert.equal(h.requests.length, 0);
  } finally { await h.close(); }
});

test("cancelling a job aborts the provider request", async () => {
  const h = await harness(() => { /* never answers */ });
  try {
    await h.asset("a1", "photo.png", "image/png", PNG);
    const prepared = prepareStudioJob(h.db, h.user, { projectId: "p1", jobType: "studio.enhance", sourceAssetId: "a1", operation: "denoise" });
    const job = h.insertJob(prepared, "job-c");
    const pending = executeStudioJob({ db: h.db, job, mediaRoot: h.mediaRoot });
    setTimeout(() => h.db.prepare("UPDATE jobs SET status='cancelled' WHERE id='job-c'").run(), 300);
    await assert.rejects(() => pending, { code: "JOB_CANCELLED" });
  } finally { await h.close(); }
});

test("a disabled engine reports a configuration code and sends nothing", async () => {
  const h = await harness((req, res) => res.end());
  try {
    process.env.ENHANCE_GATEWAY_ENABLED = "false";
    await h.asset("a1", "photo.png", "image/png", PNG);
    await assert.rejects(() => h.run({ jobType: "studio.enhance", sourceAssetId: "a1", operation: "denoise" }), { code: "ENHANCE_GATEWAY_DISABLED" });
    assert.equal(h.requests.length, 0);
  } finally { await h.close(); }
});

function seedRun(db, id, graph) {
  const snapshot = JSON.stringify(graph);
  db.prepare("INSERT INTO workflows(id,owner_id,project_id,name,revision,graph_json,graph_hash) VALUES(?,?,'p1',?,1,?,?)").run(`wf-${id}`, "u1", id, snapshot, "f".repeat(64));
  db.prepare("INSERT INTO workflow_runs(id,workflow_id,owner_id,project_id,workflow_revision,snapshot_hash,snapshot_json,status,job_id) VALUES(?,?,?,'p1',1,?,?,'queued',?)").run(id, `wf-${id}`, "u1", "e".repeat(64), snapshot, `job-${id}`);
  for (const node of graph.nodes) db.prepare("INSERT INTO workflow_node_runs(id,run_id,node_id,status) VALUES(?,?,?,'pending')").run(`nr-${id}-${node.id}`, id, node.id);
  db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json) VALUES(?,?,'p1','workflow.execute','running',5,?)").run(`job-${id}`, "u1", json({ runId: id }));
  return db.prepare("SELECT * FROM jobs WHERE id=?").get(`job-${id}`);
}

test("a presenter workflow node waits for approval, then runs with consent", async () => {
  const h = await harness((req, res) => { res.writeHead(200, { "content-type": "video/mp4" }); res.end(MP4); });
  try {
    h.setCharacters([authorized()]);
    const script = { id: "script", kind: "text", label: "Script", inputs: [], outputs: [{ id: "text", type: "text" }], config: { text: "Welcome to the show." } };
    const gate = { id: "gate", kind: "approval", label: "Approve spend", inputs: [{ id: "text", type: "text", required: true }], outputs: [{ id: "text", type: "text" }], config: {} };
    const presenter = { id: "presenter", kind: "avatar.generate", label: "Presenter", inputs: [{ id: "text", type: "text", required: true }], outputs: [{ id: "video", type: "video" }], config: { identityProfileId: "c1", params: { avatarRef: "av_1" } } };
    const graph = { id: "g", projectId: "p1", revision: 1, nodes: [script, gate, presenter], edges: [
      { id: "e1", sourceNodeId: "script", sourcePortId: "text", targetNodeId: "gate", targetPortId: "text" },
      { id: "e2", sourceNodeId: "gate", sourcePortId: "text", targetNodeId: "presenter", targetPortId: "text" }
    ] };
    const job = seedRun(h.db, "run-1", graph);
    const waiting = await executeWorkflowRun({ db: h.db, job, mediaRoot: h.mediaRoot });
    assert.equal(waiting.status, "awaiting_approval");
    assert.equal(h.requests.length, 0, "nothing is sent while approval is pending");
    h.db.prepare("UPDATE workflow_node_runs SET status='completed',output_json=?,completed_at=? WHERE run_id='run-1' AND node_id='gate'").run(json({ text: "Welcome to the show.", approved: true }), new Date().toISOString());
    h.db.prepare("UPDATE workflow_runs SET status='queued' WHERE id='run-1'").run();
    h.db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json) VALUES('job-resume','u1','p1','workflow.execute','running',5,?)").run(json({ runId: "run-1" }));
    const done = await executeWorkflowRun({ db: h.db, job: { ...job, id: "job-resume" }, mediaRoot: h.mediaRoot });
    assert.equal(done.status, "completed");
    assert.equal(h.requests.length, 1);
    assert.equal(h.db.prepare("SELECT media_type FROM assets WHERE id=?").get(done.nodeOutputs.presenter.video).media_type, "video/mp4");
  } finally { await h.close(); }
});

test("an unapproved presenter node is blocked and sends nothing", async () => {
  const h = await harness((req, res) => { res.writeHead(200, { "content-type": "video/mp4" }); res.end(MP4); });
  try {
    h.setCharacters([authorized()]);
    const script = { id: "script", kind: "text", label: "Script", inputs: [], outputs: [{ id: "text", type: "text" }], config: { text: "Hi" } };
    const presenter = { id: "presenter", kind: "avatar.generate", label: "Presenter", inputs: [{ id: "text", type: "text", required: true }], outputs: [{ id: "video", type: "video" }], config: { identityProfileId: "c1", params: { avatarRef: "av_1" } } };
    const graph = { id: "g2", projectId: "p1", revision: 1, nodes: [script, presenter], edges: [{ id: "e1", sourceNodeId: "script", sourcePortId: "text", targetNodeId: "presenter", targetPortId: "text" }] };
    const job = seedRun(h.db, "run-2", graph);
    await assert.rejects(() => executeWorkflowRun({ db: h.db, job, mediaRoot: h.mediaRoot }), { code: "APPROVAL_REQUIRED" });
    assert.equal(h.db.prepare("SELECT status FROM workflow_node_runs WHERE run_id='run-2' AND node_id='presenter'").get().status, "blocked");
    assert.equal(h.requests.length, 0);
  } finally { await h.close(); }
});
