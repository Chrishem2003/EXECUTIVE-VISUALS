const safeHttpsUrl = value => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { return false; }
};

/**
 * Deployment readiness is intentionally stricter than liveness.
 * It reports configuration blockers without exposing secrets or filesystem paths.
 */
export function evaluateReadiness(config = {}) {
  const checks = [];
  const add = (id, passed, reason) => checks.push({
    id,
    status: passed ? "passed" : "blocked",
    ...(passed ? {} : { reason })
  });
  const production = config.nodeEnv === "production";

  if (production) {
    add("external-auth-mode", config.authMode === "supabase",
      "Production must use the configured external identity provider.");
    add("server-managed-session", false,
      "Hosted server-managed cookie sessions, refresh rotation and CSRF enforcement are not implemented yet.");
    add("private-media-lifecycle", false,
      "The active general media API still uses local-disk storage; private cloud asset lifecycle integration is incomplete.");
    add("persistent-volume",
      config.requirePersistentDataDir === true &&
      config.dataDirExists === true &&
      config.databaseWithinDataDir === true &&
      config.mediaWithinDataDir === true,
      "A verified persistent data volume must contain the database and media directories.");
  }

  if (config.cloudTimelineApiEnabled === true) {
    add("cloud-timeline-auth", config.authMode === "supabase",
      "The cloud timeline API requires external identity authentication.");
    add("cloud-timeline-credentials",
      safeHttpsUrl(config.supabaseUrl) &&
      typeof config.supabasePublishableKey === "string" && config.supabasePublishableKey.length > 0 &&
      typeof config.supabaseServiceRoleKey === "string" && config.supabaseServiceRoleKey.length > 0,
      "Cloud timeline authentication and storage credentials are incomplete or invalid.");
  }

  if (config.imageGatewayEnabled === true) {
    add("image-gateway", config.imageGatewayConfigured === true,
      "The image gateway is enabled but its endpoint or model is not configured.");
  }
  if (config.textGatewayEnabled === true) {
    add("text-gateway", config.textGatewayConfigured === true,
      "The text gateway is enabled but its endpoint or model is not configured.");
  }

  const ready = checks.every(check => check.status === "passed");
  return Object.freeze({
    ready,
    status: ready ? "ready" : "not_ready",
    checks
  });
}
