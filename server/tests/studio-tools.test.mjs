import test from "node:test";
import assert from "node:assert/strict";
import { breakdownScript } from "../../src/core/script-breakdown.ts";
import { coachPrompt, applySuggestions } from "../../src/core/prompt-coach.ts";
import { fitFrame, fitAllTargets, FRAME_TARGETS } from "../../src/core/frame-fit.ts";

const SCRIPT = `EXT. DESERT ROAD - NOON
A lone rider walks toward the horizon. The sun is blazing.
Close on her hands gripping the reins.

INT. CANDLELIT TENT - NIGHT
She says nothing. Silence fills the tent.`;

test("script breakdown makes shots, keeps scene headings and fills camera fields", () => {
  const r = breakdownScript(SCRIPT);
  assert.ok(r.shots.length >= 3);
  assert.match(r.shots[0].scene, /DESERT ROAD/);
  assert.match(r.shots.at(-1).scene, /CANDLELIT TENT/);
  assert.equal(r.totalSeconds, r.shots.reduce((n, s) => n + s.duration, 0));
  for (const s of r.shots) {
    assert.ok(Number.isInteger(s.duration) && s.duration >= 2 && s.duration <= 8);
    assert.ok(s.camera && s.lens && s.movement && s.lighting);
  }
  assert.ok(r.shots[0].presetIds.includes("hard-noon-contrast"));
  assert.ok(r.shots.some(s => s.presetIds.includes("close-detail")));
});

test("script breakdown handles empty, heading-only, long and oversized input", () => {
  assert.equal(breakdownScript("   ").shots.length, 0);
  assert.match(breakdownScript("").warnings[0], /Paste/);
  assert.match(breakdownScript("INT. ROOM - DAY").warnings[0], /No action/);
  const many = Array.from({ length: 40 }, (_, i) => "Person number " + i + " walks across the quiet street.").join(" ");
  const r = breakdownScript(many, { maxShots: 10 });
  assert.equal(r.shots.length, 10);
  assert.ok(r.warnings.some(w => /first 10/.test(w)));
  const huge = breakdownScript("A person walks the street. ".repeat(2000));
  assert.ok(huge.warnings.some(w => /longer than/.test(w)));
  assert.equal(breakdownScript(null).shots.length, 0);
});

test("tiny fragments merge into their neighbour instead of becoming shots", () => {
  const r = breakdownScript("A rider crosses the open valley at dawn. Slowly. Wind moves the grass.");
  assert.equal(r.shots.length, 2);
});

test("prompt coach scores weak, fair and strong prompts and handles empty input", () => {
  assert.equal(coachPrompt("").score, 0);
  assert.equal(coachPrompt("").suggestedIds.length, 0);
  const weak = coachPrompt("dog");
  assert.equal(weak.level, "weak");
  const strong = coachPrompt("A close-up of a woman in a sunlit workshop, soft studio lighting, cinematic documentary look, 85mm lens", "image");
  assert.equal(strong.level, "strong");
  assert.ok(strong.score > weak.score);
});

test("video mode adds a movement check and suggestions never remove the user's text", () => {
  const image = coachPrompt("a red car on a coastal road at sunset", "image");
  const video = coachPrompt("a red car on a coastal road at sunset", "video");
  assert.ok(!image.checks.some(c => c.id === "motion"));
  assert.ok(video.checks.some(c => c.id === "motion" && !c.ok));
  assert.ok(video.suggestedIds.includes("slow-push-in"));
  const out = applySuggestions("a red car on a coastal road at sunset", video);
  assert.ok(out.prompt.includes("a red car on a coastal road at sunset"));
});

test("negative phrasing and overlong prompts are flagged", () => {
  assert.equal(coachPrompt("a cat with no collar on a sofa in a bright room").checks.find(c => c.id === "positive").ok, false);
  assert.equal(coachPrompt("word ".repeat(130)).checks.find(c => c.id === "brevity").ok, false);
});

test("frame fit crops a landscape source to vertical around the focus point", () => {
  const r = fitFrame({ srcWidth: 1920, srcHeight: 1080, target: "vertical-9x16", focusX: 0.5 });
  assert.equal(r.ok, true);
  assert.equal(r.crop.height, 1080);
  assert.equal(r.crop.width, 606);
  assert.equal(r.crop.x, 657);
  assert.match(r.ffmpegFilter, /^crop=606:1080:657:0,scale=1080:1920/);
  assert.ok(r.keptPercent < 50);
  assert.ok(r.notes.some(n => /focus/.test(n)));
});

test("frame fit clamps the crop to the frame edges and keeps same-shape sources whole", () => {
  const left = fitFrame({ srcWidth: 1920, srcHeight: 1080, target: "square-1x1", focusX: 0 });
  assert.equal(left.crop.x, 0);
  const right = fitFrame({ srcWidth: 1920, srcHeight: 1080, target: "square-1x1", focusX: 1 });
  assert.equal(right.crop.x + right.crop.width, 1920);
  const same = fitFrame({ srcWidth: 1920, srcHeight: 1080, target: "landscape-16x9" });
  assert.equal(same.keptPercent, 100);
});

test("frame fit crops a vertical source to landscape using the vertical focus", () => {
  const r = fitFrame({ srcWidth: 1080, srcHeight: 1920, target: "landscape-16x9", focusY: 0.2 });
  assert.equal(r.crop.width, 1080);
  assert.ok(r.crop.y >= 0 && r.crop.y + r.crop.height <= 1920);
});

test("letterbox mode keeps the whole frame and rejects bad input", () => {
  const r = fitFrame({ srcWidth: 1920, srcHeight: 1080, target: "vertical-9x16", mode: "letterbox" });
  assert.equal(r.keptPercent, 100);
  assert.match(r.ffmpegFilter, /pad=1080:1920/);
  assert.equal(fitFrame({ srcWidth: 10, srcHeight: 1080, target: "square-1x1" }).ok, false);
  assert.equal(fitFrame({ srcWidth: 1920, srcHeight: 1080, target: "nope" }).ok, false);
  assert.equal(fitFrame({ srcWidth: 1920, srcHeight: 1080, target: "square-1x1", focusX: 2 }).ok, false);
  assert.equal(fitFrame({ srcWidth: 1920.5, srcHeight: 1080, target: "square-1x1" }).ok, false);
});

test("fitAllTargets returns one valid result per target with even crop sizes", () => {
  const all = fitAllTargets(3840, 2160);
  assert.equal(all.length, FRAME_TARGETS.length);
  for (const r of all) {
    assert.equal(r.ok, true);
    assert.equal(r.crop.width % 2, 0);
    assert.equal(r.crop.height % 2, 0);
  }
});
