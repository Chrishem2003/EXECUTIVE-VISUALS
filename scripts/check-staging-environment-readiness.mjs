import { pathToFileURL } from "node:url";

export const PROHIBITED_SHARED_PROJECT_REFS = Object.freeze([
  "bokxljngydmqrmktofwm",
  "tymqdhwomggtnsjskxuk",
]);
const PROJECT_REF = /^[a-z0-9]{20}$/;

const REQUIRED_SECRETS = [
  "SUPABASE_STAGING_URL",
  "SUPABASE_STAGING_ANON_KEY",
  "SUPABASE_STAGING_SECRET_KEY",
  "SUPABASE_STAGING_DB_URL",
  "STORAGE_TEST_OWNER_EMAIL",
  "STORAGE_TEST_OWNER_PASSWORD",
  "STORAGE_TEST_OTHER_EMAIL",
  "STORAGE_TEST_OTHER_PASSWORD",
  "STAGING_BACKUP_ENCRYPTION_PASSPHRASE",
  "PADDLE_SANDBOX_API_KEY",
  "PADDLE_WEBHOOK_SECRET",
  "PESAPAL_SANDBOX_CONSUMER_KEY",
  "PESAPAL_SANDBOX_CONSUMER_SECRET",
  "OPS_ALERT_WEBHOOK_URL",
];

const REQUIRED_VARIABLES = [
  "EXECUTIVE_VISUALS_STAGING_PROJECT_REF",
  "STORAGE_TEST_OWNER_ID",
  "EXECUTIVE_VISUALS_HEALTH_URL",
  "PESAPAL_IPN_ID",
  "PESAPAL_CALLBACK_URL",
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

function databaseMatchesProject(value, projectRef) {
  try {
    const url = new URL(value);
    const username = decodeURIComponent(url.username);
    const direct = url.hostname === "db." + projectRef + ".supabase.co";
    const pooler = url.hostname.endsWith(".pooler.supabase.com") && username.endsWith("." + projectRef);
    return ["postgres:","postgresql:"].includes(url.protocol) && (direct || pooler) && Boolean(url.password);
  } catch { return false; }
}

/**
 * Reports only configuration names and states. Never returns or logs secret values.
 * Shared NEMA/platform Supabase projects are explicitly prohibited. A separately
 * designated isolated project ref must match both the API URL and DB connection.
 */
export function assessStagingConfig(env = process.env) {
  const missing = [...REQUIRED_SECRETS, ...REQUIRED_VARIABLES]
    .filter((name) => !String(env[name] || "").trim());
  const invalid = [];

  const projectRef = String(env.EXECUTIVE_VISUALS_STAGING_PROJECT_REF || "").trim();
  if (projectRef && (!PROJECT_REF.test(projectRef) || PROHIBITED_SHARED_PROJECT_REFS.includes(projectRef))) {
    invalid.push("EXECUTIVE_VISUALS_STAGING_PROJECT_REF");
  }

  const supabaseUrl = String(env.SUPABASE_STAGING_URL || "").trim();
  if (supabaseUrl) {
    try {
      const url = new URL(supabaseUrl);
      if (!projectRef || !PROJECT_REF.test(projectRef) || PROHIBITED_SHARED_PROJECT_REFS.includes(projectRef) ||
          url.protocol !== "https:" || url.hostname !== projectRef + ".supabase.co" ||
          url.username || url.password || url.search || url.hash) {
        invalid.push("SUPABASE_STAGING_URL");
      }
    } catch { invalid.push("SUPABASE_STAGING_URL"); }
  }

  const databaseUrl = String(env.SUPABASE_STAGING_DB_URL || "").trim();
  if (databaseUrl && (!projectRef || !databaseMatchesProject(databaseUrl, projectRef))) {
    invalid.push("SUPABASE_STAGING_DB_URL");
  }

  const paddleKey = String(env.PADDLE_SANDBOX_API_KEY || "");
  if (paddleKey && (!paddleKey.includes("_sdbx_") || paddleKey.includes("_live_"))) {
    invalid.push("PADDLE_SANDBOX_API_KEY");
  }

  const webhookSecret = String(env.PADDLE_WEBHOOK_SECRET || "");
  if (webhookSecret && webhookSecret.length < 16) invalid.push("PADDLE_WEBHOOK_SECRET");

  const pesapalIpnId = String(env.PESAPAL_IPN_ID || "");
  if (pesapalIpnId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pesapalIpnId)) invalid.push("PESAPAL_IPN_ID");

  const passphrase = String(env.STAGING_BACKUP_ENCRYPTION_PASSPHRASE || "");
  if (passphrase && passphrase.length < 24) invalid.push("STAGING_BACKUP_ENCRYPTION_PASSPHRASE");

  for (const name of ["OPS_ALERT_WEBHOOK_URL", "EXECUTIVE_VISUALS_HEALTH_URL"]) {
    const value = String(env[name] || "").trim();
    if (value && !isHttpsUrl(value)) invalid.push(name);
  }

  const pesapalCallbackUrl = String(env.PESAPAL_CALLBACK_URL || "").trim();
  if (pesapalCallbackUrl && !isPesapalCallbackUrl(pesapalCallbackUrl)) invalid.push("PESAPAL_CALLBACK_URL");

  const ownerId = String(env.STORAGE_TEST_OWNER_ID || "");
  if (ownerId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) {
    invalid.push("STORAGE_TEST_OWNER_ID");
  }

  const uniqueInvalid = [...new Set(invalid)];
  return {
    state: uniqueInvalid.length ? "INVALID" : missing.length ? "BLOCKED" : "READY",
    configuredProjectRef: projectRef || null,
    prohibitedSharedProjectRefs: PROHIBITED_SHARED_PROJECT_REFS,
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
