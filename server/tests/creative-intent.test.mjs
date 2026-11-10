import test from "node:test";
import assert from "node:assert/strict";
import { compileCreativeIntent, formatCreativeIntent, compileCreativeStoryboard, resolveCreativeDurationSeconds } from "../../src/core/creative-intent.ts";

const base = {
  title: "A Different Tomorrow",
  brief: "A community turns discarded plastic into useful building materials.",
  audience: "Young African entrepreneurs",
  channel: "YouTube and TikTok",
  style: "Cinematic documentary",
  duration: "90 seconds",
  desiredFeeling: "possibility and agency",
  differentiator: "Follow one discarded bottle through a complete local transformation",
  proof: "Show the workshop process and measured output",
  callToAction: "Visit a local collection point",
  visualSignature: "Macro texture match-cuts from waste to finished product",
  soundSignature: "A three-note motif built from workshop sounds",
  constraints: "Obtain location and participant releases; captions required"
};

test("compiles a differentiated creative direction into an editable plan", () => {
  const plan = compileCreativeIntent(base);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.planningOnly, true);
  assert.equal(plan.title, base.title);
  assert.equal(plan.completenessScore, 100);
  assert.equal(plan.completenessLabel, "production-ready brief");
  assert.ok(plan.hookAngles.some(value => value.includes(base.differentiator)));
  assert.ok(plan.visualGrammar.some(value => value.includes(base.visualSignature)));
  assert.ok(plan.soundIdentity.some(value => value.includes(base.soundSignature)));
  assert.ok(plan.distributionCuts.some(value => value.includes("Silent-first")));
  assert.ok(plan.proofAndTrustChecks.some(value => value.includes(base.proof)));
});

test("flags missing differentiators, proof and production direction without inventing facts", () => {
  const plan = compileCreativeIntent({ ...base, differentiator: "", proof: "", visualSignature: "", soundSignature: "", callToAction: "", constraints: "" });
  assert.ok(plan.completenessScore < 85);
  assert.ok(plan.missingInputs.length >= 5);
  assert.ok(plan.preflight.some(value => value.startsWith("BLOCKER")));
  assert.ok(plan.proofAndTrustChecks.some(value => value.includes("No proof supplied")));
  assert.equal(plan.planningOnly, true);
});

test("rejects an empty brief and formats a readable blueprint", () => {
  assert.throws(() => compileCreativeIntent({ ...base, brief: "  " }), /title and core brief/);
  const output = formatCreativeIntent(compileCreativeIntent(base));
  assert.match(output, /CREATIVE DNA/);
  assert.match(output, /EMOTIONAL JOURNEY/);
  assert.match(output, /PROOF, RIGHTS & TRUST/);
  assert.match(output, /No model inference/);
});

test("compiles Creative DNA into a timed, editable storyboard without submitting generation",()=>{
 const plan=compileCreativeIntent(base);
 const storyboard=compileCreativeStoryboard(plan,90,8);
 assert.equal(storyboard.schemaVersion,1);
 assert.equal(storyboard.sceneCount,6);
 assert.equal(storyboard.durationSeconds,90);
 assert.equal(storyboard.scenes.reduce((sum,scene)=>sum+scene.durationSeconds,0),90);
 assert.equal(storyboard.scenes.reduce((sum,scene)=>sum+scene.shots.reduce((n,shot)=>n+shot.durationSeconds,0),0),90);
 assert.ok(storyboard.scenes.every(scene=>scene.shots.length>0&&scene.shots.every(shot=>shot.durationSeconds>=1&&shot.durationSeconds<=30)));
 assert.equal(storyboard.scenes[3].shots[0].role,"proof");
 assert.ok(storyboard.scenes[3].proofNote.includes(base.proof));
 assert.equal(storyboard.planningOnly,true);
 assert.equal(storyboard.generationState,"not_submitted");
 assert.equal(storyboard.providerSubmitted,false);
});
test("preserves missing-proof warnings and resolves duration presets conservatively",()=>{
 const plan=compileCreativeIntent({...base,proof:""});
 const storyboard=compileCreativeStoryboard(plan,180,10);
 assert.ok(storyboard.missingInputs.length>0);
 assert.ok(storyboard.scenes[3].proofNote.includes("No proof supplied"));
 assert.equal(resolveCreativeDurationSeconds("15 seconds"),15);
 assert.equal(resolveCreativeDurationSeconds("5–10 minutes"),300);
 assert.equal(resolveCreativeDurationSeconds("10–30 minutes"),600);
 assert.throws(()=>resolveCreativeDurationSeconds("2 hours"),/supported/);
});
test("rejects invalid storyboard runtimes and shot targets",()=>{
 const plan=compileCreativeIntent(base);
 assert.throws(()=>compileCreativeStoryboard(plan,14,8),/15–1800/);
 assert.throws(()=>compileCreativeStoryboard(plan,1801,8),/15–1800/);
 assert.throws(()=>compileCreativeStoryboard(plan,90,31),/4–30/);
 assert.throws(()=>compileCreativeStoryboard({...plan,storyBeats:[]},90,8),/six ordered/);
});
