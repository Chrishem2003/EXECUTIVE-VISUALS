// Operator-defined model menu with honest cost estimates.
//
// The operator describes the models they have access to in MODEL_CATALOG_JSON.
// Nothing here calls a provider or spends money. It validates the menu, joins it
// to the live gateway status, and does the arithmetic for "what will this cost".
// An entry is only marked "connected" when the gateway is really configured to
// use that exact provider model; everything else is listed but not routed.

const ID_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)+$/i;
const CAPABILITIES = new Set(["video", "image"]);
const TIERS = new Set(["draft", "standard", "premium"]);
const UNIT_FOR = { video: "second", image: "image" };
const MAX_ENTRIES = 50;
const MAX_COUNT = 20;

export const PRICE_DISCLAIMER =
  "Prices are operator-supplied estimates in US dollars. Confirm them with your provider; the provider's own bill is the source of truth.";

const round4 = value => Math.round(value * 10000) / 10000;

function validateEntry(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "must be an object." };
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (!id || id.length > 48 || !ID_RE.test(id)) return { error: "id must be lowercase letters, numbers, - or _ (max 48)." };
  const label = typeof item.label === "string" ? item.label.trim() : "";
  if (!label || label.length > 60) return { error: id + ": label is required (max 60 characters)." };
  if (!CAPABILITIES.has(item.capability)) return { error: id + ': capability must be "video" or "image".' };
  if (!TIERS.has(item.tier)) return { error: id + ': tier must be "draft", "standard" or "premium".' };
  const providerModel = typeof item.providerModel === "string" ? item.providerModel.trim() : "";
  if (!providerModel || providerModel.length > 200 || !SLUG_RE.test(providerModel)) return { error: id + ": providerModel must look like vendor/model-name." };
  const price = item.unitPriceUsd;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 100) return { error: id + ": unitPriceUsd must be a number above 0 and at most 100." };
  const unit = UNIT_FOR[item.capability];
  if (item.unit !== undefined && item.unit !== unit) return { error: id + ": unit must be \"" + unit + "\" for " + item.capability + "." };
  let maxSeconds = null;
  if (item.capability === "video") {
    maxSeconds = item.maxSeconds === undefined ? 10 : item.maxSeconds;
    if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 60) return { error: id + ": maxSeconds must be a whole number from 1 to 60." };
  }
  const notes = typeof item.notes === "string" ? item.notes.trim().slice(0, 200) : "";
  return {
    entry: {
      id, label, capability: item.capability, tier: item.tier, providerModel, unit,
      unitPriceUsd: price, maxSeconds, supportsFirstFrame: item.supportsFirstFrame === true, notes
    }
  };
}

/** Parse and validate MODEL_CATALOG_JSON. Bad entries are reported and skipped; this never throws. */
export function parseModelCatalog(raw) {
  const models = [];
  const issues = [];
  if (raw === undefined || raw === null || !String(raw).trim()) return { models, issues };
  let data;
  try { data = JSON.parse(String(raw)); } catch { return { models, issues: ["MODEL_CATALOG_JSON is not valid JSON."] }; }
  if (!Array.isArray(data)) return { models, issues: ["MODEL_CATALOG_JSON must be a JSON array of models."] };
  if (data.length > MAX_ENTRIES) issues.push("Only the first " + MAX_ENTRIES + " models are used.");
  data.slice(0, MAX_ENTRIES).forEach((item, index) => {
    const result = validateEntry(item);
    if (result.error) { issues.push("Model " + (index + 1) + ": " + result.error); return; }
    if (models.some(model => model.id === result.entry.id)) { issues.push("Model " + (index + 1) + ": duplicate id " + result.entry.id + "."); return; }
    models.push(result.entry);
  });
  return { models, issues };
}

/** Cost of one request: video = seconds x count clips, image = count images. */
export function estimateCost(entry, { seconds = 0, count = 1 } = {}) {
  const problems = [];
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) problems.push("Count must be a whole number from 1 to " + MAX_COUNT + ".");
  let each = 1;
  if (entry.capability === "video") {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s < 1 || s > entry.maxSeconds) problems.push("Length must be between 1 and " + entry.maxSeconds + " seconds for this model.");
    else each = s;
  }
  if (problems.length) return { ok: false, problems };
  const quantity = each * n;
  return { ok: true, problems: [], usd: round4(quantity * entry.unitPriceUsd), quantity, unit: entry.unit, unitPriceUsd: entry.unitPriceUsd };
}

