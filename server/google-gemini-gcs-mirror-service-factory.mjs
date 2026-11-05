import { createGoogleGeminiGcsMirrorAttemptRepository } from "./google-gemini-gcs-mirror-attempt-repository.mjs";
import { createGoogleGeminiGcsMirrorService } from "./google-gemini-gcs-mirror-service.mjs";

/**
 * Creates the server-only factory expected by startCloudWorkerProcess.
 * Google OAuth identity remains explicitly injected by the hosting process;
 * encrypted durable attempt storage is constructed from server-side settings.
 */
export function createGoogleGeminiGcsMirrorServiceFactory({
  getAccessToken,
  serviceDependencies = {}
} = {}) {
  if (typeof getAccessToken !== "function") {
    throw new TypeError("GCS mirror service factory requires an explicit server-side Google Cloud token provider.");
  }
  if (!serviceDependencies || typeof serviceDependencies !== "object" || Array.isArray(serviceDependencies)) {
    throw new TypeError("GCS mirror service dependencies are invalid.");
  }

  return function createService(options = {}) {
    const config = { ...serviceDependencies, ...options };
    const attemptRepository = createGoogleGeminiGcsMirrorAttemptRepository({
      url: config.url,
      serviceRoleKey: config.serviceRoleKey,
      encryptionKey: config.env?.GEMINI_GCS_SESSION_ENCRYPTION_KEY,
      fetchImpl: config.fetchImpl
    });
    return createGoogleGeminiGcsMirrorService({
      ...config,
      getAccessToken,
      attemptRepository
    });
  };
}
