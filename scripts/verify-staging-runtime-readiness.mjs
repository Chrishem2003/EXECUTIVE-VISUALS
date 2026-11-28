import { resolveSupabaseServerKey, supabaseServerAuthHeaders } from "../server/supabase-server-credentials.mjs";

const APPROVED_PROJECT_REF = "bokxljngydmqrmktofwm";
const APPROVED_RENDER_HOST = "executive-visuals-cloud-staging.onrender.com";
const text = value => String(value ?? "").trim();

function approvedHealthUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === APPROVED_RENDER_HOST &&
      url.pathname === "/api/health" && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

function approvedSupabaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === `${APPROVED_PROJECT_REF}.supabase.co` &&
      url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

async function boundedJson(response, maxBytes = 1024 * 1024) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("RESPONSE_TOO_LARGE");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new Error("RESPONSE_TOO_LARGE");
  try { return raw ? JSON.parse(raw) : null; } catch { throw new Error("INVALID_JSON"); }
}

async function request(fetchImpl, url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...options, signal: controller.signal, redirect: "error" }); }
  finally { clearTimeout(timer); }
}

export async function verifyStagingRuntime({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  heartbeatMaxAgeSeconds = 120
} = {}) {
  const missing = [];
  for (const name of ["EXECUTIVE_VISUALS_HEALTH_URL", "SUPABASE_STAGING_URL", "SUPABASE_STAGING_SECRET_KEY"]) {
    if (!text(env[name])) missing.push(name);
  }
  if (missing.length) return {
    state: "BLOCKED", missing, blockers: [], checks: [], workerHeartbeatCount: 0, ownerAdminCount: 0,
    secretValuesExposed: false
  };

  const healthUrl = text(env.EXECUTIVE_VISUALS_HEALTH_URL);
  const supabaseUrl = text(env.SUPABASE_STAGING_URL);
  const serverKey = resolveSupabaseServerKey({ SUPABASE_SECRET_KEY: text(env.SUPABASE_STAGING_SECRET_KEY) });
  const blockers = [];
  const checks = [];
  const add = (code, passed, detail) => {
    checks.push({ code, passed, detail });
    if (!passed) blockers.push(code);
  };

  add("HEALTH_URL_NOT_APPROVED_STAGING", approvedHealthUrl(healthUrl), "Health URL must be the approved staging service /api/health endpoint.");
  add("SUPABASE_URL_NOT_APPROVED_STAGING", approvedSupabaseUrl(supabaseUrl), "Supabase URL must match the approved staging project.");
  if (!approvedHealthUrl(healthUrl) || !approvedSupabaseUrl(supabaseUrl)) return {
    state: "BLOCKED", missing: [], blockers, checks, workerHeartbeatCount: 0, ownerAdminCount: 0,
    secretValuesExposed: false
  };
  if (typeof fetchImpl !== "function") {
    add("FETCH_UNAVAILABLE", false, "Runtime verification requires fetch.");
    return { state: "BLOCKED", missing: [], blockers, checks, workerHeartbeatCount: 0, ownerAdminCount: 0, secretValuesExposed: false };
  }

  let health = null;
  try {
    const response = await request(fetchImpl, healthUrl, { headers: { accept: "application/json" } });
    add("HEALTH_ENDPOINT_HTTP_200", response.status === 200 && response.ok, "Staging health endpoint must return HTTP 200.");
    if (!response.ok || response.status !== 200) throw new Error("HEALTH_HTTP_ERROR");
    health = await boundedJson(response);
  } catch {
    add("HEALTH_ENDPOINT_REACHABLE", false, "Staging health endpoint could not be read safely.");
  }

  if (health) {
    add("HEALTH_PAYLOAD_OK", health.status === "ok", "Health payload must report status=ok.");
    add("APP_DATABASE_POSTGRES", ["postgres", "postgresql"].includes(String(health.database || "").toLowerCase()),
      "The deployed application must use durable PostgreSQL, not SQLite.");
    add("AUTH_SUPABASE_READY", health.authMode === "supabase" && health.authSession?.configurationReady === true,
      "Supabase authentication and encrypted server sessions must be configured.");
    add("PRIVATE_CLOUD_STORAGE_READY", health.cloudMedia?.ready === true && health.cloudMedia?.storage === "private",
      "Cloud media must pass private-storage readiness.");
    add("PRIVATE_ASSET_EGRESS_READY", health.privateAssetEgress?.enabled === true && health.privateAssetEgress?.financeActorVerified === true,
      "Private asset egress accounting and actor verification must be enabled.");
    add("PADDLE_PESAPAL_SANDBOX_READY", health.billing?.paddlePesapal?.ready === true &&
      health.billing?.paddlePesapal?.paddle?.environment === "sandbox" &&
      health.billing?.paddlePesapal?.pesapal?.environment === "sandbox",
      "Both payment providers must be configured for sandbox and pass runtime readiness.");
    add("CLOUD_VIDEO_WORKER_ENABLED", health.cloudVideoWorker?.enabled === true,
      "Cloud video execution must be enabled on the staging runtime.");
    add("CLOUD_VIDEO_WORKER_SEPARATE_PROCESS", health.cloudVideoWorker?.runtimeMode === "separate-process" &&
      health.cloudVideoWorker?.inProcessSupervisorActive !== true,
      "The cloud worker must run outside the web process.");
  }

  let ownerAdminCount = 0;
  try {
    const headers = {
      ...supabaseServerAuthHeaders(serverKey),
      "accept-profile": "executive_visuals",
      accept: "application/json"
    };
    const adminsUrl = new URL("/rest/v1/platform_admins", supabaseUrl);
    adminsUrl.searchParams.set("select", "role");
    adminsUrl.searchParams.set("role", "in.(owner,platform_admin)");
    adminsUrl.searchParams.set("limit", "1");
    const response = await request(fetchImpl, adminsUrl, { headers });
    if (!response.ok) throw new Error("PLATFORM_ADMIN_QUERY_FAILED");
    const rows = await boundedJson(response);
    ownerAdminCount = Array.isArray(rows) ? rows.length : 0;
    add("PLATFORM_FINANCE_OWNER_CONFIGURED", ownerAdminCount > 0,
      "At least one owner/platform administrator must be allowlisted for the owner finance command centre.");
  } catch {
    add("PLATFORM_FINANCE_OWNER_CONFIGURED", false, "Platform owner authorization could not be verified.");
  }

  let workerHeartbeatCount = 0;
  let newestHeartbeatAgeSeconds = null;
  try {
    const headers = {
      ...supabaseServerAuthHeaders(serverKey),
      "accept-profile": "executive_visuals",
      accept: "application/json"
    };
    const heartbeatUrl = new URL("/rest/v1/cloud_worker_heartbeats", supabaseUrl);
    heartbeatUrl.searchParams.set("select", "status,heartbeat_at");
    heartbeatUrl.searchParams.set("status", "eq.healthy");
    heartbeatUrl.searchParams.set("heartbeat_at", "gt." + new Date(now() - heartbeatMaxAgeSeconds * 1000).toISOString());
    const response = await request(fetchImpl, heartbeatUrl, { headers });
    if (!response.ok) throw new Error("HEARTBEAT_QUERY_FAILED");
    const rows = await boundedJson(response);
    const validRows = Array.isArray(rows) ? rows.filter(row =>
      row.status === "healthy" && Number.isFinite(Date.parse(row.heartbeat_at)) &&
      now() - Date.parse(row.heartbeat_at) <= heartbeatMaxAgeSeconds * 1000
    ) : [];
    workerHeartbeatCount = validRows.length;
    if (validRows.length) newestHeartbeatAgeSeconds = Math.max(0, Math.floor((now() - Math.max(...validRows.map(row => Date.parse(row.heartbeat_at)))) / 1000));
    add("FRESH_CLOUD_WORKER_HEARTBEAT", workerHeartbeatCount > 0,
      "At least one healthy worker heartbeat must be newer than " + heartbeatMaxAgeSeconds + " seconds.");
  } catch {
    add("FRESH_CLOUD_WORKER_HEARTBEAT", false, "Worker heartbeat could not be verified from the staging database.");
  }

  return {
    state: blockers.length ? "BLOCKED" : "READY",
    missing: [],
    blockers: [...new Set(blockers)],
    checks,
    workerHeartbeatCount,
    ownerAdminCount,
    newestHeartbeatAgeSeconds,
    secretValuesExposed: false
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await verifyStagingRuntime();
  process.stdout.write(JSON.stringify(report) + "\n");
  if (report.state !== "READY") process.exitCode = 1;
}