/** Optional per-job spend ceiling from REMOTE_DAILY_COST_LIMIT_USD (null when unset or invalid). */
export function getCostCapUsd(env = process.env) {
  const value = Number(env.REMOTE_DAILY_COST_LIMIT_USD);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const cheapest = list => list.reduce((best, item) => (best === null || item.unitPriceUsd < best.unitPriceUsd ? item : best), null);

/**
 * Draft-then-finalize: explore many cheap takes, then render only the keepers at
 * higher quality. Compares that plan with exploring everything at the final tier.
 */
export function planDraftThenFinal(models, { capability, seconds = 5, drafts = 8, finals = 2 } = {}) {
  const pool = models.filter(model => model.capability === capability);
  const draftModel = cheapest(pool.filter(model => model.tier === "draft"));
  const finalModel = cheapest(pool.filter(model => model.tier === "premium")) || cheapest(pool.filter(model => model.tier === "standard"));
  if (!draftModel || !finalModel) return { ok: false, problems: ["Add a draft-tier model and a standard or premium model for " + capability + " to compare plans."] };
  const draftCost = estimateCost(draftModel, { seconds, count: drafts });
  const finalCost = estimateCost(finalModel, { seconds, count: finals });
  const directCost = estimateCost(finalModel, { seconds, count: drafts });
  const failed = [draftCost, finalCost, directCost].find(result => !result.ok);
  if (failed) return { ok: false, problems: failed.problems };
  const planUsd = round4(draftCost.usd + finalCost.usd);
  return {
    ok: true, problems: [], draftModelId: draftModel.id, finalModelId: finalModel.id,
    draftUsd: draftCost.usd, finalUsd: finalCost.usd, planUsd, allAtFinalUsd: directCost.usd,
    savingsUsd: round4(directCost.usd - planUsd)
  };
}

/** Menu for the browser: no provider model ids, plus live status from the gateway catalog. */
export function publicModelCatalog({ env = process.env, providerCatalog } = {}) {
  const { models, issues } = parseModelCatalog(env.MODEL_CATALOG_JSON);
  const providers = (providerCatalog && providerCatalog.providers) || [];
  const view = models.map(model => {
    const provider = providers.find(item => item.id === model.capability);
    const gatewayReady = Boolean(provider) && provider.status === "ready";
    const connected = gatewayReady && provider.model === model.providerModel;
    let status = "listed";
    let reason = "Listed in your menu. The server is not set to use this model yet.";
    if (!provider || !provider.enabled) { status = "gateway_off"; reason = "The " + model.capability + " gateway is switched off on the server."; }
    else if (!gatewayReady) { status = "gateway_needs_setup"; reason = provider.reason || "The " + model.capability + " gateway needs configuration."; }
    else if (connected) { status = "connected"; reason = "This is the model the server will call."; }
    return {
      id: model.id, label: model.label, capability: model.capability, tier: model.tier, unit: model.unit,
      unitPriceUsd: model.unitPriceUsd, maxSeconds: model.maxSeconds, supportsFirstFrame: model.supportsFirstFrame,
      notes: model.notes, status, reason
    };
  });
  return { version: 1, models: view, issues, dailyCapUsd: getCostCapUsd(env), disclaimer: PRICE_DISCLAIMER };
}

/** Handle POST /api/models/estimate input. */
export function estimateFromRequest(body, { env = process.env } = {}) {
  const { models } = parseModelCatalog(env.MODEL_CATALOG_JSON);
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const capUsd = getCostCapUsd(env);
  if (input.mode === "plan") {
    const capability = CAPABILITIES.has(input.capability) ? input.capability : "video";
    const plan = planDraftThenFinal(models, { capability, seconds: Number(input.seconds) || 5, drafts: Number(input.drafts) || 8, finals: Number(input.finals) || 2 });
    return { status: plan.ok ? 200 : 400, body: { ...plan, disclaimer: PRICE_DISCLAIMER, dailyCapUsd: capUsd, exceedsCap: plan.ok && capUsd !== null && plan.planUsd > capUsd } };
  }
  const entry = models.find(model => model.id === input.modelId);
  if (!entry) return { status: 404, body: { ok: false, problems: ["That model is not in the menu."] } };
  const result = estimateCost(entry, { seconds: input.seconds, count: input.count === undefined ? 1 : input.count });
  if (!result.ok) return { status: 400, body: result };
  return { status: 200, body: { ...result, modelId: entry.id, disclaimer: PRICE_DISCLAIMER, dailyCapUsd: capUsd, exceedsCap: capUsd !== null && result.usd > capUsd } };
}
