import test from "node:test";
import assert from "node:assert/strict";
import {
  parseModelCatalog, estimateCost, planDraftThenFinal, publicModelCatalog, estimateFromRequest, getCostCapUsd
} from "../model-catalog.mjs";

const CATALOG = [
  { id: "draft-video", label: "Draft video", capability: "video", tier: "draft", providerModel: "vendor-a/fast-video", unitPriceUsd: 0.05, maxSeconds: 10 },
  { id: "final-video", label: "Final video", capability: "video", tier: "premium", providerModel: "vendor-b/best-video", unitPriceUsd: 0.2, maxSeconds: 8, supportsFirstFrame: true },
  { id: "quick-image", label: "Quick image", capability: "image", tier: "draft", providerModel: "vendor-a/fast-image", unitPriceUsd: 0.012 }
];
const env = extra => ({ MODEL_CATALOG_JSON: JSON.stringify(CATALOG), ...extra });

test("parses a valid menu and fills defaults", () => {
  const { models, issues } = parseModelCatalog(JSON.stringify(CATALOG));
  assert.deepEqual(issues, []);
  assert.equal(models.length, 3);
  assert.equal(models[2].unit, "image");
  assert.equal(models[2].maxSeconds, null);
  assert.equal(models[0].supportsFirstFrame, false);
});

test("empty, malformed or non-array input never throws", () => {
  assert.deepEqual(parseModelCatalog(undefined), { models: [], issues: [] });
  assert.deepEqual(parseModelCatalog("  "), { models: [], issues: [] });
  assert.match(parseModelCatalog("{nope").issues[0], /not valid JSON/);
  assert.match(parseModelCatalog("{}").issues[0], /array/);
});

test("invalid entries are skipped with a reason and do not hide good ones", () => {
  const raw = JSON.stringify([
    CATALOG[0],
    { ...CATALOG[1], id: "Bad ID" },
    { ...CATALOG[1], id: "x1", unitPriceUsd: -1 },
    { ...CATALOG[1], id: "x2", providerModel: "no slash" },
    { ...CATALOG[1], id: "x3", capability: "audio" },
    { ...CATALOG[1], id: "x4", maxSeconds: 999 },
    { ...CATALOG[0] },
    "text"
  ]);
  const { models, issues } = parseModelCatalog(raw);
  assert.deepEqual(models.map(m => m.id), ["draft-video"]);
  assert.equal(issues.length, 7);
  assert.ok(issues.some(i => /duplicate id/.test(i)));
});

test("estimateCost multiplies length, count and unit price", () => {
  const [video, , image] = parseModelCatalog(JSON.stringify(CATALOG)).models;
  assert.deepEqual(estimateCost(video, { seconds: 5, count: 4 }), { ok: true, problems: [], usd: 1, quantity: 20, unit: "second", unitPriceUsd: 0.05 });
  assert.equal(estimateCost(image, { count: 10 }).usd, 0.12);
  assert.equal(estimateCost(image, { seconds: 999, count: 1 }).ok, true);
});

test("estimateCost rejects out-of-range input with readable problems", () => {
  const [video] = parseModelCatalog(JSON.stringify(CATALOG)).models;
  assert.match(estimateCost(video, { seconds: 11, count: 1 }).problems[0], /between 1 and 10/);
  assert.match(estimateCost(video, { seconds: 0, count: 1 }).problems[0], /between 1 and 10/);
  assert.match(estimateCost(video, { seconds: 5, count: 0 }).problems[0], /Count/);
  assert.match(estimateCost(video, { seconds: 5, count: 21 }).problems[0], /Count/);
  assert.match(estimateCost(video, { seconds: 5, count: 1.5 }).problems[0], /Count/);
});

test("draft-then-finalize shows the saving and refuses when tiers are missing", () => {
  const { models } = parseModelCatalog(JSON.stringify(CATALOG));
  const plan = planDraftThenFinal(models, { capability: "video", seconds: 5, drafts: 8, finals: 2 });
  assert.equal(plan.ok, true);
  assert.equal(plan.draftUsd, 2);
  assert.equal(plan.finalUsd, 2);
  assert.equal(plan.planUsd, 4);
  assert.equal(plan.allAtFinalUsd, 8);
  assert.equal(plan.savingsUsd, 4);
  const missing = planDraftThenFinal(models, { capability: "image" });
  assert.equal(missing.ok, false);
  assert.match(missing.problems[0], /draft-tier/);
});

test("a model is only 'connected' when the gateway uses that exact model", () => {
  const providerCatalog = {
    providers: [
      { id: "video", enabled: true, status: "ready", model: "vendor-b/best-video", reason: "ok" },
      { id: "image", enabled: false, status: "disabled", model: null, reason: "off" }
    ]
  };
  const menu = publicModelCatalog({ env: env({ REMOTE_DAILY_COST_LIMIT_USD: "5" }), providerCatalog });
  const byId = Object.fromEntries(menu.models.map(m => [m.id, m]));
  assert.equal(byId["final-video"].status, "connected");
  assert.equal(byId["draft-video"].status, "listed");
  assert.equal(byId["quick-image"].status, "gateway_off");
  assert.equal(menu.dailyCapUsd, 5);
  assert.ok(menu.disclaimer.includes("estimates"));
  for (const m of menu.models) assert.ok(!("providerModel" in m), "provider model ids stay on the server");
});

test("gateway that needs setup is reported, and no providers means gateway_off", () => {
  const pending = publicModelCatalog({ env: env(), providerCatalog: { providers: [{ id: "video", enabled: true, status: "needs_configuration", model: null, reason: "Set the key." }] } });
  assert.equal(pending.models.find(m => m.id === "draft-video").status, "gateway_needs_setup");
  assert.equal(pending.models.find(m => m.id === "draft-video").reason, "Set the key.");
  assert.equal(publicModelCatalog({ env: env() }).models[0].status, "gateway_off");
});

test("estimateFromRequest handles single, plan, unknown and capped requests", () => {
  const ok = estimateFromRequest({ modelId: "final-video", seconds: 8, count: 2 }, { env: env({ REMOTE_DAILY_COST_LIMIT_USD: "3" }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.usd, 3.2);
  assert.equal(ok.body.exceedsCap, true);
  assert.equal(estimateFromRequest({ modelId: "final-video", seconds: 1 }, { env: env() }).body.exceedsCap, false);
  assert.equal(estimateFromRequest({ modelId: "nope" }, { env: env() }).status, 404);
  assert.equal(estimateFromRequest({ modelId: "final-video", seconds: 99 }, { env: env() }).status, 400);
  assert.equal(estimateFromRequest(null, { env: env() }).status, 404);
  const plan = estimateFromRequest({ mode: "plan", capability: "video", seconds: 5, drafts: 8, finals: 2 }, { env: env() });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.savingsUsd, 4);
  assert.equal(estimateFromRequest({ mode: "plan", capability: "image" }, { env: env() }).status, 400);
});

test("cost cap is read only from a positive number", () => {
  assert.equal(getCostCapUsd({}), null);
  assert.equal(getCostCapUsd({ REMOTE_DAILY_COST_LIMIT_USD: "0" }), null);
  assert.equal(getCostCapUsd({ REMOTE_DAILY_COST_LIMIT_USD: "-2" }), null);
  assert.equal(getCostCapUsd({ REMOTE_DAILY_COST_LIMIT_USD: "abc" }), null);
  assert.equal(getCostCapUsd({ REMOTE_DAILY_COST_LIMIT_USD: "2.5" }), 2.5);
});
