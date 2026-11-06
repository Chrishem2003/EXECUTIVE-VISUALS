// Shows a person's credit balance in the top bar when credits are switched on.
// The server is the only authority: this file just displays what /api/credits says.

import { apiRequest } from "../core/api";

interface CreditView {
  enabled: boolean;
  balance?: number;
  dailyFree?: number;
  nextRefillAtMs?: number;
  costs?: Record<string, number>;
}

const REFRESH_MS = 60_000;
let chip: HTMLButtonElement | null = null;
let timer: number | undefined;
let signedIn = false;

function mount(): HTMLButtonElement | null {
  if (chip && document.body.contains(chip)) return chip;
  const bar = document.querySelector(".topbar-actions") || document.querySelector(".topbar");
  if (!bar) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.id = "ev-credit-chip";
  button.className = "sync-chip credit-chip";
  button.hidden = true;
  bar.insertBefore(button, bar.firstChild);
  chip = button;
  return button;
}

function describe(view: CreditView): string {
  const names: Record<string, string> = {
    "text.generate": "Text", "voice.generate": "Voice", "image.generate": "Image", "video.generate": "Video"
  };
  const costs = Object.entries(view.costs || {}).filter(([key]) => names[key]).map(([key, value]) => names[key] + " " + value).join(" · ");
  const refill = view.nextRefillAtMs ? new Date(view.nextRefillAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return "Free credits refill daily" + (refill ? " (next at " + refill + ")" : "") + ". Cost per request: " + costs + ".";
}

export async function refreshCredits(): Promise<void> {
  const button = mount();
  if (!button || !signedIn) return;
  try {
    const view = await apiRequest<CreditView>("/api/credits");
    if (!view.enabled) { button.hidden = true; return; }
    const balance = Number(view.balance ?? 0);
    button.hidden = false;
    button.dataset.state = balance <= 0 ? "error" : "synced";
    button.textContent = "✦ " + balance + (balance === 1 ? " credit" : " credits");
    button.title = describe(view);
  } catch {
    button.hidden = true;
  }
}

export function initCredits(): void {
  window.addEventListener("ev:authenticated", () => {
    signedIn = true;
    void refreshCredits();
    if (timer === undefined) timer = window.setInterval(() => void refreshCredits(), REFRESH_MS);
  });
  window.addEventListener("ev:credits-changed", () => void refreshCredits());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshCredits(); });
}
