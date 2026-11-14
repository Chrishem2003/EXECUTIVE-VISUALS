import { createGoogleGeminiGcsAssetResolver } from "./google-gemini-gcs-asset-resolver.mjs";
import { createGoogleGeminiGcsFilesRegistrar } from "./google-gemini-gcs-registrar.mjs";
import { createGoogleGeminiFilesRepository } from "./google-gemini-files-repository.mjs";
import { createGoogleGeminiGcsSourceRepository } from "./google-gemini-gcs-source-repository.mjs";

/**
 * Composes the verified GCS source resolver with the durable Gemini provider
 * file registrar. Construction is side-effect free; no IAM or provider calls
 * happen until an explicit check/register/delete method is invoked.
 */
export function createGoogleGeminiGcsFilesComposition({
  env = process.env,
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  getAccessToken,
  loadSource,
  sourceRepository,
  authorizePrivateAsset,
  repository,
  maxBytes = 250 * 1024 * 1024,
  timeoutMs = 30000,
  registrationDays = 29,
  now
} = {}) {
  if (typeof getAccessToken !== "function" ||
      (loadSource !== undefined && typeof loadSource !== "function") ||
      typeof authorizePrivateAsset !== "function" || typeof fetchImpl !== "function") {
    throw new TypeError("Gemini GCS composition requires OAuth, a trusted source registry, private asset authorization and fetch.");
  }
  const mappings = repository || createGoogleGeminiFilesRepository({
    url, serviceRoleKey, fetchImpl, timeoutMs: Math.min(timeoutMs, 30000)
  });
  if (typeof mappings.findProviderFile !== "function" ||
      typeof mappings.recordProviderFile !== "function" ||
      typeof mappings.deleteProviderFileRecord !== "function") {
    throw new TypeError("Gemini GCS composition requires the durable provider-file repository.");
  }

  const sources = sourceRepository || (loadSource ? null : createGoogleGeminiGcsSourceRepository({ url, serviceRoleKey, fetchImpl, timeoutMs: Math.min(timeoutMs, 30000) }));
  if (sources && (typeof sources.findActiveSource !== "function" || typeof sources.revokeSource !== "function")) {
    throw new TypeError("Gemini GCS composition requires the governed GCS source repository.");
  }
  const trustedSourceLoader = loadSource || (scope => sources.findActiveSource(scope));
  const resolver = createGoogleGeminiGcsAssetResolver({
    env, loadSource: trustedSourceLoader, getAccessToken, fetchImpl, maxBytes, timeoutMs: Math.min(timeoutMs, 120000)
  });
  const registrar = createGoogleGeminiGcsFilesRegistrar({
    env,
    fetchImpl,
    getAccessToken,
    resolvePrivateGcsAsset: args => resolver.resolvePrivateGcsAsset(args),
    authorizePrivateAsset,
    repository: mappings,
    maxBytes,
    timeoutMs,
    registrationDays,
    ...(typeof now === "function" ? { now } : {})
  });

  return Object.freeze({
    registerAsset: args => registrar.registerAsset(args),
    deleteAssetRegistration: args => registrar.deleteAssetRegistration(args),
    revokeSource: args => {
      if (!sources) throw new Error("Source revocation is unavailable when a custom source loader is injected.");
      return sources.revokeSource(args);
    }
  });
}
