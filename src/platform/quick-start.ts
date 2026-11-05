import { TEMPLATES, buildQuickStart, MAX_TOPIC, MIN_SECONDS, MAX_SECONDS, type QuickStartResult } from "../core/quick-start";
import { BUILT_IN_KITS } from "../core/style-kit";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ESCAPES[c] || c);
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector);

let last: QuickStartResult | null = null;

export function quickStartMarkup(): string {
  const cards = TEMPLATES.map((t, i) =>
    '<label class="qs-card"><input type="radio" name="template" value="' + esc(t.id) + '"' + (i === 0 ? " checked" : "") + '>' +
    "<b>" + esc(t.name) + "</b><span>" + esc(t.tagline) + "</span><small>" + esc(t.forWho) + "</small></label>").join("");
  return '<section class="panel qs-panel" id="quick-start"><div class="eyebrow">QUICK START · NO SIGN-UP, NO COST</div>' +
    "<h2>What do you want to make?</h2>" +
    '<p class="tool-note">Pick one, type your topic, and get a complete draft in seconds: shots, style, the right size for your platform, opening lines and a checklist before you publish.</p>' +
    '<form id="qs-form"><div class="qs-cards" role="radiogroup" aria-label="What to make">' + cards + "</div>" +
    '<div class="form-grid"><label>Your topic<input name="topic" maxlength="' + MAX_TOPIC + '" placeholder="Example: Mama Rose hand-made soap" autocomplete="off"></label>' +
    '<label>Length in seconds<input name="seconds" type="number" min="' + MIN_SECONDS + '" max="' + MAX_SECONDS + '" placeholder="Leave empty for the suggested length"></label></div>' +
    '<div class="tool-actions"><button type="submit" class="primary">Build my draft</button></div></form>' +
    '<div id="qs-result" class="tool-result" aria-live="polite"></div></section>';
}

function resultMarkup(r: QuickStartResult): string {
  if (!r.ok) return '<p class="notice">' + esc(r.problems.join(" ")) + "</p>";
  const kit = BUILT_IN_KITS.find(k => k.id === r.kitId);
  const shots = r.shots.map(s => "<li><b>" + esc(s.scene) + "</b> · " + s.duration + " s<br><span>" + esc(s.action) + "</span><br><small>" +
    esc([s.camera, s.lens, s.movement].filter(Boolean).join(" · ")) + "</small></li>").join("");
  const hooks = r.hooks.map((h, i) => '<li><span>' + esc(h) + '</span> <button type="button" class="quiet" data-qs-copy-hook="' + i + '">Copy</button></li>').join("");
  const checks = r.checklist.map(c => "<li>" + esc(c) + "</li>").join("");
  return (r.problems.length ? '<p class="notice">' + esc(r.problems.join(" ")) + "</p>" : "") +
    '<p class="tool-note"><b>' + esc(r.template?.name) + "</b> · " + r.shots.length + " shots · " + r.totalSeconds + " seconds · best size " + esc(r.frameLabel) +
    (kit ? " · style: " + esc(kit.name) : "") + "</p>" +
    '<ol class="draft-list">' + shots + "</ol>" +
    '<h3 class="qs-sub">Opening lines to try</h3><ul class="qs-hooks">' + hooks + "</ul>" +
    '<h3 class="qs-sub">Before you publish</h3><ul class="qs-checks">' + checks + "</ul>" +
    '<div class="tool-actions"><button type="button" class="primary" data-qs-add>Add ' + r.shots.length + " shots to my storyboard</button>" +
    '<button type="button" class="secondary" data-qs-copy-prompts>Copy all shot prompts</button></div><div id="qs-msg" class="tool-note"></div>';
}

export function initQuickStart(): void {
  document.addEventListener("submit", event => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>("#qs-form");
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    last = buildQuickStart({ templateId: String(data.get("template") || ""), topic: data.get("topic"), seconds: data.get("seconds") });
    const box = $("#qs-result");
    if (box) box.innerHTML = resultMarkup(last);
  });
  document.addEventListener("click", async event => {
    const target = event.target as HTMLElement;
    if (!last || !last.ok) return;
    const say = (text: string) => { const m = $("#qs-msg"); if (m) m.textContent = text; };
    if (target.closest("[data-qs-add]")) {
      window.dispatchEvent(new CustomEvent("ev:quick-start-add", { detail: { shots: last.shots } }));
      return;
    }
    if (target.closest("[data-qs-copy-prompts]")) {
      try { await navigator.clipboard.writeText(last.prompts.map((p, i) => (i + 1) + ". " + p).join("\n\n")); say("Copied " + last.prompts.length + " prompts."); } catch { say("Your browser blocked copying."); }
      return;
    }
    const hook = target.closest<HTMLElement>("[data-qs-copy-hook]");
    if (hook) {
      const text = last.hooks[Number(hook.dataset.qsCopyHook)];
      if (text) { try { await navigator.clipboard.writeText(text); say("Copied."); } catch { say("Your browser blocked copying."); } }
    }
  });
}
