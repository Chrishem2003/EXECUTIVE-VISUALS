import { breakdownScript, MAX_SCRIPT_CHARS, type DraftShot } from "../core/script-breakdown";
import { coachPrompt, applySuggestions } from "../core/prompt-coach";
import { fitAllTargets, type FitMode } from "../core/frame-fit";
import { exportStoryboard, EXPORT_FORMATS, type ExportFormat } from "../core/storyboard-export";
import { BUILT_IN_KITS, validateKit, type StyleKit } from "../core/style-kit";
import { planVariations, type Variation, type VaryAxis } from "../core/variation-plan";
import { listPresets } from "../core/presets";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ESCAPES[c] || c);
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector);

let lastDraft: DraftShot[] = [];

/* ---------- Script Breakdown ---------- */

export function scriptBreakdownMarkup(): string {
  return '<section class="panel tool-panel"><div class="eyebrow">SCRIPT BREAKDOWN</div><h3>Turn a script into a shot list</h3>' +
    '<p class="tool-note">Paste a script or outline. Scene headings such as INT. or EXT. start new scenes. Nothing is generated; you review the draft before it is added.</p>' +
    '<textarea id="script-input" rows="6" maxlength="' + MAX_SCRIPT_CHARS + '" placeholder="EXT. HARBOR - DAWN&#10;A fisherman walks toward the boat. Mist covers the water."></textarea>' +
    '<div class="tool-actions"><button type="button" class="secondary" data-script-run>Break into shots</button>' +
    '<button type="button" class="primary" data-script-add hidden>Add draft shots to storyboard</button></div>' +
    '<div id="script-result" class="tool-result" aria-live="polite"></div></section>';
}

function renderScriptResult(): void {
  const box = $("#script-result");
  const input = $<HTMLTextAreaElement>("#script-input");
  const addButton = $<HTMLButtonElement>("[data-script-add]");
  if (!box || !input) return;
  const result = breakdownScript(input.value);
  lastDraft = result.shots;
  if (addButton) {
    addButton.hidden = !result.shots.length;
    addButton.textContent = "Add " + result.shots.length + " draft shot" + (result.shots.length === 1 ? "" : "s") + " to storyboard";
  }
  const warnings = result.warnings.map(w => '<p class="notice">' + esc(w) + "</p>").join("");
  const rows = result.shots.map(s =>
    '<li><b>' + esc(s.scene) + '</b> · ' + s.duration + ' s<br><span>' + esc(s.action) + '</span><br><small>' +
    esc([s.camera, s.lens, s.movement].join(" · ")) + "</small></li>").join("");
  box.innerHTML = warnings + (rows ? '<p class="tool-note">' + result.shots.length + " shots · about " + result.totalSeconds + ' seconds</p><ol class="draft-list">' + rows + "</ol>" : "");
}

/* ---------- Prompt Coach ---------- */

export function promptCoachMarkup(): string {
  return '<section class="panel tool-panel"><div class="eyebrow">PROMPT COACH</div><h3>Check your prompt before you spend</h3>' +
    '<div id="coach-box" class="tool-result" aria-live="polite"><p class="tool-note">Start typing in the visual prompt box and tips appear here.</p></div>' +
    '<button type="button" class="secondary" data-coach-apply hidden>Add suggested details to my prompt</button></section>';
}

function renderCoach(): void {
  const box = $("#coach-box");
  const field = $<HTMLTextAreaElement>("#image textarea[name=prompt]");
  const button = $<HTMLButtonElement>("[data-coach-apply]");
  if (!box || !field) return;
  const result = coachPrompt(field.value, "image");
  if (button) button.hidden = !result.suggestedIds.length;
  if (!field.value.trim()) {
    box.innerHTML = '<p class="tool-note">Start typing in the visual prompt box and tips appear here.</p>';
    return;
  }
  const missing = result.checks.filter(c => !c.ok).map(c => "<li><b>" + esc(c.label) + ":</b> " + esc(c.tip) + "</li>").join("");
  box.innerHTML = '<div class="coach-score ' + result.level + '"><b>' + result.score + "</b><span>" + result.level + " · " + result.wordCount + " words</span></div>" +
    (missing ? '<ul class="coach-tips">' + missing + "</ul>" : '<p class="tool-note">Every check passed.</p>');
}

