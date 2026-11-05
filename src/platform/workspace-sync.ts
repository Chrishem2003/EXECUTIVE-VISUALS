// Keeps a signed-in person's workspace saved to their account, so it survives restarts and
// follows them to another device. Local saving in the browser keeps working regardless.
//
// Safety rules:
//  - Never overwrites newer work from another device without asking (revision check).
//  - Never replaces local work without keeping a backup that can be undone.
//  - Anything restored from the cloud is validated first.

import { apiRequest, ApiError } from "../core/api";
import { sanitizeWorkspace, isEmptyWorkspace, workspaceFingerprint, describeWorkspace, type WorkspaceSnapshot } from "../core/workspace-snapshot";

interface Hooks {
  getSnapshot: () => WorkspaceSnapshot;
  restore: (data: WorkspaceSnapshot) => void;
}

interface WorkspaceResponse {
  enabled: boolean;
  reason?: string;
  userId?: string;
  found?: boolean;
  revision?: number;
  updatedAt?: string | null;
  data?: unknown;
}

type Status = "starting" | "off" | "signed-out" | "not-set-up" | "synced" | "dirty" | "saving" | "offline" | "conflict" | "error";

const SAVE_DELAY_MS = 3000;
const RETRY_MS = 30000;
const BACKUP_KEY = "ev.workspaceBackup";
const recordKey = (userId: string) => "ev.workspaceSync." + userId;

let hooks: Hooks | null = null;
let status: Status = "starting";
let userId = "";
let revision = 0;
let lastFingerprint = "";
let ready = false;
let inFlight = false;
let saveAgain = false;
let saveTimer = 0;
let retryTimer = 0;
let remoteCopy: { data: WorkspaceSnapshot; revision: number; updatedAt: string } | null = null;
let lastError = "";
let lastSavedAt = 0;

