import { createGoogleOmniCloudVideoIntegration } from "./google-omni-cloud-video-adapter.mjs";
import { createGoogleOmniPrivateOutputIngestor } from "./google-omni-private-output-ingestion.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  timeoutMs = 120000,
  tempRoot = tmpdir()
} = {}) {
  if (!assets || typeof assets.findVideoGenerationOutput !== "function" ||
      typeof assets.createFromFileIdempotent !== "function") {
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
      if (typeof value.assertLease !== "function" ||
          typeof value.workerId !== "string" || !value.workerId.trim() ||
          typeof value.leaseToken !== "string" || !value.jobId) {
        throw fail("Google output ingestion requires the active cloud worker lease.", "GOOGLE_OMNI_WORKER_LEASE_REQUIRED");
      }
      let directory;
      try {
        if (await value.assertLease() !== true) {
          throw fail("Google output worker lease is no longer current.", "CLOUD_WORKER_LEASE_LOST");
        }
        directory = await mkdtemp(join(tempRoot, "executive-visuals-google-output-"));
        const filePath = join(directory, "gemini-omni-output.mp4");
        await writeFile(filePath, value.bytes, { flag: "wx", mode: 0o600 });
        const asset = await assets.createFromFileIdempotent({
          ownerId: value.ownerId,
          projectId: value.projectId || null,
          originalName: "gemini-omni-" + value.interactionId + ".mp4",
          mediaType: value.mimeType,
          filePath,
          publicationKey: "google:" + value.jobId + ":" + value.interactionId + ":output:0",
          metadata: value.metadata,
          assertLease: value.assertLease,
          signal: value.signal || null,
          leaseContext: { jobId: value.jobId, workerId: value.workerId, leaseToken: value.leaseToken }
        });
        return asset;
      } catch (error) {
        throw fail("Google video could not be committed to the fenced private asset repository.",
          error?.code || "GEMINI_OMNI_OUTPUT_INGEST_FAILED");
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
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
