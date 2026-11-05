export interface RetryBackoffOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (failedAttempt: number, delayMs: number, error: unknown) => void;
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryBackoffOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 4000;
  const shouldRetry = options.shouldRetry ?? (() => false);
  const sleep = options.sleep ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 8) throw new Error("Retry attempts must be between 1 and 8.");
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || !Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new Error("Retry backoff delays are invalid.");
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs);
    }
  }
  throw new Error("Retry operation ended without a result.");
}
