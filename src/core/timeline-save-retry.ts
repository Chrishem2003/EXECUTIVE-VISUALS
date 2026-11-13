export type TimelineSaveReconciliation<T> =
  | { kind: "committed"; value: T }
  | { kind: "retry" }
  | { kind: "conflict" }
  | { kind: "unknown" };

export interface TimelineSaveRetryOptions<T> {
  save: () => Promise<T>;
  reconcile: () => Promise<TimelineSaveReconciliation<T>>;
  maxAttempts?: number;
  baseDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}

export function isRetryableTimelineSaveError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; name?: unknown };
  const status = Number(candidate.status);
  if (Number.isInteger(status)) {
    return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
  }
  // fetch() reports transport failures as TypeError in browsers. Do not retry
  // AbortError, validation failures, revision conflicts or arbitrary exceptions.
  return error instanceof TypeError || candidate.name === "NetworkError";
}

/**
 * Retry an optimistic timeline save only after a read-after-write check proves
 * the previous request did not commit. A lost response after a successful PUT
 * is returned as success by the caller's reconciliation callback; a changed
 * server revision is surfaced as a conflict and is never overwritten.
 */
export async function retryTimelineSave<T>({
  save,
  reconcile,
  maxAttempts = 3,
  baseDelayMs = 250,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  onRetry
}: TimelineSaveRetryOptions<T>): Promise<T> {
  const attempts = Math.max(1, Math.min(5, Math.floor(maxAttempts)));
  const delayBase = Math.max(0, Math.min(5000, Math.floor(baseDelayMs)));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await save();
    } catch (error) {
      if (!isRetryableTimelineSaveError(error) || attempt >= attempts) throw error;

      let reconciliation: TimelineSaveReconciliation<T>;
      try {
        reconciliation = await reconcile();
      } catch {
        // A failed reconciliation is not proof that the write did not commit.
        throw error;
      }

      if (reconciliation.kind === "committed") return reconciliation.value;
      if (reconciliation.kind === "conflict") {
        throw Object.assign(
          new Error("Timeline changed while the save response was unavailable. Refresh and compare before saving again."),
          { status: 409, code: "REVISION_CONFLICT" }
        );
      }
      if (reconciliation.kind !== "retry") throw error;

      onRetry?.(attempt, error);
      await wait(Math.min(2000, delayBase * (2 ** (attempt - 1))));
    }
  }

  throw new Error("Timeline save retry limit was reached.");
}
