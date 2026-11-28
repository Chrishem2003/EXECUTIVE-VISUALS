import { pathToFileURL } from "node:url";

export const APPROVED_STAGING_PROJECT_REF = "bokxljngydmqrmktofwm";

const REQUIRED_SECRETS = [
  "SUPABASE_STAGING_URL",
  "SUPABASE_STAGING_ANON_KEY",
  "SUPABASE_STAGING_SECRET_KEY",
  "SUPABASE_STAGING_DB_URL",
  "STORAGE_TEST_OWNER_JWT",
  "STORAGE_TEST_OTHER_JWT",
  "STAGING_BACKUP_ENCRYPTION_PASSPHRASE",
  "PADDLE_SANDBOX_API_KEY",
  "PADDLE_WEBHOOK_SECRET",
  "PESAPAL_SANDBOX_CONSUMER_KEY",
  "PESAPAL_SANDBOX_CONSUMER_SECRET",
  "OPS_ALERT_WEBHOOK_URL",
];

const REQUIRED_VARIABLES = [
  "STORAGE_TEST_OWNER_ID",
  "EXECUTIVE_VISUALS_HEALTH_URL",
  "PESAPAL_IPN_ID",
  "PESAPAL_CALLBACK_URL",
  "PADDLE_RETURN_URL",
];

function isHttpsUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; } catch { return false; }
}

function isPesapalCallbackUrl(value) {
  try {
    const url = new URL(value);
    return isHttpsUrl(value) && url.hostname === "executive-visuals-cloud-staging.onrender.com" && url.pathname === "/api/webhooks/pesapal" && !url.search;
  } catch { return false; }
}

function isApprovedStagingHealthUrl(value) {
  try {
    const url = new URL(value);
    return isHttpsUrl(value) && url.hostname === "executive-visuals-cloud-staging.onrender.com" && url.pathname === "/api/health" && !url.search;
  } catch { return false; }
}

function isApprovedPaddleReturnUrl(value) {
  try {
    const url = new URL(value);
    return isHttpsUrl(value) && url.hostname === "executive-visuals-cloud-staging.onrender.com" && url.pathname === "/" && !url.search;
  } catch { return false; }
}

