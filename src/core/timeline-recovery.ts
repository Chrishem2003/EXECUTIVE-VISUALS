import type { EditorialTimeline } from "./timeline";

export const TIMELINE_RECOVERY_DB = "executive-visuals-timeline-recovery";
export const TIMELINE_RECOVERY_VERSION = 1;
export const TIMELINE_RECOVERY_LIMIT = 80;

export interface TimelineRecoveryDraft {
  key: string;
  projectId: string;
  timelineId: string;
  mode: "local" | "cloud";
  baseRevision: number;
  localRevision: number;
  sequence: number;
  updatedAt: string;
  reason: string;
  checksum: string;
  snapshot: EditorialTimeline;
}

export interface TimelineRecoveryJournalEntry {
  id?: number;
  key: string;
  projectId: string;
  timelineId: string;
  mode: "local" | "cloud";
  baseRevision: number;
  localRevision: number;
  sequence: number;
  updatedAt: string;
  reason: string;
  checksum: string;
}

export interface TimelineRecoveryCheckpoint {
  id: string;
  key: string;
  projectId: string;
  timelineId: string;
  revision: number;
  createdAt: string;
  label: string;
  checksum: string;
  snapshot: EditorialTimeline;
}

export type RecoveryDisposition = "clean" | "recover" | "conflict" | "invalid";

export interface RecoveryAssessment {
  disposition: RecoveryDisposition;
  reason: string;
  draft: TimelineRecoveryDraft | null;
  serverRevision: number;
}

export function timelineRecoveryKey(mode: "local" | "cloud", projectId: string, timelineId: string): string {
  if (!timelineId.trim()) throw new Error("A timeline ID is required for recovery storage.");
  return [mode, projectId || "no-project", timelineId].map(encodeURIComponent).join(":");
}

export async function checksumTimeline(snapshot: EditorialTimeline): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(snapshot));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + stableStringify(object[key])).join(",") + "}";
}

export async function assessTimelineRecovery(
  draft: TimelineRecoveryDraft | null,
  serverRevision: number
): Promise<RecoveryAssessment> {
  if (!draft) return { disposition: "clean", reason: "No unsaved browser draft exists.", draft: null, serverRevision };
  if (!isTimelineRecoveryDraft(draft)) {
    return { disposition: "invalid", reason: "The saved browser draft is malformed and was not restored.", draft: null, serverRevision };
  }
  const checksum = await checksumTimeline(draft.snapshot);
  if (checksum !== draft.checksum) {
    return { disposition: "invalid", reason: "The saved browser draft failed its integrity check and was not restored.", draft: null, serverRevision };
  }
  if (draft.baseRevision !== serverRevision) {
    return {
      disposition: "conflict",
      reason: "The recovered draft and server revision have different bases. Compare them before choosing which version to keep.",
      draft,
      serverRevision
    };
  }
  return {
    disposition: "recover",
    reason: "A valid unsaved browser draft was recovered from the last confirmed server revision.",
    draft,
    serverRevision
  };
}

export function isTimelineRecoveryDraft(value: unknown): value is TimelineRecoveryDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<TimelineRecoveryDraft>;
  return typeof draft.key === "string" && typeof draft.projectId === "string" &&
    typeof draft.timelineId === "string" && (draft.mode === "local" || draft.mode === "cloud") &&
    Number.isInteger(draft.baseRevision) && Number.isInteger(draft.localRevision) &&
    Number.isInteger(draft.sequence) && typeof draft.updatedAt === "string" &&
    typeof draft.reason === "string" && typeof draft.checksum === "string" &&
    !!draft.snapshot && typeof draft.snapshot === "object" &&
    (draft.snapshot as EditorialTimeline).id === draft.timelineId;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
  });
}

