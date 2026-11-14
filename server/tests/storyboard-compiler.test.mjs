import test from "node:test";
import assert from "node:assert/strict";
import { generateStoryboard, normalizeStoryboardInput } from "../storyboard-compiler.mjs";

const direction = {
  title: "A workshop turns waste into useful energy",
  creativePromise: "Show a practical transformation that viewers can inspect.",
  storyBeats: ["The problem", "The people", "The process", "The proof", "The invitation"],
  visualGrammar: ["Warm daylight", "Precise close-ups", "Human-scale coverage"],
  soundIdentity: ["Authentic workshop ambience", "Clear dialogue"],
  proofAndTrustChecks: ["Verify product claims", "Confirm participant permissions"]
};
const characters = [{ id: "character-ada", name: "Ada", description: "Workshop engineer", appearance: "Short natural hair", wardrobe: "Blue work jacket", voice: "Calm and precise" }];
const input = {
  creativeDirection: direction,
  targetDurationSeconds: 30,
  aspectRatio: "9:16",
  frameRate: 30,
  constraints: "No unsupported performance claims.",
  characters
};
const shot = (durationSeconds, name, characterId = null) => ({
  shotType: "Detail",
  framing: "Medium close-up",
  angle: "Eye level",
  movement: "Slow push-in",
  lens: "50mm",
  action: "Show the work clearly and hold long enough to understand the action.",
  dialogue: "",
  narration: "",
  visualPrompt: "A documentary-style workshop image with warm daylight, precise material detail and an uncluttered composition.",
  motionPrompt: "A measured camera move follows the subject's hands without changing the product geometry.",
  negativePrompt: "No invented logos, labels or performance numbers.",
  lighting: "Soft natural side light",
  soundCue: "Authentic tool sounds",
  continuityIn: "Subject enters from frame left.",
  continuityOut: "Hold on the finished component.",
  proofReference: "Workshop demonstration; verify the result before publication.",
  transitionOut: "cut",
  durationSeconds,
  characterRefs: [{ name, characterId, role: "Workshop lead", action: "Demonstrates the process", continuityNotes: "Keep wardrobe and appearance consistent." }]
});
const modelOutput = {
  logline: "Follow one component through a real workshop process, then invite viewers to verify the result.",
  globalContinuityRules: ["Keep the workshop layout consistent", "Preserve the product's real shape and labels", "Keep the same wardrobe and screen direction"],
  characterSuggestions: [{
    fictional: true, name: "Mika", role: "Apprentice technician",
    description: "A fictional apprentice learning the repair process.",
    appearance: "Young adult with close-cropped hair and safety glasses",
    wardrobe: "Plain charcoal work shirt", voiceDirection: "Curious, direct and natural",
    continuityRules: ["Keep safety glasses on during machine operation", "Maintain the same shirt and hairstyle"]
  }],
  scenes: [
    {
      title: "The workshop problem", slugline: "INT. WORKSHOP - DAY",
      purpose: "Establish the material challenge and the people solving it.",
      storyBeat: "The problem", location: "Workshop floor", timeOfDay: "Day",
      shots: [shot(10, "Ada", "character-ada"), shot(10, "Mika")]
    },
    {
      title: "A visible result", slugline: "INT. WORKSHOP - LATER",
      purpose: "Show the finished work and make the proof check visible.",
      storyBeat: "The proof", location: "Inspection bench", timeOfDay: "Day",
      shots: [shot(10, "Ada", "character-ada")]
    }
  ]
};

test("compiles a structured editable storyboard with scene, shot and character lineage", async () => {
  let request;
  const result = await generateStoryboard({
    input,
    now: () => "2026-11-05T06:30:00.000Z",
    generateText: async args => {
      request = args;
      return { text: JSON.stringify(modelOutput), model: "local-storyboard-model", usage: { promptTokens: 300, completionTokens: 900, totalTokens: 1200 } };
    }
  });
  assert.equal(request.temperature, 0.3);
  assert.equal(request.maxTokens, 4096);
  assert.match(request.systemPrompt, /untrusted data/);
  assert.match(request.systemPrompt, /do not generate images or video/);
  assert.match(request.prompt, /character-ada/);
  assert.equal(result.storyboard.source, "model");
  assert.ok(result.storyboard.id);
  assert.equal(result.storyboard.model, "local-storyboard-model");
  assert.equal(result.storyboard.scenes.length, 2);
  assert.equal(result.storyboard.scenes[0].shots.length, 2);
  assert.equal(result.storyboard.durationSeconds, 30);
  assert.equal(result.storyboard.scenes[0].durationSeconds, 20);
  assert.equal(result.storyboard.scenes[0].shots[0].characterRefs[0].characterId, "character-ada");
  assert.equal(result.storyboard.scenes[0].shots[1].characterRefs[0].name, "Mika");
  assert.ok(result.storyboard.scenes[0].id);
  assert.ok(result.storyboard.scenes[0].shots[0].id);
  assert.ok(result.storyboard.characterSuggestions[0].id);
  assert.equal(result.storyboard.generatedAt, "2026-11-05T06:30:00.000Z");
  assert.match(result.storyboard.inputHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.usage, { promptTokens: 300, completionTokens: 900, totalTokens: 1200 });
});

test("rejects incomplete direction and invalid runtime before calling the model", async () => {
  let calls = 0;
  await assert.rejects(() => generateStoryboard({ input: { ...input, creativeDirection: { title: "Only title" } }, generateText: async () => { calls++; return {}; } }), error => error.code === "STORYBOARD_DIRECTION_INVALID");
  await assert.rejects(() => generateStoryboard({ input: { ...input, targetDurationSeconds: 0 }, generateText: async () => { calls++; return {}; } }), error => error.code === "STORYBOARD_INPUT_INVALID");
  assert.equal(calls, 0);
});

test("rejects malformed output, invalid transitions and non-matching character IDs", async () => {
  await assert.rejects(() => generateStoryboard({ input, generateText: async () => ({ text: "not JSON" }) }), error => error.code === "STORYBOARD_OUTPUT_INVALID");
  const badCharacter = structuredClone(modelOutput);
  badCharacter.scenes[0].shots[0].characterRefs[0].characterId = "someone-elses-character";
  await assert.rejects(() => generateStoryboard({ input, generateText: async () => ({ text: JSON.stringify(badCharacter) }) }), error => error.code === "STORYBOARD_OUTPUT_INVALID");
  const badTransition = structuredClone(modelOutput);
  badTransition.scenes[0].shots[0].transitionOut = "brand_magic";
  await assert.rejects(() => generateStoryboard({ input, generateText: async () => ({ text: JSON.stringify(badTransition) }) }), error => error.code === "STORYBOARD_OUTPUT_INVALID");
});

test("rejects duration drift outside the five-percent storyboard runtime tolerance", async () => {
  const drift = structuredClone(modelOutput);
  drift.scenes[1].shots[0].durationSeconds = 20;
  await assert.rejects(() => generateStoryboard({ input, generateText: async () => ({ text: JSON.stringify(drift) }) }), error => error.code === "STORYBOARD_DURATION_MISMATCH");
});

test("enforces supported aspect ratios and unique supplied character IDs", () => {
  assert.throws(() => normalizeStoryboardInput({ ...input, aspectRatio: "2.39:1" }), error => error.code === "STORYBOARD_INPUT_INVALID");
  assert.throws(() => normalizeStoryboardInput({ ...input, characters: [characters[0], characters[0]] }), error => error.code === "STORYBOARD_INPUT_INVALID");
});