const store = {
  read(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  write(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }
};

function rememberRevision(): void {
  if (userId) store.write(recordKey(userId), JSON.stringify({ revision, fingerprint: lastFingerprint }));
}

function recalled(): { revision: number; fingerprint: string } | null {
  if (!userId) return null;
  try {
    const parsed = JSON.parse(store.read(recordKey(userId)) || "null");
    return parsed && Number.isInteger(parsed.revision) && typeof parsed.fingerprint === "string" ? parsed : null;
  } catch { return null; }
}

/* ---------- Interface ---------- */

const LABELS: Record<Status, string> = {
  starting: "Checking cloud save…",
  off: "",
  "signed-out": "Saved on this device only",
  "not-set-up": "Cloud save not set up",
  synced: "☁ Saved to your account",
  dirty: "☁ Changes not saved yet",
  saving: "☁ Saving…",
  offline: "Offline · saved on this device",
  conflict: "⚠ Two versions of your work",
  error: "⚠ Could not save · will retry"
};

function titleFor(): string {
  switch (status) {
    case "signed-out": return "Sign in to keep your work in your account and open it on other devices.";
    case "not-set-up": return "The site owner needs to run the one-time database setup before work can be saved to accounts.";
    case "synced": return lastSavedAt ? "Last saved " + new Date(lastSavedAt).toLocaleTimeString() : "Your work is saved to your account.";
    case "conflict": return "Click to choose which version to keep.";
    case "error": return lastError || "Your work is still safe on this device.";
    default: return "";
  }
}

function chip(): HTMLElement | null {
  let el = document.getElementById("ev-sync-status");
  if (el) return el;
  const bar = document.querySelector(".topbar-actions") || document.querySelector(".topbar");
  if (!bar) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.id = "ev-sync-status";
  button.className = "sync-chip";
  button.addEventListener("click", () => { if (status === "conflict") showConflict(); else if (status === "error" || status === "offline" || status === "signed-out") void reconcile(); });
  bar.insertBefore(button, bar.firstChild);
  return button;
}

function paint(): void {
  const el = chip();
  if (!el) return;
  el.hidden = status === "off";
  el.textContent = LABELS[status];
  el.title = titleFor();
  el.dataset.state = status;
}

function layer(): HTMLElement {
  let el = document.getElementById("ev-sync-layer");
  if (!el) { el = document.createElement("div"); el.id = "ev-sync-layer"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite"); document.body.appendChild(el); }
  return el;
}

function notice(message: string, action?: { label: string; run: () => void }): void {
  const box = document.createElement("div");
  box.className = "sync-toast";
  const text = document.createElement("span");
  text.textContent = message;
  box.appendChild(text);
  const close = () => box.remove();
  if (action) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "quiet"; button.textContent = action.label;
    button.addEventListener("click", () => { action.run(); close(); });
    box.appendChild(button);
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button"; dismiss.className = "quiet"; dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", close);
  box.appendChild(dismiss);
  layer().appendChild(box);
  window.setTimeout(close, 20000);
}

function setStatus(next: Status): void { status = next; paint(); }

/* ---------- Saving and restoring ---------- */

function backupLocal(): void {
  if (!hooks) return;
  store.write(BACKUP_KEY, JSON.stringify({ savedAt: new Date().toISOString(), data: hooks.getSnapshot() }));
}

function undoRestore(): void {
  if (!hooks) return;
  try {
    const backup = JSON.parse(store.read(BACKUP_KEY) || "null");
    const clean = sanitizeWorkspace(backup && backup.data);
    if (clean.ok) { hooks.restore(clean.data); schedulePush(); }
  } catch { /* nothing to undo */ }
}

function applyRemote(data: WorkspaceSnapshot, remoteRevision: number, announce: boolean): void {
  if (!hooks) return;
  const hadWork = !isEmptyWorkspace(hooks.getSnapshot());
  if (hadWork) backupLocal();
  hooks.restore(data);
  revision = remoteRevision;
  lastFingerprint = workspaceFingerprint(hooks.getSnapshot());
  rememberRevision();
  remoteCopy = null;
  setStatus("synced");
  if (announce) notice("Restored your saved work (" + describeWorkspace(data) + ").", hadWork ? { label: "Undo", run: undoRestore } : undefined);
}

function failureStatus(error: unknown): void {
  if (error instanceof ApiError) {
    if (error.status === 401) { setStatus("signed-out"); return; }
    if (error.code === "WORKSPACE_NOT_SET_UP") { setStatus("not-set-up"); return; }
    lastError = error.message;
    setStatus("error");
    return;
  }
  setStatus("offline");
}

async function push(): Promise<void> {
  if (!hooks || !ready || inFlight || status === "conflict") return;
  const snapshot = hooks.getSnapshot();
  const fingerprint = workspaceFingerprint(snapshot);
  if (fingerprint === lastFingerprint) { setStatus("synced"); return; }
  inFlight = true;
  setStatus("saving");
  try {
    const saved = await apiRequest<{ revision: number }>("/api/workspace", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: snapshot, expectedRevision: revision })
    });
    revision = saved.revision;
    lastFingerprint = fingerprint;
    lastSavedAt = Date.now();
    rememberRevision();
    setStatus("synced");
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      await loadConflict();
    } else {
      failureStatus(error);
      if (status === "error" || status === "offline") scheduleRetry();
    }
  } finally {
    inFlight = false;
    if (saveAgain) { saveAgain = false; schedulePush(); }
  }
}

function schedulePush(): void {
  if (!hooks) return;
  if (!ready) { if (status === "signed-out" || status === "offline" || status === "error") scheduleRetry(); return; }
  if (status === "conflict" || status === "off" || status === "not-set-up") return;
  if (inFlight) { saveAgain = true; return; }
  if (workspaceFingerprint(hooks.getSnapshot()) === lastFingerprint) return;
  setStatus("dirty");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void push(); }, SAVE_DELAY_MS);
}

function scheduleRetry(): void {
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => { if (ready) void push(); else void reconcile(); }, RETRY_MS);
}

/* ---------- Two versions ---------- */

async function loadConflict(): Promise<void> {
  try {
    const current = await apiRequest<WorkspaceResponse>("/api/workspace");
    const clean = sanitizeWorkspace(current.data);
    remoteCopy = { data: clean.data, revision: Number(current.revision) || 0, updatedAt: String(current.updatedAt || "") };
    setStatus("conflict");
    showConflict();
  } catch (error) { failureStatus(error); }
}

