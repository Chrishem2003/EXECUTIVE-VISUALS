import "./studio.css";
import { apiRequest, ApiError } from "../core/api";
import { getCurrentProjectId, loadCreativeDraft } from "./runtime";

/**
 * Studio forms for neural enhancement and presenter video. Forms are built from
 * the server's own parameter specs (/api/studio/capabilities), so the browser and
 * the API cannot drift apart. Presenter consent comes from the project's characters.
 */

export type StudioKind = "enhance" | "avatar";

interface Spec { key: string; label: string; type: "select" | "range" | "number" | "boolean" | "text"; options?: Array<string | number>; min?: number; max?: number; default?: string | number | boolean; required?: boolean; integer?: boolean }
interface EngineState { id: string; label: string; enabled: boolean; configured: boolean }
interface EnhanceOp { id: string; label: string; description: string; media: string[]; params: Spec[]; requiresRights?: boolean; secondary?: { field: string; label: string; accepts: string[] } }
type Engine = "enhance" | "avatar" | "transform" | "lipsync";
interface Catalog { engines: Record<Engine, EngineState>; enhance: EnhanceOp[]; transform: EnhanceOp[]; finishing: EnhanceOp[]; avatar: { params: Spec[] }; lipsync: { params: Spec[] } }
type Group = "enhance" | "transform" | "local";
const GROUP_TITLE: Record<Group, string> = { enhance: "Restore and repair (your gateway)", transform: "Transform footage (your gateway)", local: "Finish locally (no provider)" };
interface StudioAsset { id: string; name: string; mediaType: string }
interface StudioJob { id: string; jobType: string; status: string; progress: number; input: Record<string, unknown>; output: { outputAsset?: { id: string; name: string; mediaType: string } } | null; error: { code?: string; message?: string } | null; createdAt: string }
interface Character { id: string; name: string; consent?: { kind?: string; scopes?: string[]; expiresAt?: string } }

const state = {
  catalog: null as Catalog | null,
  assets: [] as StudioAsset[],
  jobs: [] as StudioJob[],
  characters: [] as Character[],
  signedOut: false,
  error: "",
  enhanceOp: "enhance:denoise",
  touched: false,
  visible: "" as StudioKind | ""
};
let pollTimer: number | undefined;

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
const ACTIVE = new Set(["queued", "running", "reviewing"]);
const JOB_LABEL: Record<string, string> = { "studio.enhance": "Neural enhancement", "studio.transform": "Video transform", "studio.avatar": "Presenter video", "studio.lipsync": "Lip-sync" };
const finishingIds = () => new Set((state.catalog?.finishing || []).map(op => op.id));
const isStudioJobType = (type: string) => type.startsWith("studio.") || finishingIds().has(type);
const kindOfJob = (type: string): StudioKind => (type === "studio.avatar" || type === "studio.lipsync" ? "avatar" : "enhance");
const jobLabel = (type: string) => JOB_LABEL[type] || state.catalog?.finishing.find(op => op.id === type)?.label || type;

function message(error: unknown) {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : "The request could not be completed.";
}

/* ---------- data ---------- */

async function loadCharacters() {
  const projectId = getCurrentProjectId();
  if (!projectId) { state.characters = []; return; }
  try {
    const response = await loadCreativeDraft(projectId);
    const characters = (response?.document as { characters?: Character[] } | undefined)?.characters;
    state.characters = Array.isArray(characters) ? characters : [];
  } catch { state.characters = []; }
}

async function loadAll() {
  try {
    const [catalog, assets, jobs] = await Promise.all([
      apiRequest<Catalog>("/api/studio/capabilities"),
      apiRequest<{ assets: StudioAsset[] }>("/api/assets"),
      apiRequest<{ jobs: StudioJob[] }>("/api/jobs")
    ]);
    state.catalog = catalog;
    state.assets = assets.assets;
    state.jobs = jobs.jobs.filter(job => isStudioJobType(job.jobType));
    await loadCharacters();
    state.signedOut = false;
    state.error = "";
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) state.signedOut = true;
    else state.error = message(error);
  }
}

async function refreshJobs() {
  try {
    const result = await apiRequest<{ jobs: StudioJob[] }>("/api/jobs");
    state.jobs = result.jobs.filter(job => isStudioJobType(job.jobType));
  } catch { /* the next tick retries */ }
}

