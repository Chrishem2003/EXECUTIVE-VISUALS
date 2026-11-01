import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, json } from "../db.mjs";
import { executeMediaJob, executableAvailable, upscaleFilter } from "../media.mjs";
import { atempoChain, buildFinishingArgs, parseFacts, FINISHING_OPERATIONS } from "../finishing.mjs";
import { executeWorkflowRun } from "../workflow-executor.mjs";

const hasFfmpeg = executableAvailable("ffmpeg") && executableAvailable("ffprobe");
const real = { skip: hasFfmpeg ? false : "FFmpeg is not installed" };

function ff(args) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
function probe(path) {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return parseFacts(JSON.parse(result.stdout));
}

async function harness() {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(id,email) VALUES('u1','a@example.com')").run();
  db.prepare("INSERT INTO projects(id,owner_id,name) VALUES('p1','u1','Test project')").run();
  const mediaRoot = await mkdtemp(join(tmpdir(), "finish-"));
  await mkdir(join(mediaRoot, "u1"), { recursive: true });
  const fixtures = await mkdtemp(join(tmpdir(), "finish-src-"));
  async function register(id, name, mediaType, makeArgs) {
    const path = join(fixtures, name);
    ff([...makeArgs, path]);
    await copyFile(path, join(mediaRoot, "u1", name));
    const size = (await readFile(path)).length;
    db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path) VALUES(?,?,'p1',?,?,?,?,?)").run(id, "u1", name, mediaType, size, "0".repeat(64), `u1/${name}`);
  }
  const run = async (jobType, input) => {
    const jobId = `job-${Math.random().toString(16).slice(2)}`;
    db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,input_json) VALUES(?,?,'p1',?,'running',?)").run(jobId, "u1", jobType, json(input));
    const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
    const result = await executeMediaJob({ db, job, mediaRoot });
    const out = result.outputAsset;
    return { ...result, path: out ? join(mediaRoot, db.prepare("SELECT storage_path FROM assets WHERE id=?").get(out.id).storage_path) : null };
  };
  return { db, mediaRoot, register, run };
}

const VIDEO_WITH_AUDIO = ["-f", "lavfi", "-i", "testsrc=s=320x240:r=25:d=4", "-f", "lavfi", "-i", "sine=f=440:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"];
const VIDEO_SILENT = ["-f", "lavfi", "-i", "color=c=black:s=320x240:r=25:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p"];

test("pure helpers: tempo chains stay in range and specs validate", () => {
  for (const factor of [0.25, 0.4, 1, 1.5, 3, 4]) {
    const stages = atempoChain(factor).split(",").map(part => Number(part.split("=")[1]));
    assert.ok(stages.every(stage => stage >= 0.5 && stage <= 2), `${factor}: ${stages}`);
    assert.ok(Math.abs(stages.reduce((a, b) => a * b, 1) - factor) < 1e-4);
  }
  const facts = { durationSeconds: 4, hasAudio: true, hasVideo: true, width: 320, height: 240 };
  assert.throws(() => buildFinishingArgs({ jobType: "media.speed", input: { factor: 9 }, sourcePath: "a", outputBase: "o", kind: "video", facts }), { code: "INVALID_MEDIA_OPTIONS" });
  assert.throws(() => buildFinishingArgs({ jobType: "media.motion", input: {}, sourcePath: "a", outputBase: "o", kind: "video", facts }), { code: "UNSUPPORTED_MEDIA_TYPE" });
  assert.throws(() => buildFinishingArgs({ jobType: "media.fade", input: { fadeIn: 3, fadeOut: 3 }, sourcePath: "a", outputBase: "o", kind: "video", facts }), { code: "INVALID_MEDIA_OPTIONS" });
  assert.throws(() => buildFinishingArgs({ jobType: "media.motion", input: { seconds: 31 }, sourcePath: "a", outputBase: "o", kind: "image", facts }), { code: "INVALID_MEDIA_OPTIONS" });
  assert.ok(Object.values(FINISHING_OPERATIONS).every(op => op.label && op.media.length && Array.isArray(op.params)));
});

