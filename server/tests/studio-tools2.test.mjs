import test from "node:test";
import assert from "node:assert/strict";
import { cleanShots, clock, timeline, exportStoryboard, MAX_EXPORT_SHOTS } from "../../src/core/storyboard-export.ts";
import { BUILT_IN_KITS, validateKit, kitPatch, applyKitToShots, kitPrompt } from "../../src/core/style-kit.ts";
import { planVariations, MAX_VARIATIONS } from "../../src/core/variation-plan.ts";
import { getPreset } from "../../src/core/presets.ts";

const shot = (over = {}) => ({ scene: "INT. LAB - NIGHT", action: "A scientist opens a glowing box.", camera: "Medium", lens: "35mm", movement: "Slow push-in", lighting: "Low key", duration: 4, ...over });

test("clock formats running time with tenths only when needed", () => {
  assert.equal(clock(0), "00:00:00");
  assert.equal(clock(65.5), "00:01:05.5");
  assert.equal(clock(3725), "01:02:05");
});

test("timeline runs shots back to back without float drift", () => {
  const t = timeline(cleanShots([shot({ duration: 0.1 }), shot({ duration: 0.2 }), shot({ duration: 3 })]));
  assert.deepEqual(t.map(x => x.end), [0.1, 0.3, 3.3]);
  assert.equal(t[2].start, 0.3);
});

test("cleanShots drops junk, trims fields and caps the count", () => {
  assert.deepEqual(cleanShots("nope"), []);
  const cleaned = cleanShots([null, 5, "x", shot({ duration: -3 }), shot({ duration: "abc" }), shot({ action: "a".repeat(9000) })]);
  assert.equal(cleaned.length, 3);
  assert.equal(cleaned[0].duration, 0);
  assert.equal(cleaned[2].action.length, 4000);
  assert.equal(cleanShots(Array.from({ length: 500 }, () => shot())).length, MAX_EXPORT_SHOTS);
});