function schedulePolling() {
  window.clearInterval(pollTimer);
  pollTimer = undefined;
  if (!state.jobs.some(job => ACTIVE.has(job.status))) return;
  pollTimer = window.setInterval(async () => {
    await refreshJobs();
    paintResults();
    if (!state.jobs.some(job => ACTIVE.has(job.status))) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
      await loadAll();
      if (!state.touched) paintAll(); else paintResults();
    }
  }, 2500);
}

/* ---------- fields ---------- */

function field(spec: Spec, prefix: string) {
  const name = `${prefix}${spec.key}`;
  const label = `<label for="${esc(name)}">${esc(spec.label)}</label>`;
  const def = spec.default;
  if (spec.type === "select") {
    return `<div>${label}<select id="${esc(name)}" name="${esc(name)}">${(spec.options || []).map(option => `<option${String(option) === String(def) ? " selected" : ""}>${esc(option)}</option>`).join("")}</select></div>`;
  }
  if (spec.type === "range") {
    return `<div>${label}<div class="st-range"><input id="${esc(name)}" name="${esc(name)}" type="range" min="${spec.min}" max="${spec.max}" value="${esc(def ?? spec.min)}" data-st-range><output>${esc(def ?? spec.min)}</output></div></div>`;
  }
  if (spec.type === "number") {
    return `<div>${label}<input id="${esc(name)}" name="${esc(name)}" type="number" min="${spec.min}" max="${spec.max}" step="${spec.integer ? 1 : "any"}"${def !== undefined ? ` value="${esc(def)}"` : ""}></div>`;
  }
  if (spec.type === "boolean") {
    return `<div class="st-check"><label><input type="checkbox" name="${esc(name)}"${def ? " checked" : ""}> ${esc(spec.label)}</label></div>`;
  }
  if ((spec.max ?? 0) > 500) {
    return `<div class="st-wide">${label}<textarea id="${esc(name)}" name="${esc(name)}" rows="4" maxlength="${spec.max}"${spec.required ? " required" : ""}></textarea></div>`;
  }
  return `<div>${label}<input id="${esc(name)}" name="${esc(name)}" type="text" maxlength="${spec.max || 200}"${spec.required ? " required" : ""}></div>`;
}

function collectParams(form: HTMLFormElement, specs: Spec[], prefix: string) {
  const data = new FormData(form);
  const params: Record<string, string | number | boolean> = {};
  for (const spec of specs) {
    const name = `${prefix}${spec.key}`;
    if (spec.type === "boolean") { params[spec.key] = data.get(name) === "on"; continue; }
    const raw = data.get(name);
    if (raw === null || String(raw).trim() === "") continue;
    params[spec.key] = spec.type === "range" || spec.type === "number" ? Number(raw) : String(raw);
  }
  return params;
}

function assetSelect(name: string, label: string, prefixes: string[], optional: boolean, hint = "") {
  const items = state.assets.filter(asset => prefixes.some(prefix => asset.mediaType.startsWith(prefix)));
  return `<div><label for="${name}">${esc(label)}</label><select id="${name}" name="${name}">${optional ? '<option value="">None</option>' : ""}${items.map(asset => `<option value="${esc(asset.id)}">${esc(asset.name)}</option>`).join("")}</select>${items.length ? "" : `<small class="st-hint">${esc(hint || "Upload matching media in the Asset library first.")}</small>`}</div>`;
}

/** Client-side hint only. The server re-checks consent when the request is made and again when the job runs. */
function consentCovers(character: Character, scope: string) {
  const consent = character.consent;
  if (consent?.kind === "fictional") return true;
  if (consent?.kind !== "authorized" || !consent.scopes?.includes(scope)) return false;
  return Boolean(consent.expiresAt) && Date.parse(`${consent.expiresAt}T23:59:59Z`) >= Date.now();
}

/* ---------- results ---------- */

function summaryOf(job: StudioJob) {
  const params = (job.input.params || {}) as Record<string, unknown>;
  return String(params.script || params.prompt || params.object || job.input.operation || "").slice(0, 140);
}

function preview(asset: { id: string; name: string; mediaType: string }) {
  const url = `/api/assets/${encodeURIComponent(asset.id)}/file`;
  if (asset.mediaType.startsWith("image/")) return `<img class="st-media" src="${url}" alt="${esc(asset.name)}">`;
  if (asset.mediaType.startsWith("video/")) return `<video class="st-media" src="${url}" controls preload="metadata"></video>`;
  return "";
}

