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
];

function isHttpsUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; } catch { return false; }
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
  if (webhookSecret && webhookSecret.length < 16) invalid.push("PADDLE_WEBHOOK_SECRET");

  const pesapalIpnId = String(env.PESAPAL_IPN_ID || "");
  if (pesapalIpnId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pesapalIpnId)) invalid.push("PESAPAL_IPN_ID");

  const passphrase = String(env.STAGING_BACKUP_ENCRYPTION_PASSPHRASE || "");
  if (passphrase && passphrase.length < 24) invalid.push("STAGING_BACKUP_ENCRYPTION_PASSPHRASE");

  for (const name of ["OPS_ALERT_WEBHOOK_URL", "EXECUTIVE_VISUALS_HEALTH_URL"]) {
    const value = String(env[name] || "").trim();
    if (value && !isHttpsUrl(value)) invalid.push(name);
  }

  const ownerId = String(env.STORAGE_TEST_OWNER_ID || "");
  if (ownerId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) {
    invalid.push("STORAGE_TEST_OWNER_ID");
  }

  const uniqueInvalid = [...new Set(invalid)];
  return {
    state: uniqueInvalid.length ? "INVALID" : missing.length ? "BLOCKED" : "READY",
    approvedProjectRef: APPROVED_STAGING_PROJECT_REF,
    missing,
    invalid: uniqueInvalid,
    credentialValuesExposed: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = assessStagingConfig();
  console.log(JSON.stringify(report));
  if (report.state === "INVALID") process.exitCode = 1;
}
