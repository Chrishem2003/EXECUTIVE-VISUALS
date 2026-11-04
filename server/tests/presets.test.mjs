import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  PRESETS, CATEGORY_ORDER, SHOT_FIELD_LIMITS,
  getPreset, listPresets, composePrompt, applyPresetToShot, shotToPrompt
} from "../../src/core/presets.ts";

test("catalog is large enough, unique and well-formed", () => {
  assert.ok(PRESETS.length >= 40);
  const ids = new Set();
  for (const p of PRESETS) {
    assert.match(p.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, p.id);
    assert.ok(!ids.has(p.id), "duplicate id " + p.id);
    ids.add(p.id);
    assert.ok(p.name.length >= 3 && p.name.length <= 40, p.id + " name length");
    assert.ok(p.summary.length >= 10 && p.summary.length <= 140, p.id + " summary length");
    assert.ok(p.prompt.length >= 10 && p.prompt.length <= 400, p.id + " prompt length");
    assert.ok(["video", "image", "both"].includes(p.applies), p.id);
  }
  for (const category of CATEGORY_ORDER) assert.ok(PRESETS.filter(p => p.category === category).length >= 6, category);
});

test("each category fills the shot fields it owns and respects server limits", () => {
  for (const p of PRESETS) {
    if (p.category === "camera") {
      assert.equal(p.applies, "video", p.id);
      assert.ok(p.movement && p.movement.length <= SHOT_FIELD_LIMITS.movement, p.id);
      assert.ok(p.seconds && p.seconds.min >= 1 && p.seconds.max >= p.seconds.min && p.seconds.max <= 15, p.id);
    }
    if (p.category === "framing") {
      assert.ok(p.camera && p.camera.length <= SHOT_FIELD_LIMITS.camera, p.id);
      assert.ok(p.lens && p.lens.length <= SHOT_FIELD_LIMITS.lens, p.id);
    }
    if (p.category === "light") assert.ok(p.lighting && p.lighting.length <= SHOT_FIELD_LIMITS.lighting, p.id);
  }
});

test("new product files contain no third-party product or brand names", () => {
  const banned = /\b(higgsfield|capcut|runway|kling|veo|sora|seedance|hailuo|luma|pika|descript|canva|adobe|premiere|davinci|vidu|midjourney|invideo|veed|kapwing|filmora|vizard|opusclip|synthesia|heygen)\b/i;
  const files = [
    "src/core/presets.ts",
    "src/core/model-catalog.ts",
    "src/platform/preset-workspace.ts",
    "server/model-catalog.mjs",
    "docs/PATTERN-STUDY.md"
  ].filter(existsSync);
  assert.ok(files.includes("src/core/presets.ts"));
  for (const file of files) {
    const hit = readFileSync(file, "utf8").match(banned);
    assert.equal(hit, null, file + " mentions " + (hit && hit[0]));
  }
});

test("listPresets filters by category, target and text", () => {
  const camera = listPresets({ category: "camera" });
  assert.ok(camera.length >= 15 && camera.every(p => p.category === "camera"));
  const stills = listPresets({ target: "image" });
  assert.ok(stills.length > 0 && stills.every(p => p.applies !== "video"));
  assert.ok(!stills.some(p => p.category === "camera"));
  const found = listPresets({ query: "  GOLDEN " });
  assert.ok(found.some(p => p.id === "warm-golden-hour"));
  assert.deepEqual(listPresets({ query: "zzzz-no-match" }), []);
  assert.equal(listPresets({ category: "all" }).length, PRESETS.length);
});

test("composePrompt orders by category, de-duplicates and reports unknown ids", () => {
  const { prompt, unknown, dropped } = composePrompt("A runner at dawn", ["film-grain-35", "slow-push-in", "warm-golden-hour", "slow-push-in", "nope"]);
  assert.deepEqual(unknown, ["nope"]);
  assert.deepEqual(dropped, []);
  assert.ok(prompt.startsWith("A runner at dawn, slow, smooth push-in"));
  assert.ok(prompt.indexOf("push-in") < prompt.indexOf("golden hour") && prompt.indexOf("golden hour") < prompt.indexOf("35mm film"));
  assert.equal(prompt.match(/push-in/g).length, 1);
  assert.equal(composePrompt("", ["snap-zoom"]).prompt, getPreset("snap-zoom").prompt);
});

test("composePrompt drops whole fragments rather than cutting them", () => {
  const base = "x".repeat(50);
  const { prompt, dropped } = composePrompt(base, ["slow-push-in", "film-grain-35"], { maxLength: 150 });
  assert.ok(prompt.length <= 150);
  assert.ok(dropped.length >= 1);
  for (const id of dropped) assert.ok(!prompt.includes(getPreset(id).prompt));
});

test("applyPresetToShot writes only the fields each category owns", () => {
  const shot = { lighting: "Soft key" };
  assert.deepEqual(Object.keys(applyPresetToShot(shot, getPreset("orbit-sweep"))), ["movement"]);
  assert.deepEqual(Object.keys(applyPresetToShot(shot, getPreset("portrait-tele"))).sort(), ["camera", "lens"]);
  assert.deepEqual(Object.keys(applyPresetToShot(shot, getPreset("neon-night"))), ["lighting"]);
});

test("look presets append once and replace the previous look", () => {
  const first = applyPresetToShot({ lighting: "Soft key" }, getPreset("film-grain-35"));
  assert.equal(first.lighting, "Soft key · Look: Film Grain 35");
  assert.deepEqual(applyPresetToShot({ lighting: first.lighting }, getPreset("film-grain-35")), {});
  const swapped = applyPresetToShot({ lighting: first.lighting }, getPreset("retro-tape"));
  assert.equal(swapped.lighting, "Soft key · Look: Retro Tape");
  assert.equal(applyPresetToShot({ lighting: "" }, getPreset("pastel-dream")).lighting, "Look: Pastel Dream");
});

test("shotToPrompt builds a single readable prompt", () => {
  const text = shotToPrompt({ scene: "Market at dawn", action: "A vendor lays out fruit", camera: "Medium shot", lens: "50mm", movement: "Slow push-in", lighting: "Golden hour", duration: 5 });
  assert.equal(text, "Market at dawn. A vendor lays out fruit. Camera: Medium shot, 50mm. Movement: Slow push-in. Lighting: Golden hour. Duration: 5 seconds");
});