function resultCard(job: StudioJob) {
  const active = ACTIVE.has(job.status);
  const output = job.output?.outputAsset;
  const bar = active ? `<div class="st-bar" role="progressbar" aria-valuenow="${Math.round(job.progress || 0)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.max(4, Math.min(100, job.progress || 0))}%"></i></div>` : "";
  const error = job.status === "failed" || job.status === "blocked" ? `<p class="st-error">${esc(job.error?.message || "The job did not complete.")}${job.error?.code ? ` <code>${esc(job.error.code)}</code>` : ""}</p>` : "";
  const created = new Date(job.createdAt + (job.createdAt.endsWith("Z") ? "" : "Z")).toLocaleString();
  return `<article class="st-result"><div class="st-result-head"><div><b>${esc(jobLabel(job.jobType))}</b><small>${esc(created)}</small></div><span class="st-chip st-${esc(job.status)}">${esc(job.status)}</span></div>${summaryOf(job) ? `<p class="st-summary">${esc(summaryOf(job))}</p>` : ""}${bar}${error}${output ? preview(output) + `<div class="st-actions"><a class="st-link" href="/api/assets/${encodeURIComponent(output.id)}/file" download="${esc(output.name)}">Download</a></div>` : ""}${active ? `<div class="st-actions"><button type="button" class="quiet" data-st-cancel="${esc(job.id)}">Cancel run</button></div>` : ""}</article>`;
}

function resultsHtml(kind: StudioKind) {
  const rows = state.jobs.filter(job => kindOfJob(job.jobType) === kind).slice(0, 12);
  return rows.length ? rows.map(resultCard).join("") : '<div class="empty">Nothing generated yet. Finished work appears here with a preview and a download link.</div>';
}

/* ---------- views ---------- */

function banner(engine: Engine) {
  if (state.signedOut) return '<div class="notice">Sign in on the <button class="st-inline" data-tab="runtime">Runtime console</button> to run studio jobs. Nothing is sent to a provider until you submit a form.</div>';
  if (state.error) return `<div class="notice">${esc(state.error)}</div>`;
  if (!state.catalog) return '<div class="notice">Loading studio capabilities…</div>';
  const info = state.catalog.engines[engine];
  const ready = info.enabled && info.configured;
  const detail = ready
    ? "Your own gateway answers these requests. Remote requests count against your daily request allowance."
    : `Set the server-side ${esc(info.id.toUpperCase())}_GATEWAY_* variables to connect it. Requests are refused with a clear message until then, and nothing is billed.`;
  return `<div class="st-status ${ready ? "st-ready" : "st-off"}"><i></i><div><b>${esc(info.label)} engine: ${ready ? "connected" : info.enabled ? "enabled, configuration incomplete" : "not connected"}</b><small>${detail}</small></div></div>`;
}

const LOCAL_BANNER = '<div class="st-status st-ready"><i></i><div><b>Local engine: runs on this server</b><small>Uses FFmpeg here. No provider is called and nothing is billed.</small></div></div>';
const disabledAttr = () => (state.signedOut || !state.catalog ? " disabled" : "");

function allOps(catalog: Catalog): Array<{ group: Group; op: EnhanceOp }> {
  return [
    ...catalog.enhance.map(op => ({ group: "enhance" as Group, op })),
    ...catalog.transform.map(op => ({ group: "transform" as Group, op })),
    ...catalog.finishing.map(op => ({ group: "local" as Group, op }))
  ];
}