/* ---------- Frame Fit ---------- */

function frameFitResultMarkup(w: number, h: number, fx: number, fy: number, mode: FitMode): string {
  const rows = fitAllTargets(w, h, fx, fy, mode).map(r => {
    if (!r.ok || !r.target) return '<tr><td colspan="4" class="model-bad">' + esc((r.problems || []).join(" ")) + "</td></tr>";
    return "<tr><td>" + esc(r.target.label) + "</td><td>" + r.target.width + "×" + r.target.height + "</td><td>" + r.keptPercent + '%</td><td><button type="button" class="quiet" data-frame-copy="' +
      esc(r.ffmpegFilter) + '">Copy filter</button>' + (r.notes.length ? "<small> " + esc(r.notes[0]) + "</small>" : "") + "</td></tr>";
  }).join("");
  return '<table class="frame-table"><thead><tr><th>Shape</th><th>Output</th><th>Kept</th><th>FFmpeg filter</th></tr></thead><tbody>' + rows + "</tbody></table>";
}

export function frameFitMarkup(): string {
  return '<section class="panel tool-panel"><div class="eyebrow">FRAME FIT</div><h3>Reshape one video for every format</h3>' +
    '<p class="tool-note">Enter your video size and where the subject sits. Each format gets a crop (or bars) and a ready FFmpeg filter. Nothing is rendered here.</p>' +
    '<form id="frame-fit" class="form-grid"><label>Width<input name="w" type="number" min="16" max="16384" value="1920"></label>' +
    '<label>Height<input name="h" type="number" min="16" max="16384" value="1080"></label>' +
    '<label>Subject position, left to right<input name="fx" type="range" min="0" max="100" value="50"></label>' +
    '<label>Subject position, top to bottom<input name="fy" type="range" min="0" max="100" value="50"></label>' +
    '<label>Method<select name="mode"><option value="crop">Crop to fill</option><option value="letterbox">Keep whole frame with bars</option></select></label></form>' +
    '<div id="frame-fit-result" class="tool-result">' + frameFitResultMarkup(1920, 1080, 0.5, 0.5, "crop") + "</div></section>";
}

function updateFrameFit(): void {
  const form = $<HTMLFormElement>("#frame-fit");
  const out = $("#frame-fit-result");
  if (!form || !out) return;
  const data = new FormData(form);
  out.innerHTML = frameFitResultMarkup(
    Number(data.get("w")), Number(data.get("h")), Number(data.get("fx")) / 100, Number(data.get("fy")) / 100,
    data.get("mode") === "letterbox" ? "letterbox" : "crop"
  );
}


/* ---------- Storyboard export ---------- */

const FORMAT_LABELS: Record<ExportFormat, string> = { markdown: "Readable document (.md)", csv: "Spreadsheet (.csv)", timing: "Editor cue list (.txt)", json: "Data file (.json)" };

export function storyboardExportMarkup(): string {
  return '<section class="panel tool-panel"><div class="eyebrow">STORYBOARD EXPORT</div><h3>Take your shot list with you</h3>' +
    '<p class="tool-note">Download the storyboard with running times for your team, a spreadsheet, or an editor.</p>' +
    '<form id="export-form" class="form-grid"><label>Title<input name="title" maxlength="80" placeholder="My film"></label>' +
    '<label>Format<select name="format">' + EXPORT_FORMATS.map(f => '<option value="' + f + '">' + esc(FORMAT_LABELS[f]) + "</option>").join("") + "</select></label></form>" +
    '<div class="tool-actions"><button type="button" class="secondary" data-export-run>Download storyboard</button></div>' +
    '<div id="export-msg" class="tool-note" aria-live="polite"></div></section>';
}

