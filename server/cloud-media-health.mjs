const STORAGE_PROVIDERS = new Set(["supabase", "r2", "b2"]);

/**
 * Produce a safe, operator-facing cloud-media health summary.
 * API construction alone is not proof that private schema and bucket checks passed.
 * Never include storage credentials, bucket URLs, or service-role material here.
 */
export function buildCloudMediaHealth({
  enabled = false,
  readiness = null,
  storageProvider = "supabase",
  uploadLimitBytes = null
} = {}) {
  const normalizedProvider = String(storageProvider || "supabase").trim().toLowerCase();
  const provider = STORAGE_PROVIDERS.has(normalizedProvider) ? normalizedProvider : "unknown";
  const ready = enabled === true && readiness?.ready === true && readiness?.storage === "private";
  const storage = enabled !== true
    ? "disabled"
    : ready
      ? "private"
      : "unverified";
  const limit = Number(uploadLimitBytes);

  return Object.freeze({
    enabled: enabled === true,
    ready,
    storage,
    provider,
    uploadLimitBytes: Number.isSafeInteger(limit) && limit > 0 ? limit : null
  });
}
