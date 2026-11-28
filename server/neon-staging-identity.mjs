const ALLOWED_BRANCH_NAMES = new Set(["staging", "executive-visuals-staging"]);
const RESOURCE_ID = /^[a-z0-9-]{1,60}$/;

/**
 * Bind the opt-in runtime to the exact Neon endpoint and database approved for
 * this staging deployment. The endpoint ID is checked against the host in the
 * pooled connection URL; project and branch IDs are retained as deployment
 * identity metadata and must be set in the protected server environment.
 */
export function resolveNeonStagingIdentity({ env = process.env, requireEndpointBinding = false } = {}) {
  const branchName = String(env.NEON_STAGING_BRANCH_NAME || "").trim();
  if (!ALLOWED_BRANCH_NAMES.has(branchName)) {
    throw new Error("Neon runtime requires an explicitly approved staging branch name.");
  }
  if (!requireEndpointBinding) return Object.freeze({ branchName });

  const projectId = String(env.NEON_STAGING_PROJECT_ID || "").trim();
  const branchId = String(env.NEON_STAGING_BRANCH_ID || "").trim();
  const endpointId = String(env.NEON_STAGING_ENDPOINT_ID || "").trim();
  const databaseName = String(env.NEON_STAGING_DATABASE_NAME || "").trim();
  for (const [label, value] of [["project ID", projectId], ["branch ID", branchId], ["endpoint ID", endpointId]]) {
    if (!RESOURCE_ID.test(value)) throw new Error("Neon staging " + label + " is missing or invalid.");
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(databaseName)) {
    throw new Error("Neon staging database name is missing or invalid.");
  }

  let url;
  try { url = new URL(String(env.NEON_DATABASE_URL || "")); }
  catch { throw new Error("NEON_DATABASE_URL must be a valid pooled Neon connection URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.hostname.split(".")[0].endsWith("-pooler")) {
    throw new Error("Neon staging application traffic must use the pooled endpoint.");
  }
  const hostnameEndpointId = url.hostname.split(".")[0].replace(/-pooler$/, "");
  if (hostnameEndpointId !== endpointId) {
    throw new Error("NEON_DATABASE_URL endpoint does not match NEON_STAGING_ENDPOINT_ID.");
  }
  if (decodeURIComponent(url.pathname.replace(/^\/+/, "")) !== databaseName) {
    throw new Error("NEON_DATABASE_URL database does not match NEON_STAGING_DATABASE_NAME.");
  }
  return Object.freeze({ branchName, projectId, branchId, endpointId, databaseName });
}
