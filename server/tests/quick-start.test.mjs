import test from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES, getTemplate, buildQuickStart, cleanTopic, splitSeconds, MAX_TOPIC, MIN_SECONDS, MAX_SECONDS } from "../../src/core/quick-start.ts";
import { getPreset, SHOT_FIELD_LIMITS } from "../../src/core/presets.ts";
import { BUILT_IN_KITS } from "../../src/core/style-kit.ts";
import { FRAME_TARGETS } from "../../src/core/frame-fit.ts";

test("every template points at real presets, kits and frame sizes", () => {
  assert.ok(TEMPLATES.length >= 6);
  const ids = new Set();
  for (const t of TEMPLATES) {
    assert.ok(!ids.has(t.id), "duplicate template " + t.id);
    ids.add(t.id);
    assert.ok(BUILT_IN_KITS.some(k => k.id === t.kitId), t.id + " kit");
    assert.ok(FRAME_TARGETS.some(f => f.id === t.frameTargetId), t.id + " frame");
    assert.ok(t.beats.length >= 4 && t.hooks.length >= 3 && t.checklist.length >= 3, t.id + " is too thin");
    assert.ok(t.defaultSeconds >= t.beats.length * 2);
    for (const b of t.beats) {
      assert.equal(getPreset(b.framingId)?.category, "framing", t.id + " framing " + b.framingId);
      assert.equal(getPreset(b.cameraId)?.category, "camera", t.id + " camera " + b.cameraId);
      assert.ok(b.action.includes("{topic}"), t.id + " beat '" + b.scene + "' never uses the topic");
      assert.ok(b.weight > 0);
    }
  }
});

test("splitSeconds always sums to the total and respects the minimum", () => {
  for (const total of [10, 11, 20, 37, 45, 120]) {
    for (const weights of [[1, 1, 1], [2, 3, 3, 4, 2], [5, 1, 1, 1, 1, 1]]) {
      if (total < weights.length * 2) continue;
      const parts = splitSeconds(total, weights);
      assert.equal(parts.reduce((a, b) => a + b, 0), total, total + " / " + weights);
      assert.ok(parts.every(p => Number.isInteger(p) && p >= 2));
    }
  }
  assert.deepEqual(splitSeconds(10, []), []);
});

test("a complete draft is produced from a template and a topic", () => {
  const r = buildQuickStart({ templateId: "product-ad", topic: "  Mama Rose   hand-made soap  " });
  assert.equal(r.ok, true);
  assert.equal(r.topic, "Mama Rose hand-made soap");
  assert.equal(r.shots.length, 5);
  assert.equal(r.totalSeconds, 20);
  assert.equal(r.frameTargetId, "portrait-4x5");
  assert.equal(r.frameLabel, "Portrait 4:5");
  assert.equal(r.kitId, "clean-product");
  assert.equal(r.prompts.length, r.shots.length);
  assert.ok(r.hooks.every(h => h.includes("Mama Rose hand-made soap")));
  assert.ok(r.checklist.length >= 3);
  for (const s of r.shots) {
    assert.ok(s.action.includes("Mama Rose hand-made soap"));
    assert.ok(s.camera && s.lens && s.movement && s.lighting, "all shot fields filled: " + s.scene);
    assert.match(s.lighting, /Look: /);
    assert.ok(s.camera.length <= SHOT_FIELD_LIMITS.camera && s.lighting.length <= SHOT_FIELD_LIMITS.lighting);
    assert.ok(Number.isInteger(s.duration) && s.duration >= 2);
  }
  assert.ok(r.prompts[0].includes("Mama Rose hand-made soap"));
});

test("every template builds cleanly at its default and at extreme lengths", () => {
  for (const t of TEMPLATES) {
    for (const seconds of [undefined, 1, 500]) {
      const r = buildQuickStart({ templateId: t.id, topic: "Test topic", seconds });
      assert.equal(r.ok, true, t.id + " " + seconds);
      assert.ok(r.totalSeconds >= MIN_SECONDS && r.totalSeconds <= MAX_SECONDS);
      assert.equal(r.totalSeconds, r.shots.reduce((a, s) => a + s.duration, 0));
    }
  }
  const r = buildQuickStart({ templateId: "story-reel", topic: "Rain", seconds: 500 });
  assert.equal(r.totalSeconds, MAX_SECONDS);
  assert.match(r.problems[0], /Length was set to 120/);
});

test("the same input always gives the same draft", () => {
  const a = buildQuickStart({ templateId: "event-promo", topic: "Youth night", seconds: 24 });
  const b = buildQuickStart({ templateId: "event-promo", topic: "Youth night", seconds: 24 });
  assert.deepEqual(a, b);
});

test("bad input is refused with a plain message", () => {
  assert.match(buildQuickStart({}).problems[0], /Choose what you want to make/);
  assert.match(buildQuickStart({ templateId: "nope", topic: "abc" }).problems[0], /Choose what you want to make/);
  assert.match(buildQuickStart({ templateId: "product-ad", topic: "ab" }).problems[0], /at least 3/);
  assert.match(buildQuickStart({ templateId: "product-ad", topic: "   " }).problems[0], /at least 3/);
  assert.match(buildQuickStart({ templateId: "product-ad", topic: "Soap", seconds: "abc" }).problems[0], /number of seconds/);
  assert.equal(buildQuickStart({ templateId: "product-ad", topic: "Soap", seconds: "" }).ok, true);
});

test("topics are cleaned: control characters, whitespace and length", () => {
  assert.equal(cleanTopic("a\u0000b\nc\td"), "a b c d");
  assert.equal(cleanTopic("x".repeat(500)).length, MAX_TOPIC);
  assert.equal(cleanTopic(null), "");
  const r = buildQuickStart({ templateId: "quick-explainer", topic: "<img src=x onerror=alert(1)>" });
  assert.equal(r.ok, true);
  assert.ok(r.shots[0].action.includes("<img"), "text is kept as typed; the page escapes it when shown");
});

test("getTemplate finds templates by id only", () => {
  assert.equal(getTemplate("podcast-teaser").name, "Podcast teaser");
  assert.equal(getTemplate("__proto__"), undefined);
});