function enhanceView() {
  const catalog = state.catalog;
  if (!catalog) return banner("enhance");
  const all = allOps(catalog);
  const current = all.find(item => `${item.group}:${item.op.id}` === state.enhanceOp) || all[0]!;
  const { group, op } = current;
  const prefixes = op.media.map(media => `${media}/`);
  const groups = (["enhance", "transform", "local"] as Group[]).map(name => `<h3 class="st-group">${esc(GROUP_TITLE[name])}</h3><div class="st-ops" role="tablist" aria-label="${esc(GROUP_TITLE[name])}">${all.filter(item => item.group === name).map(({ op: item }) => { const key = `${name}:${item.id}`; const active = key === `${group}:${op.id}`; return `<button type="button" role="tab" aria-selected="${active}" class="st-op${active ? " active" : ""}" data-st-op="${esc(key)}"><b>${esc(item.label)}</b><small>${esc(item.description)}</small></button>`; }).join("")}</div>`).join("");
  const status = group === "local" ? LOCAL_BANNER : banner(group);
  const second = op.secondary ? assetSelect("e_second", op.secondary.label, op.secondary.accepts.map(kind => `${kind}/`), false) : "";
  return `<div class="section-title"><div class="eyebrow">ENHANCEMENT, TRANSFORMS AND FINISHING</div><h2>Restore, transform and finish</h2></div>${groups}${status}<div class="st-grid"><section class="panel"><div class="eyebrow">${esc(op.label.toUpperCase())}</div><h2>${esc(op.label)}</h2><form id="st-enhance" class="st-form" data-group="${group}" data-op="${esc(op.id)}">${assetSelect("e_source", "Source media", prefixes, false)}${second}<div class="form-grid">${op.params.map(spec => field(spec, "e_")).join("")}</div>${op.requiresRights ? '<div class="st-check st-rights"><label><input type="checkbox" name="e_rights"> I own this media or hold the rights to modify it.</label></div>' : ""}<p class="st-note">The original is never changed. The result is saved as a new asset linked to its source.</p><button class="primary wide"${disabledAttr()}>Process →</button></form></section><section class="panel"><h3>Results</h3><div id="st-results" aria-live="polite">${resultsHtml("enhance")}</div></section></div>`;
}

function characterSelect(id: string, usable: Character[], scopeText: string) {
  const project = getCurrentProjectId();
  return usable.length
    ? `<select id="${id}" name="${id}">${usable.map(character => `<option value="${esc(character.id)}">${esc(character.name)}</option>`).join("")}</select>`
    : `<select id="${id}" name="${id}" disabled><option>No character with current consent</option></select><small class="st-hint">${project ? `Add a character on Characters &amp; voices and record consent that covers ${scopeText}.` : "Select a project in the Runtime console first. Consent is recorded per project."}</small>`;
}

function avatarView() {
  const catalog = state.catalog;
  if (!catalog) return banner("avatar");
  const usable = state.characters.filter(character => consentCovers(character, "face-animation"));
  const syncable = state.characters.filter(character => consentCovers(character, "lip-sync"));
  const ap = (key: string) => catalog.avatar.params.find(s => s.key === key)!;
  const presenter = `<section class="panel"><div class="eyebrow">PRESENTER VIDEO</div><h2>Generate a presenter</h2>${banner("avatar")}<form id="st-avatar" class="st-form"><div><label for="a_character">Character (consent on record)</label>${characterSelect("a_character", usable, "face animation (and voice, if you set a voice reference)")}</div><div class="form-grid">${field(ap("avatarRef"), "a_")}${field(ap("voiceRef"), "a_")}</div>${assetSelect("a_audio", "Or use narration audio", ["audio/"], true, "Upload or generate narration audio first.")}${field(ap("script"), "a_")}<div class="form-grid">${["aspectRatio", "resolution", "background"].map(key => field(ap(key), "a_")).join("")}</div>${field(ap("captions"), "a_")}<button class="primary wide"${disabledAttr()}${usable.length ? "" : " disabled"}>Generate presenter video →</button></form></section>`;
  const lipsync = `<section class="panel"><div class="eyebrow">LIP-SYNC</div><h2>Match existing footage to new audio</h2>${banner("lipsync")}<form id="st-lipsync" class="st-form"><div><label for="l_character">Person on screen (consent on record)</label>${characterSelect("l_character", syncable, "lip-sync")}</div>${assetSelect("l_video", "Source video", ["video/"], false)}${assetSelect("l_audio", "New audio (a dub or a new line)", ["audio/"], false, "Upload or generate audio first.")}<div class="form-grid">${catalog.lipsync.params.map(spec => field(spec, "l_")).join("")}</div><p class="st-note">Only for people who have agreed to have their footage re-voiced. Lip-sync consent is checked when you submit and again when the job runs.</p><button class="primary wide"${disabledAttr()}${syncable.length ? "" : " disabled"}>Sync lips →</button></form></section>`;
  return `<div class="notice">A presenter or voice can represent a real person only with documented consent. Consent is checked when you submit and again when the job runs, so withdrawing it stops work still waiting in the queue.</div><div class="st-grid"><div class="st-stack">${presenter}${lipsync}</div><section class="panel"><h3>Results</h3><div id="st-results" aria-live="polite">${resultsHtml("avatar")}</div></section></div>`;
}

/* ---------- paint ---------- */

const viewFor = (kind: StudioKind) => (kind === "enhance" ? enhanceView() : avatarView());