function runExport(): void {
  const form = $<HTMLFormElement>("#export-form");
  const msg = $("#export-msg");
  if (!form || !msg) return;
  const data = new FormData(form);
  const format = String(data.get("format")) as ExportFormat;
  const title = String(data.get("title") || "");
  window.dispatchEvent(new CustomEvent("ev:storyboard-request", { detail: { reply: (shots: unknown[]) => {
    const result = exportStoryboard(shots, format, title);
    if (!result.ok) { msg.textContent = result.problems.join(" "); return; }
    const slug = (title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "storyboard");
    const url = URL.createObjectURL(new Blob([result.content], { type: result.mime + ";charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = slug + "." + result.extension;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    msg.textContent = "Downloaded " + result.shots + " shot" + (result.shots === 1 ? "" : "s") + " as " + link.download + ".";
  } } }));
}

/* ---------- Style kits ---------- */

const KIT_STORE = "ev.styleKits";

function customKits(): StyleKit[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KIT_STORE) || "[]");
    return (Array.isArray(raw) ? raw : []).map(item => validateKit(item)).filter(r => r.ok && r.kit).map(r => r.kit as StyleKit).slice(0, 12);
  } catch { return []; }
}

function saveCustomKits(kits: StyleKit[]): void {
  try { localStorage.setItem(KIT_STORE, JSON.stringify(kits)); } catch { /* storage unavailable */ }
}

function kitBodyMarkup(): string {
  const kits = [...BUILT_IN_KITS, ...customKits()];
  const presets = [...listPresets({ category: "light" }), ...listPresets({ category: "look" })];
  return '<label>Kit<select id="kit-select">' + kits.map(k => '<option value="' + esc(k.id) + '">' + esc(k.name) + (k.builtIn ? "" : " (yours)") + "</option>").join("") + "</select></label>" +
    '<p id="kit-summary" class="tool-note">' + esc(kits[0].summary) + "</p>" +
    '<div class="tool-actions"><button type="button" class="primary" data-kit-apply>Apply to every shot</button></div>' +
    '<details class="kit-make"><summary>Make your own kit</summary><form id="kit-form" class="form-grid"><label>Name<input name="name" maxlength="40" placeholder="My look"></label>' +
    '<fieldset class="kit-presets"><legend>Pick up to 6 light and look presets</legend>' +
    presets.map(p => '<label class="kit-check"><input type="checkbox" name="p" value="' + esc(p.id) + '"> ' + esc(p.name) + "</label>").join("") +
    '</fieldset></form><div class="tool-actions"><button type="button" class="secondary" data-kit-save>Save kit</button></div></details>' +
    '<div id="kit-msg" class="tool-note" aria-live="polite"></div>';
}

export function styleKitMarkup(): string {
  return '<section class="panel tool-panel" id="kit-panel"><div class="eyebrow">STYLE KITS</div><h3>One look across the whole storyboard</h3>' +
    '<p class="tool-note">A kit sets the same lighting and look on every shot, so the film feels like one piece.</p>' + kitBodyMarkup() + "</section>";
}

function selectedKit(): StyleKit | undefined {
  const id = $<HTMLSelectElement>("#kit-select")?.value;
  return [...BUILT_IN_KITS, ...customKits()].find(k => k.id === id);
}

/* ---------- Variations ---------- */

let lastVariations: Variation[] = [];

export function variationMarkup(): string {
  return '<section class="panel tool-panel"><div class="eyebrow">DRAFT VARIATIONS</div><h3>Try a few takes before you commit</h3>' +
    '<p class="tool-note">Each variation changes one thing in your prompt. Compare cheap drafts, then spend on the one you like.</p>' +
    '<form id="variation-form" class="form-grid"><label>Change<select name="axis">' + (["light", "look"] as VaryAxis[]).map(a => '<option value="' + a + '">' + (a === "light" ? "Lighting" : "Overall look") + "</option>").join("") + "</select></label>" +
    '<label>How many<input name="count" type="number" min="2" max="8" value="4"></label></form>' +
    '<div class="tool-actions"><button type="button" class="secondary" data-var-run>Plan variations</button></div>' +
    '<div id="variation-result" class="tool-result" aria-live="polite"></div></section>';
}