function jwtPayload(value) {
  try {
    const parts = String(value || "").split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { return null; }
}

function hasLegacyKeyRole(value, role) {
  return jwtPayload(value)?.role === role;
}

function isSupabaseAuthAccessToken(value, expectedSubject) {
  const payload = jwtPayload(value);
  return Boolean(payload && payload.sub === expectedSubject && payload.role === "authenticated" &&
    payload.aud === "authenticated" && payload.iss === `https://${APPROVED_STAGING_PROJECT_REF}.supabase.co/auth/v1` &&
    Number.isFinite(Number(payload.exp)) && Number(payload.exp) * 1000 > Date.now());
}

function databaseMatchesApprovedProject(value) {
  try {
    const url = new URL(value);
    const username = decodeURIComponent(url.username);
    const direct = url.hostname === `db.${APPROVED_STAGING_PROJECT_REF}.supabase.co`;
    const pooler = url.hostname.endsWith(".pooler.supabase.com") && username.endsWith(`.${APPROVED_STAGING_PROJECT_REF}`);
    return url.protocol.startsWith("postgres") && (direct || pooler) && Boolean(url.password);
  } catch { return false; }
}

/**
 * Reports only configuration names and states. Never returns or logs secret values.
 * Missing credentials are a BLOCKED readiness state, not a passing acceptance test.
 */
export function assessStagingConfig(env = process.env) {
  const missing = [...REQUIRED_SECRETS, ...REQUIRED_VARIABLES]
    .filter((name) => !String(env[name] || "").trim());
  const invalid = [];

  const anonKey = String(env.SUPABASE_STAGING_ANON_KEY || "").trim();
  if (anonKey && !anonKey.startsWith("sb_publishable_") && !hasLegacyKeyRole(anonKey, "anon")) invalid.push("SUPABASE_STAGING_ANON_KEY");
  const secretKey = String(env.SUPABASE_STAGING_SECRET_KEY || "").trim();
  if (secretKey && !secretKey.startsWith("sb_secret_") && !hasLegacyKeyRole(secretKey, "service_role")) invalid.push("SUPABASE_STAGING_SECRET_KEY");
  if (anonKey && secretKey && anonKey === secretKey) invalid.push("SUPABASE_STAGING_SECRET_KEY");

  const supabaseUrl = String(env.SUPABASE_STAGING_URL || "").trim();
  if (supabaseUrl) {
    try {
      const url = new URL(supabaseUrl);
      if (url.protocol !== "https:" || url.hostname !== `${APPROVED_STAGING_PROJECT_REF}.supabase.co` || url.username || url.password || url.search || url.hash) {
        invalid.push("SUPABASE_STAGING_URL");
      }
    } catch { invalid.push("SUPABASE_STAGING_URL"); }
  }

  const databaseUrl = String(env.SUPABASE_STAGING_DB_URL || "").trim();
  if (databaseUrl && !databaseMatchesApprovedProject(databaseUrl)) invalid.push("SUPABASE_STAGING_DB_URL");

  const paddleKey = String(env.PADDLE_SANDBOX_API_KEY || "");
  if (paddleKey && (!paddleKey.includes("_sdbx_") || paddleKey.includes("_live_"))) {
    invalid.push("PADDLE_SANDBOX_API_KEY");
  }

  const webhookSecret = String(env.PADDLE_WEBHOOK_SECRET || "");
  if (webhookSecret && (!webhookSecret.startsWith("pdl_ntfset_") || webhookSecret.length < 24)) invalid.push("PADDLE_WEBHOOK_SECRET");

  const pesapalIpnId = String(env.PESAPAL_IPN_ID || "");
  if (pesapalIpnId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pesapalIpnId)) invalid.push("PESAPAL_IPN_ID");

  const passphrase = String(env.STAGING_BACKUP_ENCRYPTION_PASSPHRASE || "");
  if (passphrase && passphrase.length < 24) invalid.push("STAGING_BACKUP_ENCRYPTION_PASSPHRASE");

  const alertUrl = String(env.OPS_ALERT_WEBHOOK_URL || "").trim();
  if (alertUrl && !isHttpsUrl(alertUrl)) invalid.push("OPS_ALERT_WEBHOOK_URL");

  const healthUrl = String(env.EXECUTIVE_VISUALS_HEALTH_URL || "").trim();
  if (healthUrl && !isApprovedStagingHealthUrl(healthUrl)) invalid.push("EXECUTIVE_VISUALS_HEALTH_URL");

  const paddleReturnUrl = String(env.PADDLE_RETURN_URL || "").trim();
  if (paddleReturnUrl && !isApprovedPaddleReturnUrl(paddleReturnUrl)) invalid.push("PADDLE_RETURN_URL");

  const pesapalCallbackUrl = String(env.PESAPAL_CALLBACK_URL || "").trim();
  if (pesapalCallbackUrl && !isPesapalCallbackUrl(pesapalCallbackUrl)) invalid.push("PESAPAL_CALLBACK_URL");

  const ownerId = String(env.STORAGE_TEST_OWNER_ID || "");
  if (ownerId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) {
    invalid.push("STORAGE_TEST_OWNER_ID");
  }
  const ownerJwt = String(env.STORAGE_TEST_OWNER_JWT || "").trim();
  const otherJwt = String(env.STORAGE_TEST_OTHER_JWT || "").trim();
  if (ownerJwt && ownerId && !isSupabaseAuthAccessToken(ownerJwt, ownerId)) invalid.push("STORAGE_TEST_OWNER_JWT");
  const otherSubject = jwtPayload(otherJwt)?.sub;
  if (otherJwt && (!isSupabaseAuthAccessToken(otherJwt, otherSubject) || otherSubject === ownerId)) invalid.push("STORAGE_TEST_OTHER_JWT");

  const uniqueInvalid = [...new Set(invalid)];
  return {
    state: uniqueInvalid.length ? "INVALID" : missing.length ? "BLOCKED" : "READY",
    approvedProjectRef: APPROVED_STAGING_PROJECT_REF,
    missing,
    invalid: uniqueInvalid,
    credentialValuesExposed: false,
  };
}

export function stagingReadinessExitCode(report, { requireReady = false } = {}) {
  if (report?.state === "INVALID") return 1;
  if (requireReady && report?.state !== "READY") return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = assessStagingConfig();
  console.log(JSON.stringify(report));
  process.exitCode = stagingReadinessExitCode(report, {
    requireReady: process.argv.includes("--require-ready"),
  });
}
