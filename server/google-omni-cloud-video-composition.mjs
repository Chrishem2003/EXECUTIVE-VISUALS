import { createGoogleOmniCloudVideoIntegration } from "./google-omni-cloud-video-adapter.mjs";
import { createGoogleOmniPrivateOutputIngestor } from "./google-omni-private-output-ingestion.mjs";

const MODEL = "gemini-omni-1.1-flash";
const fail = (message, code) => Object.assign(new Error(message), { code });

/**
 * Bind the Google Omni adapter to the existing owner-scoped Cloud Asset
 * repository. This is the missing composition boundary between the provider
 * integration and durable private asset storage.
 *
 * Construction is side-effect free. It does not enable remote execution.
 */
export function createGoogleOmniCloudVideoComposition({
  assets,
  client,
  interactions,
  preparePlan,
  retentionExpiresAt,
  authorizeOutputIngestion: additionalOutputAuthorization,
  env = process.env,
  fetchImpl = globalThis.fetch,
  maxOutputBytes = 250 * 1024 * 1024,
  maxInlineVideoBytes = 32 * 1024 * 1024,
  timeoutMs = 120000
} = {}) {
  if (!assets || typeof assets.findVideoGenerationOutput !== "function" ||
      typeof assets.create !== "function") {
    throw new TypeError("Google Omni composition requires the existing private Cloud Asset repository.");
  }
  if (!interactions || typeof interactions.findInteraction !== "function") {
    throw new TypeError("Google Omni composition requires the durable interaction repository.");
  }
  if (typeof additionalOutputAuthorization !== "undefined" &&
      typeof additionalOutputAuthorization !== "function") {
    throw new TypeError("Additional Google output authorization must be a function.");
  }

  const outputIngestor = createGoogleOmniPrivateOutputIngestor({
    env,
    fetchImpl,
    timeoutMs,
    maxOutputBytes,
    maxInlineVideoBytes,
    authorizeOutputIngestion: async ({ interactionId, context }) => {
      const record = await interactions.findInteraction({
        interactionId,
        ownerId: context.ownerId,
        projectId: context.projectId || null,
        jobId: context.jobId
      });
      if (!record || record.provider !== "google" || record.model !== MODEL ||
          record.interactionId !== interactionId ||
          record.ownerId !== context.ownerId ||
          (record.projectId || null) !== (context.projectId || null) ||
          record.jobId !== context.jobId ||
          !/^[a-f0-9]{64}$/.test(String(context.requestHash || "")) ||
          record.requestHash !== context.requestHash ||
          record.state !== "succeeded") {
        return false;
      }
      if (additionalOutputAuthorization) {
        return await additionalOutputAuthorization({ interactionId, context, record }) === true;
      }
      return true;
    },
    findExistingOutput: args => assets.findVideoGenerationOutput(args),
    ingestPrivateOutput: async value => {
      let asset;
      try {
        asset = await assets.create({
          ownerId: value.ownerId,
          projectId: value.projectId || null,
          originalName: "gemini-omni-" + value.interactionId + ".mp4",
          mediaType: value.mimeType,
          bytes: value.bytes,
          metadata: value.metadata
        });
      } catch {
        throw fail("Google video could not be committed to the existing private asset repository.",
          "GEMINI_OMNI_OUTPUT_INGEST_FAILED");
      }
      return asset;
    }
  });

  const integration = createGoogleOmniCloudVideoIntegration({
    client,
    interactions,
    outputIngestor,
    preparePlan,
    retentionExpiresAt
  });

  return Object.freeze({
    ...integration,
    outputIngestor
  });
}
