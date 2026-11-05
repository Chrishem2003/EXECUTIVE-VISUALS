import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeCreativeWorkspaceDocument } from "../workspace-documents.mjs";

const direction = {
  schemaVersion: 1, source: "model", model: "local-model", title: "Test film",
  creativePromise: "Show a verifiable process.", audienceContract: "A useful story for viewers.",
  strategicThesis: "Lead with evidence.",
  emotionalJourney: ["Curiosity", "Proof", "Confidence"], hookAngles: ["Open on the work", "Start with a question", "Reveal a detail"],
  visualGrammar: ["Natural light", "Precise close-ups"], soundIdentity: ["Authentic ambience"],
  storyBeats: ["Problem", "Process", "Proof"], productionPillars: ["Evidence first"],
  distributionCuts: ["Vertical master"], proofAndTrustChecks: ["Verify claims"],
  assumptions: [], openQuestions: ["Which claim is approved?"], riskFlags: [],
  creativeRoutes: [{ name: "Process", angle: "Follow the work", tradeoff: "Slower opening" }],
  generatedAt: "2026-11-05T00:00:00.000Z", inputHash: "a".repeat(64)
};
const storyboard = {
  schemaVersion: 1, source: "model", model: "local-model", title: "Test film",
  logline: "A process story.", generatedAt: "2026-11-05T00:00:00.000Z", inputHash: "b".repeat(64),
  targetDurationSeconds: 20, durationSeconds: 20, aspectRatio: "9:16", frameRate: 24,
  globalContinuityRules: ["Keep the set consistent", "Preserve screen direction", "Verify claims"],
  characterSuggestions: [{ id: "character-1", fictional: true, name: "Mika", role: "Apprentice", description: "A fictional character.", appearance: "Short hair", wardrobe: "Work shirt", voiceDirection: "Natural", continuityRules: ["Keep wardrobe consistent"] }],
  scenes: [{ id: "scene-1", number: 1, title: "Opening", slugline: "INT. WORKSHOP - DAY", purpose: "Establish the premise.", storyBeat: "Problem", location: "Workshop", timeOfDay: "Day", durationSeconds: 20, shots: [{ id: "shot-1", number: 1, shotType: "Wide", framing: "Wide", angle: "Eye level", movement: "Static", lens: "24mm", action: "Reveal the workshop.", dialogue: "", narration: "", visualPrompt: "An editable still prompt.", motionPrompt: "An editable motion prompt.", negativePrompt: "No invented marks.", lighting: "Daylight", soundCue: "Room tone", continuityIn: "Start wide.", continuityOut: "Move to bench.", proofReference: "", transitionOut: "cut", durationSeconds: 20, characterRefs: [{ name: "Mika", characterId: null, role: "Apprentice", action: "Enters frame", continuityNotes: "Same wardrobe" }] }] }]
};

test("creative workspace preserves bounded model direction, storyboard and lineage", () => {
  const result = sanitizeCreativeWorkspaceDocument({
    creativeProjects: [{ id: "project-1", name: "Test film", brief: "A short brief", audience: "Viewers", style: "Documentary", created: "2026-11-05", duration: "20 seconds", aspectRatio: "9:16", creativeDNA: { completenessScore: 88 }, modelCreativeDirection: direction, storyboard }]
  });
  const project = result.creativeProjects[0];
  assert.deepEqual(project.modelCreativeDirection, direction);
  assert.deepEqual(project.storyboard, storyboard);
  assert.deepEqual(project.creativeDNA, { completenessScore: 88 });
  assert.equal(project.duration, "20 seconds");
  assert.equal(project.aspectRatio, "9:16");
});

test("creative workspace rejects oversized or excessively nested storyboard artifacts", () => {
  assert.throws(() => sanitizeCreativeWorkspaceDocument({
    creativeProjects: [{ id: "p", name: "Large", storyboard: { text: "x".repeat(7000) } }]
  }), error => error.code === "WORKSPACE_ARTIFACT_INVALID");
  let nested = {}, cursor = nested;
  for (let i = 0; i < 12; i++) { cursor.child = {}; cursor = cursor.child; }
  assert.throws(() => sanitizeCreativeWorkspaceDocument({
    creativeProjects: [{ id: "p", name: "Deep", storyboard: nested }]
  }), error => error.code === "WORKSPACE_ARTIFACT_INVALID");
});

test("creative workspace rejects oversized storyboard artifact payloads", () => {
  const huge = { scenes: Array.from({ length: 100 }, (_, i) => ({ id: "s" + i, text: "x".repeat(6000) })) };
  assert.throws(() => sanitizeCreativeWorkspaceDocument({
    creativeProjects: [{ id: "p", name: "Too large", storyboard: huge }]
  }), error => error.code === "WORKSPACE_ARTIFACT_INVALID" || error.code === "WORKSPACE_ARTIFACT_TOO_LARGE");
});
