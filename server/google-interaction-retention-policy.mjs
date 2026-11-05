const SUPPORTED_RETENTION_DAYS = new Set([7, 14, 28, 55]);

/**
 * Creates an explicit local cleanup policy for Gemini Developer API stored
 * Interactions. Configure GEMINI_OMNI_RETENTION_DAYS to the same value selected
 * in AI Studio (paid tier supports 7, 14, 28 or 55 days).
 *
 * This policy does not inspect or mutate the remote AI Studio setting; the
 * deployment operator must verify that setting before enabling generation.
 */
export function createGoogleInteractionRetentionPolicy({
  env = process.env,
  now = () => Date.now()
} = {}) {
  const raw = String(env.GEMINI_OMNI_RETENTION_DAYS || "").trim();
  const retentionDays = Number(raw);
  if (!SUPPORTED_RETENTION_DAYS.has(retentionDays) || String(retentionDays) !== raw) {
    const error = new Error("Set GEMINI_OMNI_RETENTION_DAYS to the verified AI Studio paid-tier value: 7, 14, 28 or 55.");
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