/** " (saved 14:32)" when the time is a real date, otherwise nothing. */
function savedAt(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? " (saved " + new Date(time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) + ")" : "";
}

function showConflict(): void {
  if (!hooks || !remoteCopy) return;
  document.getElementById("ev-sync-conflict")?.remove();
  const mine = hooks.getSnapshot();
  const theirs = remoteCopy;
  const box = document.createElement("div");
  box.id = "ev-sync-conflict";
  box.className = "sync-conflict";
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-label", "Choose which version to keep");
  const title = document.createElement("b");
  title.textContent = "Your work was changed on another device";
  const body = document.createElement("p");
  body.textContent = "In your account" + savedAt(theirs.updatedAt) + ": " + describeWorkspace(theirs.data) + ". On this device: " + describeWorkspace(mine) + ". Which would you like to keep? You can undo if you pick the account version.";
  const useSaved = document.createElement("button");
  useSaved.type = "button"; useSaved.className = "primary"; useSaved.textContent = "Use the version from my account";
  useSaved.addEventListener("click", () => { box.remove(); applyRemote(theirs.data, theirs.revision, true); });
  const keepMine = document.createElement("button");
  keepMine.type = "button"; keepMine.className = "secondary"; keepMine.textContent = "Keep this device’s version";
  keepMine.addEventListener("click", () => { box.remove(); revision = theirs.revision; remoteCopy = null; setStatus("dirty"); ready = true; lastFingerprint = ""; void push(); });
  const later = document.createElement("button");
  later.type = "button"; later.className = "quiet"; later.textContent = "Decide later";
  later.addEventListener("click", () => box.remove());
  box.append(title, body, useSaved, keepMine, later);
  layer().appendChild(box);
  useSaved.focus();
}

/* ---------- Start up ---------- */

async function reconcile(): Promise<void> {
  if (!hooks || inFlight) return;
  setStatus("starting");
  let response: WorkspaceResponse;
  try {
    response = await apiRequest<WorkspaceResponse>("/api/workspace");
  } catch (error) {
    failureStatus(error);
    if (status === "signed-out" || status === "offline" || status === "error") scheduleRetry();
    return;
  }
  if (!response.enabled) { setStatus("off"); return; }
  userId = typeof response.userId === "string" ? response.userId : "";
  const local = hooks.getSnapshot();
  const localEmpty = isEmptyWorkspace(local);

  if (!response.found) {
    revision = 0;
    lastFingerprint = "";
    ready = true;
    if (localEmpty) { lastFingerprint = workspaceFingerprint(local); setStatus("synced"); } else await push();
    return;
  }

  const clean = sanitizeWorkspace(response.data);
  const remote = clean.data;
  const remoteRevision = Number(response.revision) || 0;
  const remoteFingerprint = workspaceFingerprint(remote);
  const localFingerprint = workspaceFingerprint(local);
  ready = true;

  if (remoteFingerprint === localFingerprint) {
    revision = remoteRevision; lastFingerprint = localFingerprint; rememberRevision(); setStatus("synced"); return;
  }
  if (localEmpty) { applyRemote(remote, remoteRevision, true); return; }
  if (isEmptyWorkspace(remote)) { revision = remoteRevision; lastFingerprint = ""; await push(); return; }

  // Both have work. If this device last synced at exactly this revision, the remote has not
  // changed since, so the local edits are simply newer and can be saved.
  const known = recalled();
  if (known && known.revision === remoteRevision && known.fingerprint === remoteFingerprint) {
    revision = remoteRevision; lastFingerprint = remoteFingerprint; await push(); return;
  }
  revision = remoteRevision;
  remoteCopy = { data: remote, revision: remoteRevision, updatedAt: String(response.updatedAt || "") };
  setStatus("conflict");
  showConflict();
}

export function initWorkspaceSync(provided: Hooks): void {
  hooks = provided;
  paint();
  window.addEventListener("ev:save-creative-draft", () => schedulePush());
  window.addEventListener("ev:authenticated", () => { ready = false; void reconcile(); });
  window.addEventListener("online", () => { if (!ready) void reconcile(); else schedulePush(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !ready && status !== "off" && status !== "not-set-up") void reconcile(); });
  void reconcile();
}
