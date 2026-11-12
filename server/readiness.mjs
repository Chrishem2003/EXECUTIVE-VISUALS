const safeHttpsUrl = value => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { return false; }
};

/**
 * Deployment readiness is deliberately stricter than liveness.
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
    add("server-managed-session", config.serverManagedSessionsReady === true,
      "Hosted server-managed sessions and refresh coordination must be configured before production.");
    add("private-media-lifecycle",
      config.cloudTimelineApiEnabled === true && config.cloudTimelineStorageReady === true && config.authMode === "supabase",
      "The authenticated private cloud-media API and private bucket must pass startup verification.");
    add("persistent-volume",
      config.requirePersistentDataDir === true &&
      config.dataDirExists === true &&
      config.databaseWithinDataDir === true &&
      config.mediaWithinDataDir === true &&
      config.dataDirPersistence === "operator-confirmed-volume",
      "A verified operator-confirmed persistent volume must contain the database and media directories.");
  }

  if (config.cloudTimelineApiEnabled === true) {
    add("cloud-timeline-auth", config.authMode === "supabase",
      "The cloud timeline API requires external identity authentication.");
    add("cloud-timeline-credentials",
      safeHttpsUrl(config.supabaseUrl) &&
      typeof config.supabasePublishableKey === "string" && config.supabasePublishableKey.length > 0 &&
      typeof config.supabaseServiceRoleKey === "string" && config.supabaseServiceRoleKey.length > 0,
      "Cloud timeline authentication and storage credentials are incomplete or invalid.");
    add("cloud-timeline-private-storage", config.cloudTimelineStorageReady === true,
      "The cloud schema and private media bucket have not passed startup verification.");
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
  return Object.freeze({ ready, status: ready ? "ready" : "not_ready", checks });
}
