import { breakdownScript, MAX_SCRIPT_CHARS, type DraftShot } from "../core/script-breakdown";
import { coachPrompt, applySuggestions } from "../core/prompt-coach";
import { fitAllTargets, type FitMode } from "../core/frame-fit";

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
  const rows = result.shots.map((s, i) =>
    '<li><b>' + (i + 1) + ". " + esc(s.scene) + '</b> · ' + s.duration + ' s<br><span>' + esc(s.action) + '</span><br><small>' +
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

/* ---------- Wiring ---------- */

export function initStudioTools(): void {
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
