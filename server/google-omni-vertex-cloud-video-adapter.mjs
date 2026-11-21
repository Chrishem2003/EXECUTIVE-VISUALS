import {
  estimateGoogleOmniVertexVideoCost,
  resolveGoogleOmniVertexActualCost
} from "./google-omni-vertex-pricing.mjs";

const PROVIDER = "google";
const MODEL = "gemini-omni-1.2-flash";
const ID = /^v1_[A-Za-z0-9_-]{6,200}$/;
const fail = (message, code) => Object.assign(new Error(message), { code });

function providerState(status) {
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "canceled") return "canceled";
  if (status === "queued" || status === "in_progress" || status === "requires_action" || status === "running") return "running";
  if (status === "incomplete") return "failed";
  throw fail("Vertex returned an unsupported interaction state.", "VIDEO_PROVIDER_STATUS_INVALID");
}

function videoOutputUri(interaction) {
  const matches = (Array.isArray(interaction?.steps) ? interaction.steps : [])
    .filter(step => step?.type === "model_output" && Array.isArray(step.content))
    .flatMap(step => step.content)
    .filter(item => item?.type === "video" && item.mime_type === "video/mp4" && typeof item.uri === "string");
  if (matches.length > 1) throw fail("Vertex returned multiple video outputs for a single-output job.", "VIDEO_OUTPUT_COLLECTION_INVALID");
  return matches[0]?.uri || null;
}

