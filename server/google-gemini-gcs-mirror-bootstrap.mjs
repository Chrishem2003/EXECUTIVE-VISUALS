import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createGoogleGeminiGcsMirrorServiceFactory } from "./google-gemini-gcs-mirror-service-factory.mjs";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const fail = (message, code) => Object.assign(new Error(message), { code });

function required(value, name) {
  const result = String(value || "").trim();
  if (!result) throw fail(name + " is required for GCS mirror recovery.", "GEMINI_GCS_BOOTSTRAP_CONFIG_MISSING");
  return result;
}

/**
 * Creates the production Google ADC/WIF token provider and encrypted GCS
 * mirror service factory. No service-account key is parsed or loaded here:
 * Google Auth Library resolves ADC from an attached workload identity or a
 * GOOGLE_APPLICATION_CREDENTIALS external-account federation config.
 *
 * GoogleAuthClass is injectable for deterministic tests; production loads
 * Google's maintained google-auth-library package.
 */
export async function createGoogleGeminiGcsMirrorBootstrap({
  env = process.env,
  fetchImpl = globalThis.fetch,
  GoogleAuthClass,
  GoogleCredentialClientClasses
} = {}) {
  const projectId = required(env.GOOGLE_CLOUD_PROJECT_ID, "GOOGLE_CLOUD_PROJECT_ID");
  const url = required(env.SUPABASE_URL, "SUPABASE_URL");
  const serviceRoleKey = required(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
  required(env.GEMINI_GCS_SESSION_ENCRYPTION_KEY, "GEMINI_GCS_SESSION_ENCRYPTION_KEY");
  if (typeof fetchImpl !== "function") throw new TypeError("GCS mirror bootstrap requires fetch.");

  // For external hosting, accept only generated Workload Identity Federation
  // configs. Long-lived service-account JSON keys and user ADC files are
  // deliberately rejected by this server-side workload bootstrap.
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    let credentialConfig;
    try {
      credentialConfig = JSON.parse(await readFile(String(env.GOOGLE_APPLICATION_CREDENTIALS), "utf8"));
    } catch {
      throw fail("GOOGLE_APPLICATION_CREDENTIALS must reference a readable generated WIF credential configuration.", "GEMINI_GCS_WIF_CONFIG_INVALID");
    }
    let tokenUrl = null, tokenInfoUrl = null, impersonationUrl = null;
    try { tokenUrl = new URL(credentialConfig?.token_url); } catch {}
    try { if (credentialConfig?.token_info_url) tokenInfoUrl = new URL(credentialConfig.token_info_url); } catch {}
    try { if (credentialConfig?.service_account_impersonation_url) impersonationUrl = new URL(credentialConfig.service_account_impersonation_url); } catch {}
    const source = credentialConfig?.credential_source;
    const audienceParts = typeof credentialConfig?.audience === "string" ? credentialConfig.audience.split("/") : [];
    const validAudience = audienceParts.length === 11 &&
      audienceParts[0] === "" && audienceParts[1] === "" &&
      audienceParts[2] === "iam.googleapis.com" && audienceParts[3] === "projects" &&
      /^\d+$/.test(audienceParts[4]) && audienceParts[5] === "locations" &&
      /^[a-z0-9-]+$/.test(audienceParts[6]) && audienceParts[7] === "workloadIdentityPools" &&
      /^[A-Za-z0-9_-]+$/.test(audienceParts[8]) && audienceParts[9] === "providers" &&
      /^[A-Za-z0-9_-]+$/.test(audienceParts[10]);
    const validFileSource = source &&
      typeof source === "object" &&
      !Array.isArray(source) &&
      typeof source.file === "string" &&
      source.file.trim().length > 0 &&
      isAbsolute(source.file) &&
      Object.keys(source).every(key => key === "file" || key === "format") &&
      (source.format === undefined ||
        (source.format &&
          typeof source.format === "object" &&
          !Array.isArray(source.format) &&
          ["text", "json"].includes(source.format.type) &&
          Object.keys(source.format).every(key => key === "type" || key === "subject_token_field_name") &&
          (source.format.type !== "text" || source.format.subject_token_field_name === undefined) &&
          (source.format.subject_token_field_name === undefined ||
            (typeof source.format.subject_token_field_name === "string" &&
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(source.format.subject_token_field_name)))));
    if (credentialConfig?.type !== "external_account" ||
        typeof credentialConfig.audience !== "string" ||
        !validAudience ||
        tokenUrl?.protocol !== "https:" || tokenUrl?.hostname !== "sts.googleapis.com" ||
        (credentialConfig.token_info_url && (tokenInfoUrl?.protocol !== "https:" || tokenInfoUrl?.hostname !== "sts.googleapis.com")) ||
        (credentialConfig.service_account_impersonation_url && (impersonationUrl?.protocol !== "https:" || impersonationUrl?.hostname !== "iamcredentials.googleapis.com")) ||
        !validFileSource) {
      throw fail("Only generated Google Workload Identity Federation configs with a file-based subject token and trusted Google token endpoints are accepted; URL, AWS, executable, service-account key and user credential sources are not supported.", "GEMINI_GCS_WIF_CONFIG_INVALID");
    }
  }

  let GoogleAuth = GoogleAuthClass;
  let credentialClientClasses = GoogleCredentialClientClasses;
  if (!GoogleAuth || !credentialClientClasses) {
    try {
      const authLibrary = await import("google-auth-library");
      GoogleAuth ||= authLibrary.GoogleAuth;
      credentialClientClasses ||= {
        Compute: authLibrary.Compute,
        IdentityPoolClient: authLibrary.IdentityPoolClient
      };
    } catch {
      throw fail("Install the google-auth-library runtime dependency before enabling GCS mirror recovery.", "GEMINI_GCS_AUTH_LIBRARY_MISSING");
    }
  }
  if (typeof GoogleAuth !== "function") throw new TypeError("GoogleAuth constructor is invalid.");
  if (typeof credentialClientClasses?.Compute !== "function" ||
      typeof credentialClientClasses?.IdentityPoolClient !== "function") {
    throw fail("Google Auth Library must expose the Compute and IdentityPoolClient credential classes.", "GEMINI_GCS_AUTH_TYPES_UNAVAILABLE");
  }

  const clients = new Map();
  async function getAccessToken({ projectId: requestedProjectId = projectId, scopes = [CLOUD_PLATFORM_SCOPE] } = {}) {
    if (requestedProjectId !== projectId) {
      throw fail("GCS token request project does not match the configured project.", "GEMINI_GCS_PROJECT_MISMATCH");
    }
    const normalizedScopes = [...new Set((Array.isArray(scopes) ? scopes : [scopes])
      .map(value => String(value || "").trim()).filter(Boolean))].sort();
    if (!normalizedScopes.length || normalizedScopes.length > 10 ||
        normalizedScopes.some(scope => scope.length > 256 || !/^https:\/\//.test(scope))) {
      throw fail("GCS token scopes are invalid.", "GEMINI_GCS_SCOPE_INVALID");
    }
    const cacheKey = normalizedScopes.join(" ");
    let client = clients.get(cacheKey);
    if (!client) {
      const auth = new GoogleAuth({ projectId, scopes: normalizedScopes });
      client = await auth.getClient();
      if (!client || typeof client.getAccessToken !== "function") {
        throw fail("Google ADC did not return a compatible token client.", "GEMINI_GCS_ADC_UNAVAILABLE");
      }
      clients.set(cacheKey, client);
    }
    let response;
    try {
      response = await client.getAccessToken();
    } catch {
      throw fail("Google ADC could not obtain a workload access token.", "GEMINI_GCS_ADC_TOKEN_FAILED");
    }
    const token = typeof response === "string" ? response : response?.token;
    if (typeof token !== "string" || token.length < 20 || token.length > 8192 || /\s/.test(token)) {
      throw fail("Google ADC returned an invalid access token.", "GEMINI_GCS_ADC_TOKEN_INVALID");
    }
    return token;
  }

  const createService = createGoogleGeminiGcsMirrorServiceFactory({
    getAccessToken,
    serviceDependencies: {
      url,
      serviceRoleKey,
      env,
      fetchImpl,
      maxBytes: Number(env.GEMINI_GCS_MAX_BYTES || env.CLOUD_WORKER_MAX_BYTES || 250 * 1024 * 1024),
      timeoutMs: 120000
    }
  });
  return Object.freeze({
    getAccessToken,
    createService,
    async checkIdentity() {
      await getAccessToken({ projectId, scopes: [CLOUD_PLATFORM_SCOPE] });
      const client = clients.get(CLOUD_PLATFORM_SCOPE);
      const isAttachedWorkloadIdentity = client instanceof credentialClientClasses.Compute;
      const isFileBasedWifIdentity = client instanceof credentialClientClasses.IdentityPoolClient;
      if (!isAttachedWorkloadIdentity && !isFileBasedWifIdentity) {
        throw fail(
          "GCS recovery requires an attached Compute workload identity or file-based IdentityPoolClient federation; local user ADC credentials and unsupported external credential sources are not accepted.",
          "GEMINI_GCS_ADC_IDENTITY_TYPE_REJECTED"
        );
      }
      const credentialClientType = isAttachedWorkloadIdentity ? "Compute" : "IdentityPoolClient";
      return Object.freeze({
        ready: true,
        projectId,
        identityMode: isAttachedWorkloadIdentity ? "attached-workload-identity" : "external-account-wif",
        credentialClientType
      });
    }
  });
}
