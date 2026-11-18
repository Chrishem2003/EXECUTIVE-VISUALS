import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { openDatabase } from "../db.mjs";
import {
  saveCreativeProjectArtifact, listCreativeProjectArtifacts, getCreativeProjectArtifact, appendCreativeProjectArtifactRevision
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


const validStoryboard=(inputHash)=>({
 schemaVersion:1,source:"model",id:"storyboard-1",model:"test-model",generatedAt:"2026-11-18T10:00:00.000Z",
 inputHash,title:"Community solar workshop",logline:"A verifiable story.",targetDurationSeconds:30,durationSeconds:30,
 aspectRatio:"9:16",frameRate:30,globalContinuityRules:["Keep the workshop consistent","Preserve equipment geometry","Maintain screen direction"],
 characterSuggestions:[],scenes:[1,2].map(number=>({
  id:"scene-"+number,number,title:"Scene "+number,slugline:"INT. WORKSHOP - DAY",purpose:"Show the real process",storyBeat:"Proof",
  location:"Workshop",timeOfDay:"Day",durationSeconds:15,shots:[{
   id:"shot-"+number,number:1,shotType:"Detail",framing:"Close-up",angle:"Eye level",movement:"Slow push",lens:"50mm",
   action:"Show the verified step.",dialogue:"",narration:"",visualPrompt:"Workshop detail.",motionPrompt:"Slow movement.",
   negativePrompt:"No invented claims.",lighting:"Soft daylight",soundCue:"Room tone",continuityIn:"Match prior scene.",
   continuityOut:"Hold on the result.",proofReference:"Check source evidence.",transitionOut:"cut",durationSeconds:15,characterRefs:[]
  }]
 }))
});

test("edited storyboard saves as a new immutable revision with parent lineage and validation",async t=>{
 const db=await fixture(t),inputHash=hash("original-storyboard-input");
 const parent=saveCreativeProjectArtifact(db,{projectId:"project-1",createdBy:"owner",type:"storyboard",input:{creativeDirection:direction},content:validStoryboard(inputHash),inputHash,model:"test-model",usage:{totalTokens:120}});
 const edited=validStoryboard(inputHash);edited.scenes[0].shots[0].action="Show the inspected solar controller.";
 const revision=appendCreativeProjectArtifactRevision(db,{projectId:"project-1",artifactId:parent.id,createdBy:"editor",content:edited});
 assert.equal(revision.revision,2);
 assert.equal(revision.type,"storyboard");
 assert.equal(revision.inputHash,parent.inputHash);
 assert.equal(revision.content.scenes[0].shots[0].action,"Show the inspected solar controller.");
 assert.equal(revision.usage.totalTokens,120);
 const noOp=appendCreativeProjectArtifactRevision(db,{projectId:"project-1",artifactId:revision.id,createdBy:"editor",content:edited});
 assert.equal(noOp.unchanged,true);
 assert.equal(noOp.id,revision.id);
 assert.equal(getCreativeProjectArtifact(db,{projectId:"project-1",artifactId:parent.id}).content.scenes[0].shots[0].action,"Show the verified step.");
 assert.deepEqual(listCreativeProjectArtifacts(db,{projectId:"project-1",type:"storyboard"}).map(item=>item.revision),[2,1]);
 const invalid=validStoryboard(inputHash);invalid.scenes[0].shots[0].durationSeconds=90;
 assert.throws(()=>appendCreativeProjectArtifactRevision(db,{projectId:"project-1",artifactId:revision.id,createdBy:"editor",content:invalid}),error=>error.code==="CREATIVE_ARTIFACT_REVISION_INVALID");
 assert.throws(()=>appendCreativeProjectArtifactRevision(db,{projectId:"project-1",artifactId:parent.id,createdBy:"editor",content:{...edited,inputHash:hash("different")}}),error=>error.code==="CREATIVE_ARTIFACT_REVISION_INVALID");
 assert.throws(()=>appendCreativeProjectArtifactRevision(db,{projectId:"different-project",artifactId:parent.id,createdBy:"editor",content:edited}),error=>error.code==="CREATIVE_ARTIFACT_NOT_FOUND");
});
