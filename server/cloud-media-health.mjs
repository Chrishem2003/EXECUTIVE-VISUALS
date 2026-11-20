const STORAGE_PROVIDERS = new Set(["supabase", "r2", "b2", "neon"]);

/**
 * Produce a safe, operator-facing cloud-media health summary.
 * API construction alone is not proof that private schema and bucket checks passed.
 * Never include storage credentials, bucket URLs, or service-role material here.
 */
export function buildCloudMediaHealth({
  enabled = false,
  readiness = null,
  storageProvider = "supabase",
  uploadLimitBytes = null,
  blockers = []
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
  const allowedBlockers = new Set(["CLOUD_TIMELINE_API_ENABLED","AUTH_MODE","SUPABASE_URL","SUPABASE_SECRET_KEY","NEON_STORAGE_ENDPOINT","NEON_STORAGE_REGION","NEON_STORAGE_ACCESS_KEY_ID","NEON_STORAGE_SECRET_ACCESS_KEY","NEON_STORAGE_BUCKET","R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","B2_REGION","B2_APPLICATION_KEY_ID","B2_APPLICATION_KEY","CLOUD_TIMELINE_READINESS"]);
  const safeBlockers = Array.isArray(blockers) ? [...new Set(blockers.filter(value => typeof value === "string" && allowedBlockers.has(value)))] : [];

  return Object.freeze({
    enabled: enabled === true,
    ready,
    storage,
    provider,
    uploadLimitBytes: Number.isSafeInteger(limit) && limit > 0 ? limit : null,
    blockers: safeBlockers
  });
}
