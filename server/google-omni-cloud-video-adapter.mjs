import { resolveGoogleOmniActualCost } from "./google-omni-pricing.mjs";
import { normalizeGeminiOmniFlashInteractionResponse } from "./google-omni-flash-interaction.mjs";

const PROVIDER = "google";
const MODEL = "gemini-omni-1.1-flash";
const ID = /^v1_[A-Za-z0-9_-]{6,200}$/;
const fail = (message, code) => Object.assign(new Error(message), { code });

/**
 * Adapts Gemini Omni to the existing leased cloud-video executor contract.
 * All policy-sensitive functions are injected from the authenticated app
 * composition; this module never enables the provider or reads user secrets.
 */
export function createGoogleOmniCloudVideoIntegration({
  client,
  interactions,
  outputIngestor,
  preparePlan,
  retentionExpiresAt
} = {}) {
  if (!client || typeof client.createInteraction !== "function" ||
      typeof client.getInteractionForIngestion !== "function") {
    throw new TypeError("Google Omni worker integration requires the server-only Interactions client.");
  }
  if (!interactions || typeof interactions.recordInteraction !== "function" ||
      typeof interactions.findInteraction !== "function" ||
      typeof interactions.updateInteraction !== "function") {
    throw new TypeError("Google Omni worker integration requires the durable interaction repository.");
  }
  if (!outputIngestor || typeof outputIngestor.ingestInteraction !== "function") {
    throw new TypeError("Google Omni worker integration requires private output ingestion.");
  }
  if (typeof preparePlan !== "function" || typeof retentionExpiresAt !== "function") {
    throw new TypeError("Google Omni worker integration requires an authorized request planner and retention policy.");
  }

  const adapter = Object.freeze({
    provider: PROVIDER,
    model: MODEL,
    minimumPollIntervalMs: 5000,

    async prepareInput(input, { job } = {}) {
      if (!job?.id || !job?.owner_id || job.job_type !== "video.generate" ||
          input?.provider !== PROVIDER || input?.model !== MODEL ||
          typeof input.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(input.requestHash)) {
        throw fail("Google Omni job identity or request hash is invalid.", "GEMINI_OMNI_JOB_INVALID");
      }
      let plan;
      try { plan = await preparePlan(input, { job }); }
      catch (error) {
        if (error?.code) throw error;
        throw fail("Google Omni request could not be prepared from authorized private assets.", "GEMINI_OMNI_PLAN_PREPARATION_FAILED");
      }
      if (!plan || plan.policy?.provider !== PROVIDER || plan.policy?.model !== MODEL ||
          plan.policy?.requiresApproval !== true) {
        throw fail("Google Omni planner returned an unapproved or mismatched request.", "GEMINI_OMNI_PLAN_INVALID");
      }
      return Object.freeze({
        plan,
        context: Object.freeze({
          jobId: job.id,
          ownerId: job.owner_id,
          projectId: job.project_id || null,
          requestHash: input.requestHash,
          budgetApprovalId: job.budget_approval_id || input.budgetApprovalId || null,
          estimatedCost: job.estimated_cost || null,
          approvedBy: job.approved_by || null,
          approvedAt: job.approved_at || null
        })
      });
    },

    async submit(prepared, { job } = {}) {
      if (!prepared?.plan || prepared.context?.jobId !== job?.id ||
          prepared.context?.ownerId !== job?.owner_id ||
          (prepared.context?.projectId || null) !== (job?.project_id || null)) {
        throw fail("Google Omni submission context does not match the leased job.", "GEMINI_OMNI_JOB_SCOPE_MISMATCH");
      }
      let durableRecord = null;
      const persistCreated = async (event) => {
        if (durableRecord) {
          if (durableRecord.interactionId !== event.interactionId) {
            throw fail("Google stream changed interaction identity.", "GEMINI_OMNI_STREAM_INVALID");
          }
          return;
        }
        if (!ID.test(String(event.interactionId || "")) || event.model !== MODEL) {
          throw fail("Google stream creation event is invalid.", "GEMINI_OMNI_SUBMISSION_RESPONSE_INVALID");
        }
        const submittedAt = new Date().toISOString();
        const expiresAt = await retentionExpiresAt({ job, interactionId: event.interactionId, submittedAt });
        durableRecord = await interactions.recordInteraction({
          provider: PROVIDER, model: MODEL, interactionId: event.interactionId,
          jobId: job.id, ownerId: job.owner_id, projectId: job.project_id || null,
          requestHash: prepared.context.requestHash,
          parentInteractionId: prepared.plan.payload?.previous_interaction_id || null,
          state: "running", submittedAt, expiresAt, outputUri: null,
          metadata: { outputDelivery: "uri", outputUriCapturedAtSubmission: false, captureMethod: "interactions_sse" }
        });
      };
      const accepted = await client.createInteraction(prepared.plan, prepared.context, {
        onInteractionCreated: persistCreated
      });
      if (!accepted || typeof accepted.interactionId !== "string" || !ID.test(accepted.interactionId) ||
          accepted.provider !== PROVIDER || accepted.model !== MODEL) {
        throw fail("Google Omni did not return a valid durable interaction ID.", "GEMINI_OMNI_SUBMISSION_RESPONSE_INVALID");
      }
      if (!durableRecord) await persistCreated({ interactionId: accepted.interactionId, status: accepted.status, model: MODEL });
      if (durableRecord.interactionId !== accepted.interactionId) {
        throw fail("Google submission response does not match the durable interaction.", "GEMINI_OMNI_RESPONSE_SCOPE_MISMATCH");
      }
      const nextState = ["succeeded", "failed", "canceled", "incomplete", "waiting", "running"].includes(accepted.status)
        ? accepted.status : "running";
      await interactions.updateInteraction({
        interactionId: accepted.interactionId, ownerId: job.owner_id,
        projectId: job.project_id || null, jobId: job.id, state: nextState,
        ...((accepted.outputUri || accepted.outputUrls?.[0])
          ? { outputUri: accepted.outputUri || accepted.outputUrls[0] } : {})
      });
      return { taskId: accepted.interactionId, status: accepted.status || "running" };
    },

    async getStatus(providerTaskId, { job } = {}) {
      if (typeof providerTaskId !== "string" || !ID.test(providerTaskId) ||
          !job?.id || !job?.owner_id || job.job_type !== "video.generate") {
        throw fail("Google Omni polling requires a valid task ID and leased job context.", "GEMINI_OMNI_JOB_INVALID");
      }
      const scope = {
        interactionId: providerTaskId,
        ownerId: job.owner_id,
        projectId: job.project_id || null,
        jobId: job.id
      };
      const stored = await interactions.findInteraction(scope);
      if (!stored || stored.provider !== PROVIDER || stored.model !== MODEL ||
          stored.ownerId !== job.owner_id || (stored.projectId || null) !== (job.project_id || null) ||
          stored.requestHash !== job.input?.requestHash || ["deleting", "deleted"].includes(stored.state)) {
        throw fail("Google interaction is not durably owned by this job, user and project.", "GEMINI_OMNI_INTERACTION_FORBIDDEN");
      }
      const rawInteraction = await client.getInteractionForIngestion(providerTaskId, {
        ownerId: job.owner_id, projectId: job.project_id || null, jobId: job.id
      });
      let interactionForIngestion = rawInteraction;
      const hasVideo = Array.isArray(rawInteraction?.steps) && rawInteraction.steps.some(step =>
        step?.type === "model_output" && Array.isArray(step.content) && step.content.some(item => item?.type === "video"));
      if (!hasVideo && stored.outputUri) {
        interactionForIngestion = {
          ...rawInteraction,
          steps: [...(Array.isArray(rawInteraction?.steps) ? rawInteraction.steps : []), {
            type: "model_output", content: [{ type: "video", mime_type: "video/mp4", uri: stored.outputUri }]
          }]
        };
      }
      const result = normalizeGeminiOmniFlashInteractionResponse(interactionForIngestion);
      if (result.interactionId !== providerTaskId || result.model !== MODEL) {
        throw fail("Google interaction response does not match the durable task record.", "GEMINI_OMNI_RESPONSE_SCOPE_MISMATCH");
      }
      if (!["succeeded", "failed", "canceled", "incomplete", "waiting", "running"].includes(result.status)) {
        throw fail("Google returned an unsupported interaction status.", "VIDEO_PROVIDER_STATUS_INVALID");
      }
      const state = result.status === "succeeded" ? "succeeded"
        : result.status === "failed" || result.status === "canceled" || result.status === "incomplete"
          ? "failed"
          : result.status === "waiting" ? "waiting" : "running";
      await interactions.updateInteraction({ ...scope, state, outputUri: result.video?.uri || stored.outputUri || undefined });
      return Object.freeze({
        taskId: providerTaskId,
        status: state === "waiting" ? "running" : state,
        provider: PROVIDER,
        model: MODEL,
        // The executor only needs a bounded output count. This opaque handle is
        // never fetched by a browser; ingestOutputs consumes rawInteraction.
        outputUrls: Object.freeze(state === "succeeded" ? ["google-interaction:" + providerTaskId] : []),
        rawInteraction: interactionForIngestion
      });
    }
  });

  async function ingestOutputs({ job, task, providerTaskId } = {}) {
    if (!job?.id || !job?.owner_id || !task?.rawInteraction ||
        task.taskId !== providerTaskId || task.provider !== PROVIDER || task.model !== MODEL) {
      throw fail("Google Omni output is missing its authorized raw interaction.", "GEMINI_OMNI_OUTPUT_CONTEXT_INVALID");
    }
    const result = await outputIngestor.ingestInteraction(task.rawInteraction, {
      ownerId: job.owner_id,
      projectId: job.project_id || null,
      jobId: job.id,
      requestHash: job.input?.requestHash || null
    });
    if (!result || typeof result.assetId !== "string" || !result.assetId) {
      throw fail("Google Omni private output ingestion did not return an asset ID.", "GEMINI_OMNI_OUTPUT_INGEST_FAILED");
    }
    return {
      assetIds: [result.assetId],
      usage: { outputCount: 1, outputBytes: result.sizeBytes, sha256: result.sha256 }
    };
  }

  async function resolveActualCost({ task, providerTaskId } = {}) {
    return resolveGoogleOmniActualCost({ task, providerTaskId });
  }

  return Object.freeze({ adapter, ingestOutputs, resolveActualCost });
}
