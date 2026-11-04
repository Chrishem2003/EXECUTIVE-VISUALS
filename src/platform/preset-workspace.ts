import { apiRequest } from "../core/api";
import { CATEGORY_LABELS, CATEGORY_ORDER, composePrompt, getPreset, listPresets, type Preset, type PresetCategory } from "../core/presets";

type Mode = "video" | "image";
interface ShotRef { id: string; scene: string }
interface MenuModel { id: string; label: string; capability: "video" | "image"; tier: string; unit: string; unitPriceUsd: number; maxSeconds: number | null; supportsFirstFrame: boolean; notes: string; status: string; reason: string }
interface MenuResponse { models: MenuModel[]; issues: string[]; dailyCapUsd: number | null; disclaimer: string }
interface EstimateResponse { ok?: boolean; problems?: string[]; usd?: number; quantity?: number; unit?: string; unitPriceUsd?: number; exceedsCap?: boolean; dailyCapUsd?: number | null; disclaimer?: string; draftUsd?: number; finalUsd?: number; planUsd?: number; allAtFinalUsd?: number; savingsUsd?: number; draftModelId?: string; finalModelId?: string }

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ESCAPES[c] || c);
const usd = (v: number | undefined) => "$" + (v ?? 0).toFixed((v ?? 0) < 1 ? 3 : 2);
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector);

/* ---------- Preset library ---------- */

function cardMarkup(p: Preset, mode: Mode): string {
  const meta = [p.seconds ? p.seconds.min + "–" + p.seconds.max + " s" : "", p.tags.slice(0, 3).join(" · ")].filter(Boolean).join(" · ");
  const text = (p.name + " " + p.summary + " " + p.tags.join(" ") + " " + CATEGORY_LABELS[p.category]).toLowerCase();
  const primary = mode === "video"
    ? '<button type="button" class="secondary" data-preset-apply="' + esc(p.id) + '">Apply to shot</button>'
    : '<button type="button" class="secondary" data-preset-prompt="' + esc(p.id) + '">Add to prompt</button>';
  return '<article class="preset-card" data-preset-card data-cat="' + p.category + '" data-text="' + esc(text) + '">' +
    '<div class="preset-head"><b>' + esc(p.name) + '</b><span class="preset-cat">' + esc(CATEGORY_LABELS[p.category]) + '</span></div>' +
    '<p>' + esc(p.summary) + '</p>' + (meta ? '<small>' + esc(meta) + '</small>' : '') +
    '<div class="preset-actions">' + primary + '<button type="button" class="quiet" data-preset-copy="' + esc(p.id) + '">Copy prompt</button></div></article>';
}

export function presetLibraryMarkup(mode: Mode, shots: ShotRef[] = []): string {
  const categories: PresetCategory[] = CATEGORY_ORDER.filter(c => mode === "video" || c !== "camera");
  const presets = listPresets({ target: mode });
  const chips = ['<button type="button" class="preset-chip active" data-preset-chip="all">All</button>']
    .concat(categories.map(c => '<button type="button" class="preset-chip" data-preset-chip="' + c + '">' + esc(CATEGORY_LABELS[c]) + '</button>')).join("");
  const target = mode === "video"
    ? '<label for="preset-target-shot">Apply to shot</label><select id="preset-target-shot">' +
      (shots.length ? shots.map((s, i) => '<option value="' + esc(s.id) + '">Shot ' + (i + 1) + " · " + esc(s.scene) + '</option>').join("") : '<option value="">No shots yet — add one first</option>') + '</select>'
    : "";
  const lead = mode === "video"
    ? "Pick a camera move, framing, light or look and apply it to a storyboard shot. The shot fields update and you can copy a ready-made prompt."
    : "Add framing, light and look phrases to your image prompt with one click.";
  return '<section class="panel preset-lib" data-preset-lib data-mode="' + mode + '"><div class="eyebrow">PRESET LIBRARY</div><h3>' +
    (mode === "video" ? "Camera moves, framing, light & look" : "Framing, light & look") + '</h3><p>' + lead + '</p>' +
    '<div class="preset-toolbar"><input id="preset-search" type="search" placeholder="Search presets…" aria-label="Search presets" autocomplete="off"><div class="preset-chips" role="group" aria-label="Filter by type">' + chips + '</div></div>' +
    target + '<div id="preset-msg" class="preset-msg" role="status" aria-live="polite"></div>' +
    '<div class="preset-count"><span id="preset-count">' + presets.length + '</span> presets</div>' +
    '<div class="preset-grid">' + presets.map(p => cardMarkup(p, mode)).join("") + '</div>' +
    '<div id="preset-empty" class="empty" hidden>No presets match. Try a different word or filter.</div></section>';
}