test("speed change halves a video and keeps its audio", real, async () => {
  const h = await harness();
  await h.register("v1", "clip.mp4", "video/mp4", VIDEO_WITH_AUDIO);
  const out = await h.run("media.speed", { sourceAssetId: "v1", factor: 2 });
  const facts = probe(out.path);
  assert.ok(Math.abs(facts.durationSeconds - 2) < 0.3, `duration ${facts.durationSeconds}`);
  assert.equal(facts.hasAudio, true);
  assert.equal(h.db.prepare("SELECT derivative_of FROM assets WHERE id=?").get(out.outputAsset.id).derivative_of, "v1");
});

test("speed change on audio slows it down and writes WAV", real, async () => {
  const h = await harness();
  await h.register("a1", "tone.wav", "audio/wav", ["-f", "lavfi", "-i", "sine=f=330:d=2"]);
  const out = await h.run("media.speed", { sourceAssetId: "a1", factor: 0.5 });
  assert.equal(out.outputAsset.mediaType, "audio/wav");
  assert.ok(Math.abs(probe(out.path).durationSeconds - 4) < 0.3);
});

test("fade works on silent and sounding video and rejects over-long fades", real, async () => {
  const h = await harness();
  await h.register("v1", "clip.mp4", "video/mp4", VIDEO_WITH_AUDIO);
  await h.register("v2", "silent.mp4", "video/mp4", VIDEO_SILENT);
  const withAudio = await h.run("media.fade", { sourceAssetId: "v1", fadeIn: 1, fadeOut: 1 });
  assert.equal(probe(withAudio.path).hasAudio, true);
  const silent = await h.run("media.fade", { sourceAssetId: "v2", fadeIn: 0.5, fadeOut: 0 });
  assert.equal(probe(silent.path).hasAudio, false);
  await assert.rejects(() => h.run("media.fade", { sourceAssetId: "v1", fadeIn: 3, fadeOut: 3 }), { code: "INVALID_MEDIA_OPTIONS" });
});

test("a still image becomes a camera-move clip at the requested frame", real, async () => {
  const h = await harness();
  await h.register("i1", "still.png", "image/png", ["-f", "lavfi", "-i", "testsrc=s=640x360", "-frames:v", "1"]);
  for (const preset of ["zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up", "pan-down"]) {
    const out = await h.run("media.motion", { sourceAssetId: "i1", preset, seconds: 2, fps: 24, aspect: "9:16" });
    const facts = probe(out.path);
    assert.equal(facts.width, 720, preset);
    assert.equal(facts.height, 1280, preset);
    assert.ok(Math.abs(facts.durationSeconds - 2) < 0.2, `${preset} ${facts.durationSeconds}`);
    assert.equal(facts.hasAudio, false);
  }
});

