// Decides what part of the workspace is saved to a person's account, and checks anything
// restored from the cloud before the app uses it. Pure functions: no browser, no network.
//
// Only an allow-list of keys is ever saved or restored. Uploaded media, sign-in details and
// temporary screen state are deliberately left out.

export const LIST_KEYS = ["projects", "tasks", "shots", "characters", "seriesPlans"] as const;
export const TEXT_LIST_KEYS = ["variants", "graph"] as const;
export const TEXT_KEYS = ["prompt", "plan", "script", "activeProject", "activeSeriesId"] as const;

export const MAX_LIST_ITEMS = 500;
export const MAX_TEXT_ITEMS = 100;
export const MAX_TEXT_CHARS = 20000;
export const MAX_ITEM_TEXT_CHARS = 2000;

export type WorkspaceSnapshot = Partial<Record<(typeof LIST_KEYS)[number], Record<string, unknown>[]>> &
  Partial<Record<(typeof TEXT_LIST_KEYS)[number], string[]>> &
  Partial<Record<(typeof TEXT_KEYS)[number], string>>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Copy plain JSON only: drops functions, undefined and class instances, and breaks shared references. */
function cloneJson<T>(value: T): T | undefined {
  try { return JSON.parse(JSON.stringify(value)) as T; } catch { return undefined; }
}

/** The savable part of the app state, in a fixed key order. Anything unusable is skipped. */
export function pickWorkspace(state: Record<string, unknown>): WorkspaceSnapshot {
  const out: Record<string, unknown> = {};
  for (const key of LIST_KEYS) {
    const value = state[key];
    if (Array.isArray(value)) { const copy = cloneJson(value.filter(isPlainObject)); if (copy) out[key] = copy; }
  }
  for (const key of TEXT_LIST_KEYS) {
    const value = state[key];
    if (Array.isArray(value)) out[key] = value.filter((item): item is string => typeof item === "string");
  }
  for (const key of TEXT_KEYS) {
    const value = state[key];
    if (typeof value === "string") out[key] = value;
  }
  return out as WorkspaceSnapshot;
}

export interface SanitizeResult {
  ok: boolean;
  data: WorkspaceSnapshot;
  /** Plain-language notes about anything dropped or shortened. */
  notes: string[];
}

/** Validate a snapshot that came from the cloud. Never throws; unknown or malformed parts are dropped. */
export function sanitizeWorkspace(raw: unknown): SanitizeResult {
  const notes: string[] = [];
  if (!isPlainObject(raw)) return { ok: false, data: {}, notes: ["The saved workspace could not be read."] };
  const data: Record<string, unknown> = {};

  for (const key of LIST_KEYS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (!Array.isArray(value)) { notes.push("Skipped " + key + ": not a list."); continue; }
    const items = value.filter(isPlainObject);
    if (items.length !== value.length) notes.push("Dropped " + (value.length - items.length) + " unreadable item(s) from " + key + ".");
    if (items.length > MAX_LIST_ITEMS) notes.push("Kept the first " + MAX_LIST_ITEMS + " items of " + key + ".");
    const copy = cloneJson(items.slice(0, MAX_LIST_ITEMS));
    if (copy) data[key] = copy;
  }
  for (const key of TEXT_LIST_KEYS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (!Array.isArray(value)) { notes.push("Skipped " + key + ": not a list."); continue; }
    data[key] = value.filter((item): item is string => typeof item === "string").slice(0, MAX_TEXT_ITEMS).map(item => item.slice(0, MAX_ITEM_TEXT_CHARS));
  }
  for (const key of TEXT_KEYS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value !== "string") { notes.push("Skipped " + key + ": not text."); continue; }
    data[key] = value.slice(0, MAX_TEXT_CHARS);
  }
  return { ok: true, data: data as WorkspaceSnapshot, notes };
}

/** True when there is nothing worth keeping, so restoring over it loses no work. */
export function isEmptyWorkspace(snapshot: WorkspaceSnapshot | null | undefined): boolean {
  if (!snapshot) return true;
  for (const key of LIST_KEYS) { const v = snapshot[key]; if (Array.isArray(v) && v.length) return false; }
  // The default workflow steps (graph) are not user work, so only variants count here.
  if (Array.isArray(snapshot.variants) && snapshot.variants.length) return false;
  for (const key of TEXT_KEYS) { const v = snapshot[key]; if (typeof v === "string" && v.trim()) return false; }
  return true;
}

/** Stable text form for "has anything changed?". Same content always gives the same text. */
export function workspaceFingerprint(snapshot: WorkspaceSnapshot): string {
  const ordered: Record<string, unknown> = {};
  for (const key of [...LIST_KEYS, ...TEXT_LIST_KEYS, ...TEXT_KEYS]) if (key in snapshot) ordered[key] = (snapshot as Record<string, unknown>)[key];
  return JSON.stringify(ordered);
}

/** Short, human summary such as "3 shots, 2 projects" for the "which version?" prompt. */
export function describeWorkspace(snapshot: WorkspaceSnapshot | null | undefined): string {
  if (!snapshot) return "nothing yet";
  const parts: string[] = [];
  const count = (key: (typeof LIST_KEYS)[number], one: string, many: string) => {
    const n = (snapshot[key] || []).length;
    if (n) parts.push(n + " " + (n === 1 ? one : many));
  };
  count("shots", "shot", "shots");
  count("projects", "project", "projects");
  count("characters", "character", "characters");
  count("tasks", "task", "tasks");
  count("seriesPlans", "series plan", "series plans");
  if (!parts.length && (snapshot.prompt || snapshot.script || snapshot.plan)) parts.push("notes and prompts");
  return parts.length ? parts.join(", ") : "nothing yet";
}