export function renderStudio(kind: StudioKind) {
  state.visible = kind;
  state.touched = false;
  return `<div data-st-root="${kind}">${viewFor(kind)}</div>`;
}

function paintResults() {
  const target = document.querySelector<HTMLElement>("#st-results");
  if (target && state.visible) target.innerHTML = resultsHtml(state.visible);
}

function paintAll() {
  const root = document.querySelector<HTMLElement>("[data-st-root]");
  if (!root || !state.visible) return;
  root.innerHTML = viewFor(state.visible);
}

/* ---------- actions ---------- */

async function submitRun(body: Record<string, unknown>, button: HTMLButtonElement | null, path = "/api/studio/runs") {
  if (button) button.disabled = true;
  try {
    const projectId = getCurrentProjectId();
    await apiRequest(path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ ...body, ...(projectId ? { projectId } : {}) }) });
    await refreshJobs();
    paintResults();
    schedulePolling();
  } catch (error) {
    alert(message(error));
  } finally {
    if (button) button.disabled = false;
  }
}

function value(form: HTMLFormElement, name: string) {
  const raw = new FormData(form).get(name);
  return raw === null ? "" : String(raw);
}

function onSubmit(event: Event) {
  const form = event.target as HTMLFormElement;
  if (!form?.id?.startsWith("st-") || !state.catalog) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const button = form.querySelector<HTMLButtonElement>("button:not([type])");
  const catalog = state.catalog;
  if (form.id === "st-enhance") {
    const group = (form.dataset.group || "enhance") as Group;
    const op = (group === "enhance" ? catalog.enhance : group === "transform" ? catalog.transform : catalog.finishing).find(item => item.id === form.dataset.op);
    if (!op) return;
    const params = collectParams(form, op.params, "e_");
    if (group === "local") {
      // Local finishing jobs use the shared media queue, which takes flat parameters.
      const body: Record<string, unknown> = { jobType: op.id, sourceAssetId: value(form, "e_source"), ...params };
      if (op.secondary) body[op.secondary.field] = value(form, "e_second");
      void submitRun(body, button, "/api/jobs");
      return;
    }
    const body: Record<string, unknown> = { jobType: group === "enhance" ? "studio.enhance" : "studio.transform", operation: op.id, sourceAssetId: value(form, "e_source"), params };
    if (op.requiresRights) body.rightsAttested = value(form, "e_rights") === "on";
    void submitRun(body, button);
  } else if (form.id === "st-lipsync") {
    void submitRun({ jobType: "studio.lipsync", identityProfileId: value(form, "l_character"), sourceAssetId: value(form, "l_video"), audioAssetId: value(form, "l_audio"), params: collectParams(form, catalog.lipsync.params, "l_") }, button);
  } else if (form.id === "st-avatar") {
    const body: Record<string, unknown> = { jobType: "studio.avatar", identityProfileId: value(form, "a_character"), params: collectParams(form, catalog.avatar.params, "a_") };
    if (value(form, "a_audio")) body.audioAssetId = value(form, "a_audio");
    void submitRun(body, button);
  }
}

async function cancelJob(id: string) {
  try {
    await apiRequest(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    await refreshJobs();
    paintResults();
    schedulePolling();
  } catch (error) {
    alert(message(error));
  }
}

function onClick(event: Event) {
  const target = event.target as HTMLElement;
  const op = target.closest<HTMLElement>("[data-st-op]");
  if (op) { state.enhanceOp = op.dataset.stOp || "enhance:denoise"; paintAll(); return; }
  const cancel = target.closest<HTMLElement>("[data-st-cancel]");
  if (cancel) void cancelJob(cancel.dataset.stCancel || "");
}

function onInput(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.closest?.("[data-st-root]")) return;
  state.touched = true;
  if (input.matches("[data-st-range]")) {
    const out = input.parentElement?.querySelector("output");
    if (out) out.textContent = input.value;
  }
}

export async function initStudio() {
  document.addEventListener("submit", onSubmit);
  document.addEventListener("click", onClick);
  document.addEventListener("input", onInput);
  document.addEventListener("change", onInput);
  const reload = async () => {
    await loadAll();
    if (!document.querySelector("[data-st-root]")) return;
    if (state.touched) paintResults(); else paintAll();
    schedulePolling();
  };
  window.addEventListener("ev:authenticated", () => void reload());
  window.addEventListener("ev:assets-updated", () => void reload());
  window.addEventListener("ev:project-changed", () => void reload());
  await reload();
}