function renderVariations(): void {
  const field = $<HTMLTextAreaElement>("#image textarea[name=prompt]");
  const form = $<HTMLFormElement>("#variation-form");
  const box = $("#variation-result");
  if (!field || !form || !box) return;
  const data = new FormData(form);
  const plan = planVariations(field.value, { axis: String(data.get("axis")) as VaryAxis, count: Number(data.get("count")), target: "image" });
  lastVariations = plan.variations;
  if (!plan.ok) { box.innerHTML = '<p class="notice">' + esc(plan.problems.join(" ")) + "</p>"; return; }
  box.innerHTML = '<ol class="draft-list">' + plan.variations.map(v =>
    "<li><b>" + v.index + ". " + esc(v.label) + "</b><br><span>" + esc(v.prompt) + '</span><br><button type="button" class="quiet" data-var-copy="' + v.index +
    '">Copy</button><button type="button" class="quiet" data-var-use="' + v.index + '">Use this prompt</button></li>').join("") + "</ol>";
}

function initExtraTools(): void {
  document.addEventListener("click", async event => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-export-run]")) { runExport(); return; }
    if (target.closest("[data-kit-apply]")) {
      const kit = selectedKit();
      if (kit) window.dispatchEvent(new CustomEvent("ev:apply-kit", { detail: { kit } }));
      return;
    }
    if (target.closest("[data-kit-save]")) {
      const form = $<HTMLFormElement>("#kit-form");
      const msg = $("#kit-msg");
      if (!form || !msg) return;
      const data = new FormData(form);
      const result = validateKit({ name: String(data.get("name") || ""), presetIds: data.getAll("p").map(String) });
      if (!result.ok || !result.kit) { msg.textContent = result.problems.join(" "); return; }
      const kits = customKits().filter(k => k.id !== result.kit?.id);
      saveCustomKits([...kits, result.kit]);
      const panel = $("#kit-panel");
      if (panel) panel.outerHTML = styleKitMarkup();
      const note = $("#kit-msg"); if (note) note.textContent = "Saved " + result.kit.name + ". It is stored in this browser only.";
      return;
    }
    if (target.closest("[data-var-run]")) { renderVariations(); return; }
    const copy = target.closest<HTMLElement>("[data-var-copy]");
    const use = target.closest<HTMLElement>("[data-var-use]");
    const pick = copy || use;
    if (pick) {
      const found = lastVariations.find(v => String(v.index) === (pick.dataset.varCopy || pick.dataset.varUse));
      if (!found) return;
      if (use) {
        const field = $<HTMLTextAreaElement>("#image textarea[name=prompt]");
        if (field) { field.value = found.prompt; field.dispatchEvent(new Event("input", { bubbles: true })); }
      } else { try { await navigator.clipboard.writeText(found.prompt); } catch { /* clipboard unavailable */ } }
    }
  });
  document.addEventListener("change", event => {
    if ((event.target as HTMLElement).matches("#kit-select")) {
      const kit = selectedKit();
      const summary = $("#kit-summary");
      if (kit && summary) summary.textContent = kit.summary;
    }
  });
}

/* ---------- Wiring ---------- */

export function initStudioTools(): void {
  initExtraTools();
  document.addEventListener("click", async event => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-script-run]")) { renderScriptResult(); return; }
    if (target.closest("[data-script-add]")) {
      if (lastDraft.length) window.dispatchEvent(new CustomEvent("ev:script-shots", { detail: { shots: lastDraft } }));
      return;
    }
    if (target.closest("[data-coach-apply]")) {
      const field = $<HTMLTextAreaElement>("#image textarea[name=prompt]");
      if (!field) return;
      field.value = applySuggestions(field.value, coachPrompt(field.value, "image")).prompt;
      renderCoach();
      return;
    }
    const copy = target.closest<HTMLElement>("[data-frame-copy]");
    if (copy) { try { await navigator.clipboard.writeText(copy.dataset.frameCopy || ""); } catch { /* clipboard unavailable */ } }
  });
  document.addEventListener("input", event => {
    const target = event.target as HTMLElement;
    if (target.matches("#image textarea[name=prompt]")) renderCoach();
    else if (target.closest("#frame-fit")) updateFrameFit();
  });
  document.addEventListener("change", event => {
    if ((event.target as HTMLElement).closest("#frame-fit")) updateFrameFit();
  });
}
