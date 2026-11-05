import test from "node:test";
import assert from "node:assert/strict";
import { estimateGoogleOmniVideoCost, resolveGoogleOmniActualCost } from "../google-omni-pricing.mjs";
import { estimateVideoGenerationCost } from "../video-generation-cost-estimator.mjs";

const id = "v1_abcdef123456";

test("reserves the full context window and maximum ten-second 720p output", () => {
  const direct = estimateGoogleOmniVideoCost({ durationSeconds: 5, resolution: "720p" });
  const shared = estimateVideoGenerationCost({
    provider: "google", model: "gemini-omni-1.1-flash",
    durationSeconds: 5, resolution: "720p"
  });
  assert.equal(direct.amount, 2.586464);
  assert.equal(shared.amount, 2.586464);
  assert.equal(direct.maxInputTokens, 1048576);
  assert.equal(direct.maxOutputTokens, 57920);
  assert.equal(direct.maxOutputSeconds, 10);
  assert.equal(direct.currency, "USD");
  assert.equal(direct.billable, false);
  assert.equal(direct.settlementEligible, false);
});

test("rejects resolutions without a verified video token price and invalid durations", () => {
  assert.throws(() => estimateGoogleOmniVideoCost({ resolution: "1080p" }),
    error => error.code === "VIDEO_PRICE_UNSUPPORTED_RESOLUTION");
  assert.throws(() => estimateGoogleOmniVideoCost({ durationSeconds: 2 }),
    error => error.code === "VIDEO_PRICE_DURATION_INVALID");
  assert.throws(() => estimateGoogleOmniVideoCost({ durationSeconds: 11 }),
    error => error.code === "VIDEO_PRICE_DURATION_INVALID");
  assert.throws(() => estimateGoogleOmniVideoCost({ model: "veo-preview" }),
    error => error.code === "VIDEO_PRICE_UNVERIFIED");
});

test("settles actual usage from Google interaction token counts", () => {
  const result = resolveGoogleOmniActualCost({
    providerTaskId: id,
    task: { rawInteraction: { usage: { total_input_tokens: 1000, total_output_tokens: 57920, output_tokens_by_modality: [{ modality: "video", tokens: 57920 }] } } }
  });
  assert.equal(result.amount, 1.0151);
  assert.equal(result.currency, "USD");
  assert.equal(result.inputTokens, 1000);
  assert.equal(result.outputTokens, 57920);
  assert.equal(result.videoOutputTokens, 57920);
  assert.equal(result.textOutputTokens, 0);
  assert.equal(result.videoOutputAmount, 1.0136);
  assert.match(result.evidenceReference, new RegExp(id));
});

test("fails closed when authoritative usage metadata is absent or malformed", () => {
  assert.throws(() => resolveGoogleOmniActualCost({ providerTaskId: id, task: {} }),
    error => error.code === "GOOGLE_OMNI_USAGE_EVIDENCE_MISSING");
  assert.throws(() => resolveGoogleOmniActualCost({
    providerTaskId: id, task: { rawInteraction: { usage: { total_input_tokens: -1, total_output_tokens: 3, output_tokens_by_modality: [{ modality: "video", tokens: 3 }] } } }
  }), error => error.code === "GOOGLE_OMNI_USAGE_EVIDENCE_MISSING");
  assert.throws(() => resolveGoogleOmniActualCost({
    providerTaskId: "bad", task: { rawInteraction: { usage: { total_input_tokens: 1, total_output_tokens: 1, output_tokens_by_modality: [{ modality: "video", tokens: 1 }] } } }
  }), error => error.code === "GOOGLE_OMNI_USAGE_EVIDENCE_INVALID");
});

test("prices text and video output at their separate published rates", () => {
  const result = resolveGoogleOmniActualCost({
    providerTaskId: id,
    task: { rawInteraction: { usage: {
      total_input_tokens: 1000,
      total_output_tokens: 110,
      output_tokens_by_modality: [
        { modality: "text", tokens: 100 },
        { modality: "video", tokens: 10 }
      ]
    } } }
  });
  assert.equal(result.textOutputAmount, 0.0009);
  assert.equal(result.videoOutputAmount, 0.000175);
  assert.equal(result.amount, 0.002575);
});

test("fails closed when output modality totals do not reconcile", () => {
  assert.throws(() => resolveGoogleOmniActualCost({
    providerTaskId: id,
    task: { rawInteraction: { usage: {
      total_input_tokens: 1000,
      total_output_tokens: 110,
      output_tokens_by_modality: [{ modality: "video", tokens: 109 }]
    } } }
  }), error => error.code === "GOOGLE_OMNI_USAGE_EVIDENCE_MISSING");
});
