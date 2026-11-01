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
interface EnhanceOp { id: string; label: string; description: string; media: string[]; params: Spec[]; requiresRights?: boolean }
interface Catalog { engines: Record<"enhance" | "avatar", EngineState>; enhance: EnhanceOp[]; avatar: { params: Spec[] } }
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
  enhanceOp: "denoise",
  touched: false,
  visible: "" as StudioKind | ""
};
let pollTimer: number | undefined;

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
const ACTIVE = new Set(["queued", "running", "reviewing"]);
const JOBS_BY_KIND: Record<StudioKind, string> = { enhance: "studio.enhance", avatar: "studio.avatar" };
const JOB_LABEL: Record<string, string> = { "studio.enhance": "Neural enhancement", "studio.avatar": "Presenter video" };

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
    state.jobs = jobs.jobs.filter(job => job.jobType.startsWith("studio."));
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
    state.jobs = result.jobs.filter(job => job.jobType.startsWith("studio."));
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
  return String(params.script || job.input.operation || "").slice(0, 140);
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
  return `<article class="st-result"><div class="st-result-head"><div><b>${esc(JOB_LABEL[job.jobType] || job.jobType)}</b><small>${esc(created)}</small></div><span class="st-chip st-${esc(job.status)}">${esc(job.status)}</span></div>${summaryOf(job) ? `<p class="st-summary">${esc(summaryOf(job))}</p>` : ""}${bar}${error}${output ? preview(output) + `<div class="st-actions"><a class="st-link" href="/api/assets/${encodeURIComponent(output.id)}/file" download="${esc(output.name)}">Download</a></div>` : ""}${active ? `<div class="st-actions"><button type="button" class="quiet" data-st-cancel="${esc(job.id)}">Cancel run</button></div>` : ""}</article>`;
}

function resultsHtml(kind: StudioKind) {
  const rows = state.jobs.filter(job => job.jobType === JOBS_BY_KIND[kind]).slice(0, 12);
  return rows.length ? rows.map(resultCard).join("") : '<div class="empty">Nothing generated yet. Finished work appears here with a preview and a download link.</div>';
}

/* ---------- views ---------- */

function banner(engine: "enhance" | "avatar") {
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

const disabledAttr = () => (state.signedOut || !state.catalog ? " disabled" : "");

function enhanceView() {
  const catalog = state.catalog;
  if (!catalog) return banner("enhance");
  const op = catalog.enhance.find(item => item.id === state.enhanceOp) || catalog.enhance[0]!;
  const prefixes = op.media.map(media => `${media}/`);
  return `<div class="section-title"><div class="eyebrow">NEURAL ENHANCEMENT · YOUR OWN GATEWAY</div><h2>Restore, upscale and clean up</h2></div>${banner("enhance")}<div class="st-ops" role="tablist" aria-label="Enhancement operations">${catalog.enhance.map(item => `<button type="button" role="tab" aria-selected="${item.id === op.id}" class="st-op${item.id === op.id ? " active" : ""}" data-st-op="${esc(item.id)}"><b>${esc(item.label)}</b><small>${esc(item.description)}</small></button>`).join("")}</div><div class="st-grid"><section class="panel"><div class="eyebrow">${esc(op.label.toUpperCase())}</div><h2>${esc(op.label)}</h2><form id="st-enhance" class="st-form" data-op="${esc(op.id)}">${assetSelect("e_source", "Source media", prefixes, false)}<div class="form-grid">${op.params.map(spec => field(spec, "e_")).join("")}</div>${op.requiresRights ? '<div class="st-check st-rights"><label><input type="checkbox" name="e_rights"> I own this media or hold the rights to modify it.</label></div>' : ""}<p class="st-note">The original is never changed. The result is saved as a new asset linked to its source.</p><button class="primary wide"${disabledAttr()}>Process →</button></form></section><section class="panel"><h3>Results</h3><div id="st-results" aria-live="polite">${resultsHtml("enhance")}</div></section></div>`;
}

function avatarView() {
  const catalog = state.catalog;
  if (!catalog) return banner("avatar");
  const project = getCurrentProjectId();
  const usable = state.characters.filter(character => consentCovers(character, "face-animation"));
  const ap = (key: string) => catalog.avatar.params.find(s => s.key === key)!;
  const people = usable.length
    ? `<select id="a_character" name="a_character">${usable.map(character => `<option value="${esc(character.id)}">${esc(character.name)}</option>`).join("")}</select>`
    : `<select id="a_character" name="a_character" disabled><option>No character with current consent</option></select><small class="st-hint">${project ? "Add a character on Characters &amp; voices and record consent that covers face animation (and voice, if you set a voice reference)." : "Select a project in the Runtime console first. Consent is recorded per project."}</small>`;
  return `${banner("avatar")}<div class="notice">A presenter or voice can represent a real person only with documented consent. Consent is checked when you submit and again when the job runs, so withdrawing it stops work still waiting in the queue.</div><div class="st-grid"><section class="panel"><div class="eyebrow">PRESENTER VIDEO</div><h2>Generate a presenter</h2><form id="st-avatar" class="st-form"><div><label for="a_character">Character (consent on record)</label>${people}</div><div class="form-grid">${field(ap("avatarRef"), "a_")}${field(ap("voiceRef"), "a_")}</div>${assetSelect("a_audio", "Or use narration audio", ["audio/"], true, "Upload or generate narration audio first.")}${field(ap("script"), "a_")}<div class="form-grid">${["aspectRatio", "resolution", "background"].map(key => field(ap(key), "a_")).join("")}</div>${field(ap("captions"), "a_")}<button class="primary wide"${disabledAttr()}${usable.length ? "" : " disabled"}>Generate presenter video →</button></form></section><section class="panel"><h3>Results</h3><div id="st-results" aria-live="polite">${resultsHtml("avatar")}</div></section></div>`;
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

async function submitRun(body: Record<string, unknown>, button: HTMLButtonElement | null) {
  if (button) button.disabled = true;
  try {
    const projectId = getCurrentProjectId();
    await apiRequest("/api/studio/runs", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ ...body, ...(projectId ? { projectId } : {}) }) });
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
    const op = catalog.enhance.find(item => item.id === form.dataset.op);
    if (!op) return;
    const body: Record<string, unknown> = { jobType: "studio.enhance", operation: op.id, sourceAssetId: value(form, "e_source"), params: collectParams(form, op.params, "e_") };
    if (op.requiresRights) body.rightsAttested = value(form, "e_rights") === "on";
    void submitRun(body, button);
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
  if (op) { state.enhanceOp = op.dataset.stOp || "denoise"; paintAll(); return; }
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
