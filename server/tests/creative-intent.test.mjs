import test from "node:test";
import assert from "node:assert/strict";
import { compileCreativeIntent, formatCreativeIntent } from "../../src/core/creative-intent.ts";

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
