const MAX_PROVIDER_RETENTION_DAYS = 55;

/**
 * Creates an explicit local cleanup policy for Gemini Developer API stored
 * Interactions. Configure GEMINI_OMNI_RETENTION_DAYS as the application cleanup window. The
 * Developer API paid tier retains stored Interactions for 55 days by default;
 * this application may delete its own records earlier, but never later.
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
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 ||
      retentionDays > MAX_PROVIDER_RETENTION_DAYS || String(retentionDays) !== raw) {
    const error = new Error("Set GEMINI_OMNI_RETENTION_DAYS to an integer from 1 through 55 days.");
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
