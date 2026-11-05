const SUPPORTED_PAID_RETENTION_DAYS = new Set([7, 14, 28, 55]);

/**
 * Mirrors the paid-tier Gemini Developer API AI Studio retention options.
 * The operator must set the same value here and in AI Studio. This helper
 * cannot inspect or modify the remote project setting.
 */
export function createGoogleInteractionRetentionPolicy({
  env = process.env,
  now = () => Date.now()
} = {}) {
  const raw = String(env.GEMINI_OMNI_RETENTION_DAYS || "").trim();
  const retentionDays = Number(raw);
  if (env.GEMINI_OMNI_PAID_TIER_CONFIRMED !== "true" ||
      !SUPPORTED_PAID_RETENTION_DAYS.has(retentionDays) ||
      String(retentionDays) !== raw) {
    const error = new Error(
      "Confirm the Gemini paid tier and set GEMINI_OMNI_RETENTION_DAYS to the AI Studio value: 7, 14, 28 or 55."
    );
    error.code = "GEMINI_OMNI_RETENTION_POLICY_REQUIRED";
    throw error;
  }
  if (typeof now !== "function") throw new TypeError("Retention policy clock must be a function.");

  return Object.freeze({
    retentionDays,
    async expiresAt({ submittedAt } = {}) {
      const start = submittedAt === undefined ? now() : Date.parse(submittedAt);
      if (!Number.isFinite(start)) {
        const error = new Error("Gemini interaction submission timestamp is invalid.");
        error.code = "GEMINI_OMNI_RETENTION_TIMESTAMP_INVALID";
        throw error;
      }
      const expiry = new Date(start + retentionDays * 24 * 60 * 60 * 1000);
      if (!Number.isFinite(expiry.getTime())) {
        const error = new Error("Gemini interaction expiry could not be calculated.");
        error.code = "GEMINI_OMNI_RETENTION_TIMESTAMP_INVALID";
        throw error;
      }
      return expiry.toISOString();
    }
  });
}