/** Bind Vertex Omni 1.2 to the durable cloud worker contract. */
export function createGoogleOmniVertexCloudVideoIntegration({
  client,
  interactions,
  outputIngestor,
  preparePlan,
  retentionExpiresAt
} = {}) {
  if (!client || typeof client.createInteraction !== "function" ||
      typeof client.getInteractionForIngestion !== "function" ||
      typeof client.cancelInteraction !== "function") {
    throw new TypeError("Vertex Omni 1.2 integration requires the authenticated Interactions client.");
  }
  if (!interactions || typeof interactions.recordInteraction !== "function" ||
      typeof interactions.findInteraction !== "function" ||
      typeof interactions.updateInteraction !== "function") {
    throw new TypeError("Vertex Omni 1.2 integration requires its model-scoped durable interaction repository.");
  }
  if (!outputIngestor || typeof outputIngestor.ingestInteraction !== "function") {
    throw new TypeError("Vertex Omni 1.2 integration requires private GCS output ingestion.");
  }
  if (typeof preparePlan !== "function" || typeof retentionExpiresAt !== "function") {
    throw new TypeError("Vertex Omni 1.2 integration requires an approved request planner and retention policy.");
  }

  const adapter = Object.freeze({
    provider: PROVIDER,
    model: MODEL,
    minimumPollIntervalMs: 5000,

    async prepareInput(input, { job } = {}) {
      if (!job?.id || !job?.owner_id || job.job_type !== "video.generate" ||
          input?.provider !== PROVIDER || input?.model !== MODEL ||
          typeof input.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(input.requestHash)) {
        throw fail("Vertex Omni job identity or request hash is invalid.", "GOOGLE_VERTEX_JOB_INVALID");
      }
      let plan;
      try { plan = await preparePlan(input, { job }); }
      catch (error) {
        if (error?.code) throw error;
        throw fail("Vertex Omni request could not be prepared from authorized private assets.", "GOOGLE_VERTEX_PLAN_PREPARATION_FAILED");
      }
      if (!plan || plan.policy?.provider !== PROVIDER || plan.policy?.model !== MODEL ||
          plan.policy?.requiresApproval !== true || plan.payload?.model !== MODEL) {
        throw fail("Vertex Omni planner returned an unapproved or mismatched request.", "GOOGLE_VERTEX_PLAN_INVALID");
      }
      return Object.freeze({
        plan,
        context: Object.freeze({
          jobId: job.id, ownerId: job.owner_id, projectId: job.project_id || null,
          requestHash: input.requestHash,
          budgetApprovalId: job.budget_approval_id || input.budgetApprovalId || null,
          estimatedCost: job.estimated_cost || null,
          approvedBy: job.approved_by || null, approvedAt: job.approved_at || null,
          workerId: job.lease_owner || null, leaseToken: job.lease_token || null
        })
      });
    },

    async preflight(prepared) {
      const quote = estimateGoogleOmniVertexVideoCost({ model: MODEL });
      return Object.freeze({
        provider: PROVIDER, model: MODEL,
        estimatedUsd: quote.amount, estimatedCredits: quote.estimatedCredits,
        currency: quote.currency, billable: false,
        basis: quote.basis, pricingSource: quote.pricingSource,
        configId: "google-omni-1.2-vertex-max-reservation"
      });
    },

    async submit(prepared, { job, signal } = {}) {
      if (!prepared?.plan || prepared.context?.jobId !== job?.id ||
          prepared.context?.ownerId !== job?.owner_id ||
          (prepared.context?.projectId || null) !== (job?.project_id || null)) {
        throw fail("Vertex Omni submission context does not match the leased job.", "GOOGLE_VERTEX_JOB_SCOPE_MISMATCH");
      }
      let durableRecord = null;
      const persistCreated = async event => {
        if (durableRecord) {
          if (durableRecord.interactionId !== event.interactionId) {
            throw fail("Vertex changed interaction identity during submission.", "GOOGLE_VERTEX_SUBMISSION_INVALID");
          }
          return;
        }
        if (!ID.test(String(event?.interactionId || "")) || event.model !== MODEL ||
            typeof event.outputUri !== "string" || !event.outputUri.startsWith("gs://")) {
          throw fail("Vertex interaction creation event is invalid.", "GOOGLE_VERTEX_SUBMISSION_INVALID");
        }
        const submittedAt = new Date().toISOString();
        const expiresAt = await retentionExpiresAt({ job, interactionId: event.interactionId, submittedAt });
        durableRecord = await interactions.recordInteraction({
          provider: PROVIDER, model: MODEL, interactionId: event.interactionId,
          jobId: job.id, ownerId: job.owner_id, projectId: job.project_id || null,
          requestHash: prepared.context.requestHash,
          parentInteractionId: prepared.plan.payload?.previous_interaction_id || null,
          state: "running", submittedAt, expiresAt, outputUri: event.outputUri,
          metadata: {
            outputDelivery: "gcs_uri", captureMethod: "vertex_interactions_poll",
            outputUriCapturedAtSubmission: true, billingModel: "modality_tokens"
          }
        });
      };
      const accepted = await client.createInteraction(prepared.plan, prepared.context, {
        onInteractionCreated: persistCreated, signal
      });
      if (!accepted || !ID.test(String(accepted.interactionId || "")) ||
          accepted.provider !== PROVIDER || accepted.model !== MODEL) {
        throw fail("Vertex did not return a valid durable interaction ID.", "GOOGLE_VERTEX_SUBMISSION_INVALID");
      }
      if (!durableRecord) {
        await persistCreated({
          interactionId: accepted.interactionId, status: accepted.status,
          model: MODEL, outputUri: accepted.outputUri
        });
      }
      if (durableRecord.interactionId !== accepted.interactionId) {
        throw fail("Vertex submission response does not match its durable interaction record.", "GOOGLE_VERTEX_RESPONSE_SCOPE_MISMATCH");
      }
      const state = providerState(accepted.status);
      await interactions.updateInteraction({
        interactionId: accepted.interactionId, ownerId: job.owner_id,
        projectId: job.project_id || null, jobId: job.id, state,
        outputUri: accepted.outputUri
      });
      return { taskId: accepted.interactionId, status: state === "succeeded" ? "succeeded" : state };
    },

    async getStatus(providerTaskId, { job } = {}) {
      if (typeof providerTaskId !== "string" || !ID.test(providerTaskId) ||
          !job?.id || !job?.owner_id || job.job_type !== "video.generate") {
        throw fail("Vertex polling requires a valid task ID and leased job context.", "GOOGLE_VERTEX_JOB_INVALID");
      }
      const scope = {
        interactionId: providerTaskId, ownerId: job.owner_id,
        projectId: job.project_id || null, jobId: job.id
      };
      const stored = await interactions.findInteraction(scope);
      if (!stored || stored.provider !== PROVIDER || stored.model !== MODEL ||
          stored.ownerId !== job.owner_id || (stored.projectId || null) !== (job.project_id || null) ||
          stored.requestHash !== job.input?.requestHash || ["deleting", "deleted"].includes(stored.state)) {
        throw fail("Vertex interaction is not durably owned by this job, user and project.", "GOOGLE_VERTEX_INTERACTION_FORBIDDEN");
      }
      const rawInteraction = await client.getInteractionForIngestion(providerTaskId, {
        ownerId: job.owner_id, projectId: job.project_id || null, jobId: job.id
      });
      const state = providerState(rawInteraction.status);
      const outputUri = videoOutputUri(rawInteraction);
      if (state === "succeeded" && !outputUri) {
        throw fail("Vertex completed without its private GCS video URI.", "GOOGLE_VERTEX_OUTPUT_URI_MISSING");
      }
      await interactions.updateInteraction({ ...scope, state, ...(outputUri ? { outputUri } : {}) });
      return Object.freeze({
        taskId: providerTaskId, status: state,
        provider: PROVIDER, model: MODEL,
        outputUrls: Object.freeze(state === "succeeded" ? ["google-vertex-interaction:" + providerTaskId] : []),
        rawInteraction
      });
    },

    async cancel(providerTaskId, { job } = {}) {
      if (!job?.id || !job?.owner_id) throw fail("Vertex cancellation requires an authorized job.", "GOOGLE_VERTEX_JOB_INVALID");
      const stored = await interactions.findInteraction({
        interactionId: providerTaskId, ownerId: job.owner_id,
        projectId: job.project_id || null, jobId: job.id
      });
      if (!stored || stored.model !== MODEL) throw fail("Vertex cancellation is not authorized for this job.", "GOOGLE_VERTEX_INTERACTION_FORBIDDEN");
      return client.cancelInteraction(providerTaskId, {
        ownerId: job.owner_id, projectId: job.project_id || null, jobId: job.id
      });
    }
  });

  async function ingestOutputs({ job, task, providerTaskId, signal, assertLease } = {}) {
    if (!job?.id || !job?.owner_id || !task?.rawInteraction ||
        task.taskId !== providerTaskId || task.provider !== PROVIDER || task.model !== MODEL ||
        typeof assertLease !== "function") {
      throw fail("Vertex output is missing its authorized interaction or current worker lease.", "GOOGLE_VERTEX_OUTPUT_CONTEXT_INVALID");
    }
    const result = await outputIngestor.ingestInteraction(task.rawInteraction, {
      ownerId: job.owner_id, projectId: job.project_id || null, jobId: job.id,
      requestHash: job.input?.requestHash || null,
      workerId: job.lease_owner, leaseToken: job.lease_token,
      signal, assertLease
    });
    if (!result || typeof result.assetId !== "string" || !result.assetId) {
      throw fail("Vertex private output ingestion did not return an asset ID.", "GOOGLE_VERTEX_OUTPUT_INGEST_FAILED");
    }
    return {
      assetIds: [result.assetId],
      usage: { outputCount: 1, outputBytes: result.sizeBytes, sha256: result.sha256 }
    };
  }

  async function resolveActualCost({ task, providerTaskId } = {}) {
    return resolveGoogleOmniVertexActualCost({ task, providerTaskId });
  }

  return Object.freeze({ adapter, ingestOutputs, resolveActualCost });
}
