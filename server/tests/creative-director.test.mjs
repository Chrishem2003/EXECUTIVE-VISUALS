import test from "node:test";
import assert from "node:assert/strict";
import { generateCreativeDirection, normalizeCreativeDirectorInput } from "../creative-director.mjs";

const input = {
  title: "Community clean-energy film",
  brief: "A local cooperative converts discarded material into reliable solar equipment.",
  audience: "Small business owners",
  channel: "TikTok + YouTube",
  style: "Cinematic documentary",
  duration: "60 seconds",
  desiredFeeling: "Confidence and possibility",
  differentiator: "Show the repair and reuse process, not just finished products",
  proof: "A verified workshop demonstration is available",
  callToAction: "Visit the cooperative",
  visualSignature: "Warm daylight and precise workshop details",
  soundSignature: "Tools, human voices and a restrained rhythmic bed",
  constraints: "Vertical first; verify all product claims and permissions"
};

const modelPlan = {
  creativePromise: "A practical local energy story grounded in visible workmanship.",
  audienceContract: "Small business owners receive a credible, actionable view of the cooperative.",
  strategicThesis: "Earn trust by showing the process before presenting the promise.",
  emotionalJourney: ["Curiosity", "Recognition", "Proof", "Confidence"],
  hookAngles: ["Open on a repair in progress", "Reveal a material transformation", "Start with a business owner's question"],
  visualGrammar: ["Macro workshop details", "Human-scale process coverage", "Consistent warm daylight"],
  soundIdentity: ["Use authentic workshop ambience", "Keep dialogue intelligible", "Use restrained music only to support transitions"],
  storyBeats: ["Open on a problem", "Introduce the cooperative", "Show the process", "Verify the result", "Invite a visit"],
  productionPillars: ["Show, do not overclaim", "Protect product truth", "Keep the human stakes visible"],
  distributionCuts: ["60-second vertical master", "30-second proof cut", "15-second hook cut"],
  proofAndTrustChecks: ["Verify product specifications", "Confirm demonstration footage is authentic", "Confirm music and participant permissions"],
  assumptions: ["The cooperative can provide access to its workshop"],
  openQuestions: ["Which verified product result can be shown?"],
  riskFlags: ["Do not imply output or savings without supporting evidence"],
  creativeRoutes: [
    { name: "The workshop proof", angle: "Follow one material through the transformation process.", tradeoff: "High credibility, slower opening." },
    { name: "The business decision", angle: "Frame the story around a buyer's practical question.", tradeoff: "Fast audience relevance, less process detail." }
  ]
};

test("model-backed Creative Director returns a validated editable plan and provenance", async () => {
  let request;
  const result = await generateCreativeDirection({
    input,
    now: () => "2026-11-05T06:00:00.000Z",
    generateText: async args => {
      request = args;
      return { text: JSON.stringify(modelPlan), model: "local-test-model", usage: { promptTokens: 120, completionTokens: 400, totalTokens: 520 } };
    }
  });
  assert.equal(request.temperature, 0.35);
  assert.equal(request.maxTokens, 2600);
  assert.match(request.systemPrompt, /untrusted creative input/);
  assert.match(request.systemPrompt, /Do not generate media/);
  assert.match(request.prompt, /Community clean-energy film/);
  assert.equal(result.plan.source, "model");
  assert.equal(result.plan.model, "local-test-model");
  assert.equal(result.plan.title, input.title);
  assert.equal(result.plan.creativeRoutes.length, 2);
  assert.equal(result.plan.storyBeats.length, 5);
  assert.equal(result.plan.generatedAt, "2026-11-05T06:00:00.000Z");
  assert.match(result.plan.inputHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.usage, { promptTokens: 120, completionTokens: 400, totalTokens: 520 });
  assert.equal(result.model, "local-test-model");
});

test("accepts a fenced JSON response but strips unrecognized model fields", async () => {
  const result = await generateCreativeDirection({
    input,
    generateText: async () => ({ text: "Here is the direction:\n```json\n" + JSON.stringify({ ...modelPlan, unexpectedSecret: "discard me" }) + "\n```", model: "test" })
  });
  assert.equal("unexpectedSecret" in result.plan, false);
});

test("rejects empty or oversized briefs before calling the model", async () => {
  let calls = 0;
  await assert.rejects(() => generateCreativeDirection({ input: { ...input, brief: " " }, generateText: async () => { calls++; return {}; } }), error => error.code === "CREATIVE_DIRECTOR_BRIEF_REQUIRED");
  await assert.rejects(() => generateCreativeDirection({ input: { ...input, title: "x".repeat(121) }, generateText: async () => { calls++; return {}; } }), error => error.code === "CREATIVE_DIRECTOR_INPUT_INVALID" || error.code === "CREATIVE_DIRECTOR_BRIEF_REQUIRED");
  assert.equal(calls, 0);
});

test("rejects malformed JSON and incomplete creative direction without returning a partial plan", async () => {
  await assert.rejects(() => generateCreativeDirection({ input, generateText: async () => ({ text: "not JSON" }) }), error => error.code === "CREATIVE_DIRECTOR_OUTPUT_INVALID");
  await assert.rejects(() => generateCreativeDirection({ input, generateText: async () => ({ text: JSON.stringify({ ...modelPlan, storyBeats: ["Only one beat"] }) }) }), error => error.code === "CREATIVE_DIRECTOR_OUTPUT_INVALID");
  await assert.rejects(() => generateCreativeDirection({ input, generateText: async () => ({ text: JSON.stringify({ ...modelPlan, creativeRoutes: [{ name: "Only one", angle: "A", tradeoff: "B" }] }) }) }), error => error.code === "CREATIVE_DIRECTOR_OUTPUT_INVALID");
});

test("requires unique creative route names and distinct list entries", async () => {
  await assert.rejects(() => generateCreativeDirection({ input, generateText: async () => ({ text: JSON.stringify({ ...modelPlan, creativeRoutes: [modelPlan.creativeRoutes[0], { ...modelPlan.creativeRoutes[1], name: modelPlan.creativeRoutes[0].name }] }) }) }), error => error.code === "CREATIVE_DIRECTOR_OUTPUT_INVALID");
  await assert.rejects(() => generateCreativeDirection({ input, generateText: async () => ({ text: JSON.stringify({ ...modelPlan, hookAngles: [modelPlan.hookAngles[0], modelPlan.hookAngles[0], modelPlan.hookAngles[2]] }) }) }), error => error.code === "CREATIVE_DIRECTOR_OUTPUT_INVALID");
});

test("normalizes bounded input fields and rejects non-object input", () => {
  const normalized = normalizeCreativeDirectorInput({ ...input, brief: "  a  \n brief ", constraints: "x".repeat(1000) });
  assert.equal(normalized.brief, "a brief");
  assert.equal(normalized.constraints.length, 1000);
  assert.throws(() => normalizeCreativeDirectorInput({ ...input, constraints: "x".repeat(1001) }), error => error.code === "CREATIVE_DIRECTOR_INPUT_INVALID");
  assert.throws(() => normalizeCreativeDirectorInput(null), error => error.code === "CREATIVE_DIRECTOR_INPUT_INVALID");
});
