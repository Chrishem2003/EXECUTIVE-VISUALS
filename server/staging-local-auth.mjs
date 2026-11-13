const STAGING_APP_ORIGIN = "https://executive-visuals-1.onrender.com";
const STAGING_D1_WORKER_URL = "https://executive-visuals-d1-staging.chrishem.workers.dev";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DYNAMIC_CI_ALLOWLIST_ENTRY = "ev-ci+*@ev-staging.test";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * A deliberately narrow local-auth escape hatch for isolated D1 acceptance.
 * It cannot be enabled on the production app origin or with any other Worker.
 */
export function getStagingLocalAuthPolicy(env = {}) {
  const allowlist = [...new Set(
    String(env.STAGING_LOCAL_AUTH_ALLOWLIST || "")
      .split(",")
      .map(normalizeEmail)
      .filter(email => EMAIL_PATTERN.test(email) && (!email.includes("*") || email === DYNAMIC_CI_ALLOWLIST_ENTRY))
  )].sort();
  const enabled = env.NODE_ENV === "production" &&
    env.AUTH_MODE === "local" &&
    env.STAGING_LOCAL_AUTH_ENABLED === "true" &&
    env.STAGING_LOCAL_AUTH_ORIGIN === STAGING_APP_ORIGIN &&
    env.D1_STAGING_WORKER_URL === STAGING_D1_WORKER_URL &&
    allowlist.length > 0;

  return Object.freeze({
    enabled,
    origin: enabled ? STAGING_APP_ORIGIN : "",
    allowlist: Object.freeze(enabled ? allowlist : [])
  });
}

export function isStagingLocalAuthEmailAllowed(policy, email) {
  const normalized = normalizeEmail(email);
  if (normalized.includes("*")) return false;
  return Boolean(policy?.enabled && policy.allowlist.some(entry =>
    entry === normalized || (entry === DYNAMIC_CI_ALLOWLIST_ENTRY && /^ev-ci\+[a-z0-9-]+@ev-staging\.test$/.test(normalized))
  ));
}