test("silence trimming shortens spoken audio", real, async () => {
  const h = await harness();
  await h.register("a1", "speech.wav", "audio/wav", ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1.5", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=1", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1.5", "-f", "lavfi", "-i", "sine=f=660:r=48000:d=1", "-filter_complex", "[0][1][2][3]concat=n=4:v=0:a=1"]);
  const before = probe(join(h.mediaRoot, "u1", "speech.wav")).durationSeconds;
  const out = await h.run("media.silence-trim", { sourceAssetId: "a1", thresholdDb: -40, minSilence: 0.5 });
  const after = probe(out.path).durationSeconds;
  assert.ok(after < before - 1.5, `${before} -> ${after}`);
  assert.ok(after > 1.5, "the spoken parts survive");
});

test("adding audio replaces or ducks under speech and follows the video length", real, async () => {
  const h = await harness();
  await h.register("v1", "clip.mp4", "video/mp4", VIDEO_WITH_AUDIO);
  await h.register("v2", "silent.mp4", "video/mp4", VIDEO_SILENT);
  await h.register("m1", "music.mp3", "audio/mpeg", ["-f", "lavfi", "-i", "sine=f=220:d=9", "-c:a", "libmp3lame"]);
  await h.register("m2", "short.mp3", "audio/mpeg", ["-f", "lavfi", "-i", "sine=f=220:d=1", "-c:a", "libmp3lame"]);
  const replaced = await h.run("media.mux", { sourceAssetId: "v2", audioAssetId: "m1", mode: "replace", gainDb: -6 });
  const facts = probe(replaced.path);
  assert.equal(facts.hasAudio, true);
  assert.ok(Math.abs(facts.durationSeconds - 4) < 0.3, `trimmed to the video: ${facts.durationSeconds}`);
  const mixed = await h.run("media.mux", { sourceAssetId: "v1", audioAssetId: "m1", mode: "mix-with-ducking", gainDb: -8 });
  assert.equal(probe(mixed.path).hasAudio, true);
  assert.ok(Math.abs(probe(mixed.path).durationSeconds - 4) < 0.3);
  const looped = await h.run("media.mux", { sourceAssetId: "v2", audioAssetId: "m2", loopAudio: true });
  assert.ok(Math.abs(probe(looped.path).durationSeconds - 4) < 0.4, `looped: ${probe(looped.path).durationSeconds}`);
});

test("mux validates its second asset", real, async () => {
  const h = await harness();
  await h.register("v1", "clip.mp4", "video/mp4", VIDEO_SILENT);
  await h.register("i1", "logo.png", "image/png", ["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1"]);
  await assert.rejects(() => h.run("media.mux", { sourceAssetId: "v1" }), { code: "SOURCE_ASSET_NOT_FOUND" });
  await assert.rejects(() => h.run("media.mux", { sourceAssetId: "v1", audioAssetId: "i1" }), { code: "UNSUPPORTED_MEDIA_TYPE" });
  await assert.rejects(() => h.run("media.mux", { sourceAssetId: "v1", audioAssetId: "nope" }), { code: "SOURCE_ASSET_NOT_FOUND" });
});

test("a logo lands in the chosen corner and the frame size is unchanged", real, async () => {
  const h = await harness();
  await h.register("v1", "clip.mp4", "video/mp4", VIDEO_SILENT);
  await h.register("i1", "logo.png", "image/png", ["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1"]);
  const out = await h.run("media.brand", { sourceAssetId: "v1", logoAssetId: "i1", position: "bottom-right", widthPercent: 20, opacity: 1, margin: 10 });
  const facts = probe(out.path);
  assert.equal(facts.width, 320);
  assert.equal(facts.height, 240);
  const pixel = (x, y) => {
    const r = spawnSync("ffmpeg", ["-v", "error", "-i", out.path, "-vf", `crop=2:2:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer" });
    return [...r.stdout];
  };
  const [r, g, b] = pixel(320 - 10 - 20, 240 - 10 - 20);
  assert.ok(r > 180 && g < 90 && b < 90, `logo pixel ${r},${g},${b}`);
  const [r2, g2, b2] = pixel(20, 20);
  assert.ok(r2 < 40 && g2 < 40 && b2 < 40, "the opposite corner stays untouched");
});

function seedRun(db, id, graph) {
  const snapshot = JSON.stringify(graph);
  db.prepare("INSERT INTO workflows(id,owner_id,project_id,name,revision,graph_json,graph_hash) VALUES(?,?,'p1',?,1,?,?)").run(`wf-${id}`, "u1", id, snapshot, "f".repeat(64));
  db.prepare("INSERT INTO workflow_runs(id,workflow_id,owner_id,project_id,workflow_revision,snapshot_hash,snapshot_json,status,job_id) VALUES(?,?,?,'p1',1,?,?,'queued',?)").run(id, `wf-${id}`, "u1", "e".repeat(64), snapshot, `job-${id}`);
  for (const node of graph.nodes) db.prepare("INSERT INTO workflow_node_runs(id,run_id,node_id,status) VALUES(?,?,?,'pending')").run(`nr-${id}-${node.id}`, id, node.id);
  db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json) VALUES(?,?,'p1','workflow.execute','running',5,?)").run(`job-${id}`, "u1", json({ runId: id }));
  return db.prepare("SELECT * FROM jobs WHERE id=?").get(`job-${id}`);
}

test("a workflow adds narration to a video and brands the result", real, async () => {
  const h = await harness();
  await h.register("v1", "clip.mp4", "video/mp4", VIDEO_SILENT);
  await h.register("n1", "voice.mp3", "audio/mpeg", ["-f", "lavfi", "-i", "sine=f=300:d=3", "-c:a", "libmp3lame"]);
  await h.register("l1", "logo.png", "image/png", ["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1"]);
  const ref = (id, assetId) => ({ id, kind: "reference", label: id, inputs: [], outputs: [{ id: "asset", type: "asset" }, { id: "media", type: "media" }], config: { assetId } });
  const add = { id: "add", kind: "video.add-audio", label: "Add audio", inputs: [{ id: "video", type: "media", required: true }, { id: "audio", type: "media", required: true }], outputs: [{ id: "video", type: "video" }], config: { mode: "replace" } };
  const brand = { id: "brand", kind: "media.brand", label: "Brand", inputs: [{ id: "video", type: "video", required: true }, { id: "logo", type: "image", required: true }], outputs: [{ id: "video", type: "video" }], config: { position: "top-left" } };
  const graph = { id: "g", projectId: "p1", revision: 1, nodes: [ref("rv", "v1"), ref("rn", "n1"), ref("rl", "l1"), add, brand], edges: [
    { id: "e1", sourceNodeId: "rv", sourcePortId: "asset", targetNodeId: "add", targetPortId: "video" },
    { id: "e2", sourceNodeId: "rn", sourcePortId: "asset", targetNodeId: "add", targetPortId: "audio" },
    { id: "e3", sourceNodeId: "add", sourcePortId: "video", targetNodeId: "brand", targetPortId: "video" },
    { id: "e4", sourceNodeId: "rl", sourcePortId: "asset", targetNodeId: "brand", targetPortId: "logo" }
  ] };
  const job = seedRun(h.db, "run-f", graph);
  const done = await executeWorkflowRun({ db: h.db, job, mediaRoot: h.mediaRoot });
  assert.equal(done.status, "completed");
  const finalAsset = h.db.prepare("SELECT storage_path,media_type FROM assets WHERE id=?").get(done.nodeOutputs.brand.video);
  assert.equal(finalAsset.media_type, "video/mp4");
  const facts = probe(join(h.mediaRoot, finalAsset.storage_path));
  assert.equal(facts.hasAudio, true);
  assert.equal(facts.width, 320);
});

test("factor upscale enlarges video and stills, keeps even sizes, and honours the 8K cap", real, async () => {
  const h = await harness();
  await h.register("v1", "clip.mp4", "video/mp4", VIDEO_WITH_AUDIO);
  await h.register("i1", "photo.png", "image/png", ["-f", "lavfi", "-i", "testsrc=s=321x181", "-frames:v", "1"]);
  const video = await h.run("media.upscale", { sourceAssetId: "v1", scale: 2, sharpen: 40, cleanFirst: true });
  const vf = probe(video.path);
  assert.equal(vf.width, 640);
  assert.equal(vf.height, 480);
  assert.equal(vf.hasAudio, true, "audio survives the upscale");
  const still = await h.run("media.upscale", { sourceAssetId: "i1", scale: 3 });
  assert.equal(still.outputAsset.mediaType, "image/png");
  const sf = probe(still.path);
  assert.equal(sf.width % 2, 0);
  assert.equal(sf.height % 2, 0);
  assert.ok(sf.width >= 960 && sf.width <= 964, `width ${sf.width}`);
  await assert.rejects(() => h.run("media.upscale", { sourceAssetId: "i1", scale: 9 }), { code: "INVALID_MEDIA_OPTIONS" });
});

test("upscale rejects sizes beyond 8K before FFmpeg runs, and legacy width/height still works", real, async () => {
  const h = await harness();
  assert.throws(() => upscaleFilter({ scale: 4 }, { width: 3840, height: 2160 }), { code: "INVALID_MEDIA_OPTIONS" });
  assert.match(upscaleFilter({ scale: 2, sharpen: 50 }, { width: 100, height: 100 }), /unsharp=5:5:0\.75/);
  assert.doesNotMatch(upscaleFilter({ scale: 2 }, null), /unsharp|hqdn3d/);
  await h.register("v1", "clip.mp4", "video/mp4", VIDEO_SILENT);
  const legacy = await h.run("media.upscale", { sourceAssetId: "v1", width: 640, height: 480 });
  assert.equal(probe(legacy.path).width, 640);
  await h.register("i1", "photo.png", "image/png", ["-f", "lavfi", "-i", "testsrc=s=64x64", "-frames:v", "1"]);
  await assert.rejects(() => h.run("media.upscale", { sourceAssetId: "i1", width: 640, height: 480 }), { code: "UNSUPPORTED_MEDIA_TYPE" });
});