test("markdown export lists shots with times and skips empty fields", () => {
  const out = exportStoryboard([shot(), shot({ scene: "", camera: "", action: "", duration: 2 })], "markdown", "My film");
  assert.equal(out.ok, true);
  assert.equal(out.extension, "md");
  assert.match(out.content, /^# My film/);
  assert.match(out.content, /2 shots · 00:00:06 total/);
  assert.match(out.content, /## Shot 2 — Untitled scene/);
  assert.match(out.content, /\(no action written\)/);
  assert.equal((out.content.match(/- Camera:/g) || []).length, 1);
});

test("csv export escapes quotes and commas and blocks spreadsheet formulas", () => {
  const out = exportStoryboard([shot({ action: '=HYPERLINK("http://x")', scene: "A, B", lens: "+1", camera: 'She said "hi"' })], "csv");
  assert.equal(out.mime, "text/csv");
  const lines = out.content.trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /'=HYPERLINK\(""http:\/\/x""\)/);
  assert.match(lines[1], /"A, B"/);
  assert.match(lines[1], /,'\+1,/);
  assert.match(lines[1], /"She said ""hi"""/);
});

test("timing list and json are well formed", () => {
  const timing = exportStoryboard([shot(), shot({ duration: 2 })], "timing").content;
  assert.match(timing, /^1\n00:00:00 --> 00:00:04\n/);
  assert.match(timing, /\n2\n00:00:04 --> 00:00:06\n/);
  const json = JSON.parse(exportStoryboard([shot()], "json", "T").content);
  assert.equal(json.title, "T");
  assert.equal(json.shots[0].number, 1);
  assert.equal(json.shots[0].end, 4);
});

test("export refuses empty storyboards and unknown formats", () => {
  assert.match(exportStoryboard([], "csv").problems[0], /at least one shot/);
  assert.equal(exportStoryboard([shot()], "pdf").ok, false);
});

test("built-in kits only reference real light and look presets", () => {
  assert.ok(BUILT_IN_KITS.length >= 3);
  for (const kit of BUILT_IN_KITS) {
    assert.ok(kit.presetIds.length >= 2, kit.id + " lost a preset");
    for (const id of kit.presetIds) assert.match(getPreset(id).category, /^(light|look)$/);
  }
});

test("validateKit accepts a good kit and explains every problem", () => {
  const good = validateKit({ name: "My Moody Set", presetIds: ["moody-low-key", "film-grain-35", "moody-low-key"] });
  assert.equal(good.ok, true);
  assert.equal(good.kit.id, "my-moody-set");
  assert.deepEqual(good.kit.presetIds, ["moody-low-key", "film-grain-35"]);
  assert.equal(good.kit.builtIn, false);
  const bad = validateKit({ name: "", presetIds: ["slow-push-in", "nope"] });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some(p => /name/.test(p)));
  assert.ok(bad.problems.some(p => /light and look/.test(p)));
  assert.equal(validateKit(null).ok, false);
  assert.ok(validateKit({ name: "x", presetIds: Array.from({ length: 7 }, (_, i) => "p" + i) }).problems.some(p => /at most/.test(p)));
});

test("a kit gives every shot the same light and look, replacing an earlier look", () => {
  const kit = BUILT_IN_KITS.find(k => k.id === "warm-documentary");
  const shots = [shot(), shot({ lighting: "Old light · Look: Pastel Dream" })];
  const styled = applyKitToShots(shots, kit);
  const look = getPreset("muted-documentary").name;
  for (const s of styled) {
    assert.match(s.lighting, new RegExp("Look: " + look));
    assert.equal((s.lighting.match(/Look:/g) || []).length, 1);
  }
  assert.equal(styled[0].action, shots[0].action);
  assert.notEqual(shots[0].lighting, styled[0].lighting, "input is not mutated");
  assert.deepEqual(Object.keys(kitPatch(shots[0], kit)).sort(), ["lighting"]);
});

test("kitPrompt adds the kit fragments once and respects the length limit", () => {
  const kit = BUILT_IN_KITS.find(k => k.id === "clean-product");
  const full = kitPrompt("A coffee cup on a table", kit);
  assert.ok(full.prompt.startsWith("A coffee cup on a table"));
  assert.ok(full.prompt.length > "A coffee cup on a table".length);
  const tight = kitPrompt("A coffee cup on a table", kit, 30);
  assert.ok(tight.prompt.length <= 30);
  assert.equal(tight.dropped.length, kit.presetIds.length);
});

test("planVariations changes one axis and keeps fixed presets in every prompt", () => {
  const plan = planVariations("A runner crosses a bridge", { axis: "light", count: 4, fixed: ["slow-push-in"] });
  assert.equal(plan.ok, true);
  assert.equal(plan.variations.length, 4);
  assert.equal(new Set(plan.variations.map(v => v.presetId)).size, 4);
  assert.equal(new Set(plan.variations.map(v => v.prompt)).size, 4);
  const push = getPreset("slow-push-in").prompt;
  for (const v of plan.variations) {
    assert.ok(v.prompt.startsWith("A runner crosses a bridge"));
    assert.ok(v.prompt.includes(push));
    assert.equal(getPreset(v.presetId).category, "light");
  }
  assert.deepEqual(plan.variations.map(v => v.index), [1, 2, 3, 4]);
});

test("planVariations clamps the count, filters by output type and rejects bad input", () => {
  assert.equal(planVariations("x y z", { axis: "look", count: 99 }).variations.length, MAX_VARIATIONS);
  assert.equal(planVariations("x y z", { axis: "look", count: 0 }).variations.length, 2);
  const stills = planVariations("A quiet street", { axis: "camera", target: "image" });
  if (stills.ok) for (const v of stills.variations) assert.notEqual(getPreset(v.presetId).applies, "video");
  assert.match(planVariations("   ").problems[0], /base prompt/);
  const tooLong = planVariations("w".repeat(1490), { axis: "light", maxLength: 1500 });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.problems[0], /too long/);
  assert.equal(planVariations("ok", { axis: "bogus" }).axis, "light");
});