export class TimelineRecoveryStore {
  private database: Promise<IDBDatabase> | null = null;
  constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {
    if (!factory) throw new Error("IndexedDB is not available in this browser.");
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const request = this.factory.open(TIMELINE_RECOVERY_DB, TIMELINE_RECOVERY_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", { keyPath: "key" });
        if (!db.objectStoreNames.contains("journal")) {
          const journal = db.createObjectStore("journal", { keyPath: "id", autoIncrement: true });
          journal.createIndex("byKey", "key", { unique: false });
          journal.createIndex("byUpdatedAt", "updatedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("checkpoints")) {
          const checkpoints = db.createObjectStore("checkpoints", { keyPath: "id" });
          checkpoints.createIndex("byKey", "key", { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.database = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error("Could not open recovery storage."));
      request.onblocked = () => reject(new Error("Recovery storage upgrade is blocked by another open tab."));
    }).catch(error => {
      this.database = null;
      throw error;
    });
    return this.database;
  }

  async saveDraft(input: Omit<TimelineRecoveryDraft, "checksum">): Promise<TimelineRecoveryDraft> {
    const draft: TimelineRecoveryDraft = { ...input, checksum: await checksumTimeline(input.snapshot) };
    const db = await this.open();
    const transaction = db.transaction(["drafts", "journal"], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("drafts").put(draft);
    transaction.objectStore("journal").add({
      key: draft.key, projectId: draft.projectId, timelineId: draft.timelineId, mode: draft.mode,
      baseRevision: draft.baseRevision, localRevision: draft.localRevision, sequence: draft.sequence,
      updatedAt: draft.updatedAt, reason: draft.reason, checksum: draft.checksum
    });
    await done;
    await this.pruneJournal(draft.key);
    return draft;
  }

  async getDraft(key: string): Promise<TimelineRecoveryDraft | null> {
    const db = await this.open();
    const transaction = db.transaction("drafts", "readonly");
    const done = transactionDone(transaction);
    const result = await requestResult<TimelineRecoveryDraft | undefined>(transaction.objectStore("drafts").get(key));
    await done;
    return result || null;
  }

  async saveCheckpoint(
    draft: TimelineRecoveryDraft,
    revision: number,
    label = "Autosave checkpoint"
  ): Promise<TimelineRecoveryCheckpoint> {
    const checkpoint: TimelineRecoveryCheckpoint = {
      id: globalThis.crypto.randomUUID(),
      key: draft.key,
      projectId: draft.projectId,
      timelineId: draft.timelineId,
      revision,
      createdAt: new Date().toISOString(),
      label: label.slice(0, 120),
      checksum: draft.checksum,
      snapshot: structuredClone(draft.snapshot)
    };
    const db = await this.open();
    const transaction = db.transaction(["checkpoints", "drafts"], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("checkpoints").put(checkpoint);
    transaction.objectStore("drafts").delete(draft.key);
    await done;
    await this.pruneCheckpoints(draft.key);
    return checkpoint;
  }

  async listCheckpoints(key: string): Promise<TimelineRecoveryCheckpoint[]> {
    const db = await this.open();
    const transaction = db.transaction("checkpoints", "readonly");
    const done = transactionDone(transaction);
    const result = await requestResult<TimelineRecoveryCheckpoint[]>(transaction.objectStore("checkpoints").index("byKey").getAll(key));
    await done;
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async clearDraft(key: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction("drafts", "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("drafts").delete(key);
    await done;
  }

  async close(): Promise<void> {
    if (!this.database) return;
    const db = await this.database;
    db.close();
    this.database = null;
  }

  private async pruneJournal(key: string): Promise<void> {
    const db = await this.open();
    const read = db.transaction("journal", "readonly");
    const entries = await requestResult<TimelineRecoveryJournalEntry[]>(read.objectStore("journal").index("byKey").getAll(key));
    await transactionDone(read);
    const stale = entries.sort((a, b) => b.sequence - a.sequence).slice(TIMELINE_RECOVERY_LIMIT);
    if (!stale.length) return;
    const write = db.transaction("journal", "readwrite");
    const done = transactionDone(write);
    for (const entry of stale) if (entry.id !== undefined) write.objectStore("journal").delete(entry.id);
    await done;
  }

  private async pruneCheckpoints(key: string): Promise<void> {
    const db = await this.open();
    const read = db.transaction("checkpoints", "readonly");
    const checkpoints = await requestResult<TimelineRecoveryCheckpoint[]>(read.objectStore("checkpoints").index("byKey").getAll(key));
    await transactionDone(read);
    const stale = checkpoints.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(20);
    if (!stale.length) return;
    const write = db.transaction("checkpoints", "readwrite");
    const done = transactionDone(write);
    for (const checkpoint of stale) write.objectStore("checkpoints").delete(checkpoint.id);
    await done;
  }
}

export async function requestPersistentBrowserStorage(): Promise<boolean> {
  if (!globalThis.navigator?.storage?.persist) return false;
  try { return await globalThis.navigator.storage.persist(); }
  catch { return false; }
}
