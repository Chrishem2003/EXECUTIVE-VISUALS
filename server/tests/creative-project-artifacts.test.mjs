import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { openDatabase } from "../db.mjs";
import {
  saveCreativeProjectArtifact, listCreativeProjectArtifacts, getCreativeProjectArtifact
} from "../creative-project-artifacts.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ev-creative-artifacts-"));
  const db = openDatabase(join(directory, "test.sqlite"));
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("owner", "owner@example.test");
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("editor", "editor@example.test");
  db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run("project-1", "owner", "Production project");
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  return db;
}
const hash = value => createHash("sha256").update(value).digest("hex");
const input = { title: "Community solar workshop", brief: "Show a real repair process." };
const direction = { title: input.title, creativePromise: "A clear, evidence-led story.", storyBeats: ["Hook", "Process", "Proof"] };
const storyboard = { title: input.title, durationSeconds: 30, scenes: [{ title: "The workshop", shots: [{ id: "shot-1", durationSeconds: 30 }] }] };

test("creative direction and storyboard are saved as immutable, separately versioned project artifacts", async t => {
  const db = await fixture(t);
  const first = saveCreativeProjectArtifact(db, {
    projectId: "project-1", createdBy: "owner", type: "creative_direction",
    input, content: direction, inputHash: hash(JSON.stringify(input)), model: "test-model",
    usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 }
  });
  const second = saveCreativeProjectArtifact(db, {
    projectId: "project-1", createdBy: "editor", type: "creative_direction",
    input: { ...input, style: "documentary" }, content: { ...direction, title: "Revised direction" },
    inputHash: hash(JSON.stringify({ ...input, style: "documentary" }))
  });
  const board = saveCreativeProjectArtifact(db, {
    projectId: "project-1", createdBy: "owner", type: "storyboard",
    input: { creativeDirection: direction }, content: storyboard,
    inputHash: hash("storyboard-input")
  });
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(board.revision, 1);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(first.usage.totalTokens, 50);
  assert.equal(getCreativeProjectArtifact(db, { projectId: "project-1", artifactId: first.id }).content.title, input.title);
  assert.deepEqual(listCreativeProjectArtifacts(db, { projectId: "project-1", type: "creative_direction" }).map(item => item.revision), [2, 1]);
  assert.equal(listCreativeProjectArtifacts(db, { projectId: "project-1", type: "storyboard" })[0].id, board.id);
});

test("artifact history cannot be rewritten or silently deleted", async t => {
  const db = await fixture(t);
  const artifact = saveCreativeProjectArtifact(db, {
    projectId: "project-1", createdBy: "owner", type: "creative_direction",
    input, content: direction, inputHash: hash("input")
  });
  assert.throws(() => db.prepare("UPDATE creative_project_artifacts SET content_json=? WHERE id=?").run("{}", artifact.id), /CREATIVE_PROJECT_ARTIFACTS_IMMUTABLE/);
  assert.throws(() => db.prepare("DELETE FROM creative_project_artifacts WHERE id=?").run(artifact.id), /CREATIVE_PROJECT_ARTIFACTS_IMMUTABLE/);
  assert.equal(getCreativeProjectArtifact(db, { projectId: "project-1", artifactId: artifact.id }).content.title, input.title);
});

test("rejects missing projects, unsupported types, invalid hashes and oversized artifacts", async t => {
  const db = await fixture(t);
  assert.throws(() => saveCreativeProjectArtifact(db, {
    projectId: "missing", createdBy: "owner", type: "creative_direction", input, content: direction, inputHash: hash("x")
  }), error => error.code === "PROJECT_NOT_FOUND");
  assert.throws(() => saveCreativeProjectArtifact(db, {
    projectId: "project-1", createdBy: "owner", type: "billing", input, content: direction, inputHash: hash("x")
  }), error => error.code === "CREATIVE_ARTIFACT_TYPE_INVALID");
  assert.throws(() => saveCreativeProjectArtifact(db, {
    projectId: "project-1", createdBy: "owner", type: "creative_direction", input, content: direction, inputHash: "not-a-hash"
  }), error => error.code === "CREATIVE_ARTIFACT_INPUT_HASH_INVALID");
  assert.throws(() => saveCreativeProjectArtifact(db, {
    projectId: "project-1", createdBy: "owner", type: "storyboard", input, content: { text: "x".repeat(530000) }, inputHash: hash("x")
  }), error => error.code === "CREATIVE_ARTIFACT_TOO_LARGE");
});

test("project-scoped lookup never returns an artifact through another project ID", async t => {
  const db = await fixture(t);
  const artifact = saveCreativeProjectArtifact(db, {
    projectId: "project-1", createdBy: "owner", type: "storyboard", input, content: storyboard, inputHash: hash("x")
  });
  assert.equal(getCreativeProjectArtifact(db, { projectId: "different-project", artifactId: artifact.id }), null);
  assert.throws(() => listCreativeProjectArtifacts(db, { projectId: "project-1", type: "unknown" }), error => error.code === "CREATIVE_ARTIFACT_TYPE_INVALID");
});
