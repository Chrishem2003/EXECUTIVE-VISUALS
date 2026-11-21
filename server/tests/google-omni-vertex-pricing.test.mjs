import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateGoogleOmniVertexVideoCost,
  resolveGoogleOmniVertexActualCost
} from "../google-omni-vertex-usage-pricing.mjs";

const interactionId = "v1_abcdef123456";

test("Vertex Omni 1.2 reserves the documented maximum input and 4K output budget without billing it", () => {
  const quote = estimateGoogleOmniVertexVideoCost();
  assert.equal(quote.model, "gemini-omni-1.2-flash");
  assert.equal(quote.maxInputTokens, 131072);
  assert.equal(quote.maxOutputTokens, 260640);
  assert.equal(quote.amount, 3.324288);
  assert.equal(quote.billable, false);
  assert.equal(quote.settlementEligible, false);
});

test("Vertex Omni 1.2 settles exact input, text and video modality usage", () => {
  const result = resolveGoogleOmniVertexActualCost({
    providerTaskId: interactionId,
    task: { rawInteraction: { usage: {
      total_input_tokens: 1000,
      input_tokens_by_modality: [{ modality: "text", tokens: 800 }, { modality: "image", tokens: 200 }],
      total_output_tokens: 20000,
      output_tokens_by_modality: [{ modality: "text", tokens: 500 }, { modality: "video", tokens: 19500 }]
    } } }
  });
  assert.equal(result.inputAmount, 0.0015);
  assert.equal(result.textOutputAmount, 0.0045);
  assert.equal(result.videoOutputAmount, 0.234);
  assert.equal(result.amount, 0.24);
  assert.equal(result.actualCredits, 24);
  assert.match(result.evidenceReference, /video=19500$/);
});

test("Vertex Omni 1.2 refuses aggregate-only or inconsistent usage", () => {
  assert.throws(() => resolveGoogleOmniVertexActualCost({
    providerTaskId: interactionId,
    task: { rawInteraction: { usage: { total_input_tokens: 1, total_output_tokens: 10 } } }
  }), error => error.code === "GOOGLE_OMNI_VERTEX_USAGE_EVIDENCE_MISSING");
  assert.throws(() => resolveGoogleOmniVertexActualCost({
    providerTaskId: interactionId,
    task: { rawInteraction: { usage: {
      total_input_tokens: 1, total_output_tokens: 10,
      output_tokens_by_modality: [{ modality: "video", tokens: 9 }]
    } } }
  }), error => error.code === "GOOGLE_OMNI_VERTEX_USAGE_EVIDENCE_MISSING");
});

test("Vertex Omni 1.2 rejects unknown priced modalities and model usage beyond published limits", () => {
  assert.throws(() => resolveGoogleOmniVertexActualCost({
    providerTaskId: interactionId,
    task: { rawInteraction: { usage: {
      total_input_tokens: 1, total_output_tokens: 10,
      output_tokens_by_modality: [{ modality: "audio", tokens: 10 }]
    } } }
  }), error => error.code === "GOOGLE_OMNI_VERTEX_USAGE_EVIDENCE_MISSING");
  assert.throws(() => resolveGoogleOmniVertexActualCost({
    providerTaskId: interactionId,
    task: { rawInteraction: { usage: {
      total_input_tokens: 131073, total_output_tokens: 10,
      output_tokens_by_modality: [{ modality: "video", tokens: 10 }]
    } } }
  }), error => error.code === "GOOGLE_OMNI_VERTEX_USAGE_EVIDENCE_MISSING");
});


test("Vertex Omni 1.2 includes thought tokens in billable text reasoning usage", () => {
  const result = resolveGoogleOmniVertexActualCost({
    providerTaskId: interactionId,
    task: { rawInteraction: { usage: {
      total_input_tokens: 10,
      total_output_tokens: 100,
      total_thought_tokens: 50,
      output_tokens_by_modality: [{ modality: "text", tokens: 40 }, { modality: "video", tokens: 60 }]
    } } }
  });
  assert.equal(result.textOutputTokens, 40);
  assert.equal(result.thoughtTokens, 50);
  assert.equal(result.billableTextOutputTokens, 90);
  assert.equal(result.amount, 0.001545);
});

test("Vertex Omni 1.2 refuses output plus thought usage beyond its published output token limit", () => {
  assert.throws(() => resolveGoogleOmniVertexActualCost({
    providerTaskId: interactionId,
    task: { rawInteraction: { usage: {
      total_input_tokens: 1,
      total_output_tokens: 260640,
      total_thought_tokens: 1,
      output_tokens_by_modality: [{ modality: "video", tokens: 260640 }]
    } } }
  }), error => error.code === "GOOGLE_OMNI_VERTEX_USAGE_EVIDENCE_MISSING");
});
