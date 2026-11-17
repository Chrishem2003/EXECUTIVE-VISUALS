export const SUPABASE_FREE_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_CLOUD_MEDIA_MAX_FILE_BYTES = 250 * 1024 * 1024;

/**
 * Keep Supabase Free uploads within the plan-level individual-object limit.
 * Other storage providers retain their explicitly configured application limit.
 */
export function resolveCloudMediaMaxUploadBytes({
  storageProvider = "supabase",
  configuredMaxBytes,
  fallbackMaxBytes = DEFAULT_CLOUD_MEDIA_MAX_FILE_BYTES
} = {}) {
  const provider = String(storageProvider || "supabase").trim().toLowerCase();
  const configured = Number(configuredMaxBytes ?? fallbackMaxBytes);
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 1024 * 1024 * 1024) {
    throw new TypeError("Cloud media upload limit must be an integer between 1 byte and 1 GiB.");
  }
  return provider === "supabase"
    ? Math.min(configured, SUPABASE_FREE_MAX_FILE_BYTES)
    : configured;
}
