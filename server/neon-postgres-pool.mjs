import { URL } from "node:url";

function parseDatabaseUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(label + " must be a valid PostgreSQL connection URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname || url.searchParams.get("sslmode") === "disable") {
    throw new Error(label + " must be a credentialed PostgreSQL URL with TLS enabled.");
  }
  return url;
}

export function assertNeonPooledDatabaseUrl(value) {
  const url = parseDatabaseUrl(value, "NEON_DATABASE_URL");
  if (!url.hostname.includes("-pooler.")) {
    throw new Error("NEON_DATABASE_URL must use Neon's pooled endpoint (hostname contains -pooler); use NEON_DATABASE_DIRECT_URL only for migrations.");
  }
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "require");
  return url.toString();
}

export function assertNeonDirectDatabaseUrl(value) {
  const url = parseDatabaseUrl(value, "NEON_DATABASE_DIRECT_URL");
  if (url.hostname.includes("-pooler.")) {
    throw new Error("NEON_DATABASE_DIRECT_URL must use the direct Neon endpoint without -pooler.");
  }
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "require");
  return url.toString();
}

export async function createNeonPostgresPool({
  connectionString = process.env.NEON_DATABASE_URL,
  Pool: PoolOverride,
  max = 3,
  connectionTimeoutMillis = 10000,
  idleTimeoutMillis = 30000,
  applicationName = "executive-visuals-staging"
} = {}) {
  if (!Number.isInteger(max) || max < 1 || max > 10) throw new Error("Neon PostgreSQL pool max must be between 1 and 10.");
  const validated = assertNeonPooledDatabaseUrl(connectionString || "");
  let Pool = PoolOverride;
  if (!Pool) {
    try { ({ Pool } = await import("pg")); }
    catch { throw new Error("The pg driver is not installed. Add the reviewed pg dependency before enabling Neon PostgreSQL."); }
  }
  const pool = new Pool({
    connectionString: validated,
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    application_name: applicationName,
    keepAlive: true,
    ssl: { rejectUnauthorized: true }
  });
  return pool;
}
