import { createFalAsyncVideoClient } from "./fal-video-async.mjs";

const QUEUE_ORIGIN = "https://queue.fal.run";
const fail = (message, code) => Object.assign(new Error(message), { code });

function modelName(value) {
  const model = String(value || "").trim();
  if (!model || model.length > 240 || !/^[a-zA-Z0-9_./:-]+$/.test(model) ||
      model.startsWith("/") || model.includes("..") || model.split("/").length < 2 || model.split("/").some(part => !part || part === ".")) {
    throw fail("A valid exact FAL model identifier is required.", "VIDEO_ADAPTER_CONFIGURATION_INVALID");
  }
  return model;
}

function taskFor(model, requestId) {
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(requestId)) {
    throw fail("The persisted FAL request ID is invalid.", "VIDEO_PROVIDER_TASK_INVALID");
  }
  const root = QUEUE_ORIGIN + "/" + model.split("/").slice(0, 2).join("/") + "/requests/" + requestId;
  return {
    provider: "fal", model, requestId,
    statusUrl: root + "/status",
    resultUrl: root,
    cancelUrl: root + "/cancel"
  };
}

function outputUrls(result) {
  const candidates = [];
  if (typeof result?.video?.url === "string") candidates.push(result.video.url);
  if (Array.isArray(result?.videos)) {
    for (const item of result.videos) if (typeof item?.url === "string") candidates.push(item.url);
  }
  const urls = [...new Set(candidates)];
  if (!urls.length || urls.length > 10) {
    throw fail("FAL completed without a bounded video output collection.", "VIDEO_OUTPUT_COLLECTION_INVALID");
  }
  for (const raw of urls) {
    let url;
    try { url = new URL(raw); }
    catch { throw fail("FAL returned an invalid video output URL.", "VIDEO_OUTPUT_URL_REJECTED"); }
    if (url.protocol !== "https:" || !(url.hostname === "fal.media" || url.hostname.endsWith(".fal.media")) ||
        url.username || url.password || url.port || url.hash) {
      throw fail("FAL returned an unsafe video output URL.", "VIDEO_OUTPUT_URL_REJECTED");
    }
  }
  return urls;
}

/**
 * Adapter for the durable cloud-video executor contract. Provider task IDs are
 * request IDs only; task URLs are deterministically reconstructed from the
 * adapter's fixed model, avoiding large or secret-bearing ledger payloads.
 */
export function createFalCloudVideoAdapter({
  model = process.env.FAL_VIDEO_MODEL,
  client,
  apiKey = process.env.FAL_KEY,
  enabled = process.env.VIDEO_GATEWAY_ENABLED === "true",
  allowRemote = process.env.VIDEO_GATEWAY_ALLOW_REMOTE === "true",
  fetchImpl = globalThis.fetch,
  prepareInput,
  ingestOutputs,
  resolveActualCost
} = {}) {
  const selectedModel = modelName(model);
  const queueClient = client || createFalAsyncVideoClient({
    apiKey, model: selectedModel, enabled, allowRemote, fetchImpl
  });
  const assertRemoteEnabled = () => {
    if (enabled !== true) throw fail("Video generation is disabled by server configuration.", "VIDEO_GATEWAY_DISABLED");
    if (allowRemote !== true) throw fail("Remote video providers are disabled.", "VIDEO_GATEWAY_REMOTE_DISABLED");
  };
  if (!queueClient || typeof queueClient.submit !== "function" ||
      typeof queueClient.status !== "function" || typeof queueClient.result !== "function") {
    throw new Error("FAL cloud adapter requires submit, status and result operations.");
  }
  if (typeof ingestOutputs !== "function" || typeof resolveActualCost !== "function") {
    throw fail("FAL cloud adapter requires private output ingestion and authoritative cost reconciliation.", "VIDEO_EXECUTION_GATES_MISSING");
  }

  return Object.freeze({
    provider: "fal",
    model: selectedModel,
    minimumPollIntervalMs: 5000,

    async prepareInput(input, context) {
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          input.provider !== "fal" || input.model !== selectedModel) {
        throw fail("FAL job identity does not match the selected adapter.", "VIDEO_JOB_INPUT_MISMATCH");
      }
      const references = input.referenceAssetIds;
      if ((Array.isArray(references) && references.length > 0 || input.referenceImageDataUrl) && typeof prepareInput !== "function") {
        throw fail("Private FAL reference assets require an authenticated project-scoped resolver.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
      }
      if (typeof prepareInput !== "function") return input;
      const prepared = await prepareInput(input, context);
      if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
        throw fail("FAL private input preparation returned an invalid payload.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
      }
      return prepared;
    },

    async submit(input) {
      assertRemoteEnabled();
      if (!input || input.provider !== "fal" || input.model !== selectedModel) {
        throw fail("FAL job identity does not match the selected adapter.", "VIDEO_JOB_INPUT_MISMATCH");
      }
      const submitted = await queueClient.submit({
        prompt: input.prompt,
        duration: input.durationSeconds,
        aspectRatio: input.aspectRatio,
        referenceImageDataUrl: input.referenceImageDataUrl || ""
      });
      return { taskId: submitted.requestId, status: "queued" };
    },

    async getStatus(providerTaskId, context) {
      assertRemoteEnabled();
      const task = taskFor(selectedModel, providerTaskId);
      const status = await queueClient.status(task);
      if (status.status === "IN_QUEUE") return { status: "queued", queuePosition: status.queuePosition };
      if (status.status === "IN_PROGRESS") return { status: "running" };
      if (status.error || status.errorType) {
        return { status: "failed", failure: status.error || "FAL video task failed.", failureCode: status.errorType || "VIDEO_PROVIDER_FAILED" };
      }
      let result;
      try { result = await queueClient.result(task); }
      catch (error) {
        if (error?.code === "VIDEO_GATEWAY_RESULT_NOT_READY") return { status: "running" };
        throw error;
      }
      return { status: "succeeded", taskId: providerTaskId, outputUrls: outputUrls(result), provider: "fal", model: selectedModel };
    },

    async ingestOutputs({ job, input, task, providerTaskId }) {
      return ingestOutputs({ job, input, task, providerTaskId, provider: "fal", model: selectedModel });
    },

    async resolveActualCost({ job, input, task, providerTaskId }) {
      return resolveActualCost({ job, input, task, providerTaskId, provider: "fal", model: selectedModel });
    }
  });
}