function applyFilter(root: HTMLElement) {
  const q = (root.querySelector<HTMLInputElement>("#preset-search")?.value || "").trim().toLowerCase();
  const cat = root.querySelector<HTMLElement>(".preset-chip.active")?.dataset.presetChip || "all";
  let shown = 0;
  root.querySelectorAll<HTMLElement>("[data-preset-card]").forEach(card => {
    const ok = (cat === "all" || card.dataset.cat === cat) && (!q || (card.dataset.text || "").includes(q));
    card.hidden = !ok;
    if (ok) shown++;
  });
  const count = root.querySelector<HTMLElement>("#preset-count");
  if (count) count.textContent = String(shown);
  const empty = root.querySelector<HTMLElement>("#preset-empty");
  if (empty) empty.hidden = shown !== 0;
}

function say(root: HTMLElement, text: string) {
  const el = root.querySelector<HTMLElement>("#preset-msg");
  if (el) el.textContent = text;
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/* ---------- Model menu and cost estimate ---------- */

const STATUS_LABEL: Record<string, string> = { connected: "Connected", listed: "Listed", gateway_off: "Gateway off", gateway_needs_setup: "Needs setup" };

export function modelMenuMarkup(): string {
  return '<section class="panel" id="model-menu-panel"><div class="eyebrow">MODEL MENU & COST</div><h3>Models you can use, and what a job costs</h3>' +
    '<p>List the models you have access to, see their status and price a job before it runs. Nothing here spends money.</p><div id="model-menu"><div class="empty">Loading the model menu…</div></div></section>';
}

function menuMarkup(menu: MenuResponse): string {
  const issues = menu.issues.length ? '<div class="notice">' + menu.issues.map(esc).join("<br>") + '</div>' : "";
  if (!menu.models.length) {
    return issues + '<div class="empty">No models are listed yet. Add the models, prices and limits you actually have access to in the server setting <code>MODEL_CATALOG_JSON</code>. Example entry: <code>{"id":"draft-video","label":"Draft video","capability":"video","tier":"draft","providerModel":"vendor/model-name","unitPriceUsd":0.05,"maxSeconds":10}</code></div>';
  }
  const rows = menu.models.map(m => '<div class="model-row"><div><b>' + esc(m.label) + '</b><small>' + esc(m.capability) + " · " + esc(m.tier) + " · " + usd(m.unitPriceUsd) + " per " + esc(m.unit) +
    (m.maxSeconds ? " · up to " + m.maxSeconds + " s" : "") + (m.supportsFirstFrame ? " · first-frame input" : "") + '</small>' + (m.notes ? '<small>' + esc(m.notes) + '</small>' : '') + '<small class="model-reason">' + esc(m.reason) + '</small></div><span class="model-status ' + esc(m.status) + '">' + esc(STATUS_LABEL[m.status] || m.status) + '</span></div>').join("");
  const options = menu.models.map(m => '<option value="' + esc(m.id) + '">' + esc(m.label) + " (" + esc(m.capability) + ")</option>").join("");
  const cap = menu.dailyCapUsd ? '<small>Spend ceiling per job set by the server: ' + usd(menu.dailyCapUsd) + '</small>' : "";
  return issues + '<div class="model-list">' + rows + '</div>' +
    '<div class="two-col model-tools"><form id="model-estimate-form"><div class="eyebrow">ESTIMATE A JOB</div><label for="est-model">Model</label><select id="est-model" name="modelId">' + options + '</select>' +
    '<div class="form-grid"><div><label for="est-seconds">Length (seconds, video)</label><input id="est-seconds" name="seconds" type="number" min="1" max="60" value="5"></div><div><label for="est-count">How many</label><input id="est-count" name="count" type="number" min="1" max="20" value="1"></div></div>' +
    '<button class="primary wide" type="submit">Estimate cost</button><div id="model-estimate-result" class="model-result" role="status" aria-live="polite"></div></form>' +
    '<form id="model-plan-form"><div class="eyebrow">DRAFT FIRST, THEN FINALIZE</div><label for="plan-cap">Type</label><select id="plan-cap" name="capability"><option value="video">Video</option><option value="image">Image</option></select>' +
    '<div class="form-grid"><div><label for="plan-seconds">Length (s)</label><input id="plan-seconds" name="seconds" type="number" min="1" max="60" value="5"></div><div><label for="plan-drafts">Cheap drafts</label><input id="plan-drafts" name="drafts" type="number" min="1" max="20" value="8"></div><div><label for="plan-finals">Final renders</label><input id="plan-finals" name="finals" type="number" min="1" max="20" value="2"></div></div>' +
    '<button class="secondary wide" type="submit">Compare with exploring at final quality</button><div id="model-plan-result" class="model-result" role="status" aria-live="polite"></div></form></div>' +
    cap + '<small class="model-disclaimer">' + esc(menu.disclaimer) + '</small>';
}

async function loadModelMenu() {
  const host = $<HTMLElement>("#model-menu");
  if (!host || host.dataset.state) return;
  host.dataset.state = "loading";
  try {
    const menu = await apiRequest<MenuResponse>("/api/models");
    if (!host.isConnected) return;
    host.innerHTML = menuMarkup(menu);
    host.dataset.state = "ready";
  } catch (error) {
    if (!host.isConnected) return;
    host.innerHTML = '<div class="empty">' + esc(error instanceof Error ? error.message : "Could not load the model menu.") + " Sign in and try again.</div>";
    host.dataset.state = "error";
  }
}

function showEstimate(target: HTMLElement | null, result: EstimateResponse, plan: boolean) {
  if (!target) return;
  if (result.ok === false || (result.problems && result.problems.length)) { target.innerHTML = '<span class="model-bad">' + (result.problems || []).map(esc).join("<br>") + "</span>"; return; }
  const warn = result.exceedsCap ? '<br><span class="model-bad">This is above the spend ceiling of ' + usd(result.dailyCapUsd ?? 0) + " set by the server.</span>" : "";
  target.innerHTML = plan
    ? "<b>" + usd(result.planUsd) + "</b> for the draft-first plan (drafts " + usd(result.draftUsd) + " + finals " + usd(result.finalUsd) + ").<br>Exploring everything at final quality would cost " + usd(result.allAtFinalUsd) + " — you save <b>" + usd(result.savingsUsd) + "</b>." + warn
    : "<b>" + usd(result.usd) + "</b> estimated (" + result.quantity + " " + esc(result.unit) + " × " + usd(result.unitPriceUsd) + ")." + warn;
}

/* ---------- Events ---------- */

export function initPresetWorkspace() {
  document.addEventListener("input", event => {
    const t = event.target as HTMLElement;
    if (t.id !== "preset-search") return;
    const root = t.closest<HTMLElement>("[data-preset-lib]");
    if (root) applyFilter(root);
  });

  document.addEventListener("click", async event => {
    const t = event.target as HTMLElement;
    const root = t.closest<HTMLElement>("[data-preset-lib]");
    if (!root) return;
    const chip = t.closest<HTMLElement>("[data-preset-chip]");
    if (chip) {
      root.querySelectorAll(".preset-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      applyFilter(root);
      return;
    }
    const apply = t.closest<HTMLElement>("[data-preset-apply]");
    if (apply) {
      const shotId = root.querySelector<HTMLSelectElement>("#preset-target-shot")?.value || "";
      const preset = getPreset(apply.dataset.presetApply || "");
      if (!preset) return;
      if (!shotId) { say(root, "Add a shot to the storyboard first, then apply a preset to it."); return; }
      window.dispatchEvent(new CustomEvent("ev:preset-apply-shot", { detail: { shotId, presetId: preset.id } }));
      return;
    }
    const add = t.closest<HTMLElement>("[data-preset-prompt]");
    if (add) {
      const preset = getPreset(add.dataset.presetPrompt || "");
      const box = document.querySelector<HTMLTextAreaElement>("#image textarea[name=prompt]");
      if (!preset || !box) return;
      box.value = composePrompt(box.value, [preset.id]).prompt;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      say(root, "Added “" + preset.name + "” to your prompt.");
      return;
    }
    const copy = t.closest<HTMLElement>("[data-preset-copy]");
    if (copy) {
      const preset = getPreset(copy.dataset.presetCopy || "");
      if (!preset) return;
      say(root, (await copyText(preset.prompt)) ? "Copied the prompt for “" + preset.name + "”." : "Copy is not available here. Prompt: " + preset.prompt);
    }
  });

  document.addEventListener("submit", async event => {
    const form = event.target as HTMLFormElement;
    if (form.id !== "model-estimate-form" && form.id !== "model-plan-form") return;
    event.preventDefault();
    const plan = form.id === "model-plan-form";
    const data = new FormData(form);
    const body = plan
      ? { mode: "plan", capability: String(data.get("capability")), seconds: Number(data.get("seconds")), drafts: Number(data.get("drafts")), finals: Number(data.get("finals")) }
      : { modelId: String(data.get("modelId")), seconds: Number(data.get("seconds")), count: Number(data.get("count")) };
    const target = form.querySelector<HTMLElement>(".model-result");
    try {
      const result = await apiRequest<EstimateResponse>("/api/models/estimate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      showEstimate(target, result, plan);
    } catch (error) {
      const problems = (error as { message?: string }).message || "Could not estimate.";
      showEstimate(target, { ok: false, problems: [problems] }, plan);
    }
  });

  // The Creative engines view is rendered as plain HTML; load the menu when it appears.
  const view = $<HTMLElement>("#view");
  if (view) new MutationObserver(() => { void loadModelMenu(); }).observe(view, { childList: true, subtree: true });
  void loadModelMenu();
}
