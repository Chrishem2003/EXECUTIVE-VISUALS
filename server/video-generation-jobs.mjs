import { randomUUID, createHash } from "node:crypto";
import { normalizeVideoGenerationRequest, assertVideoCapabilities } from "./video-generation-contract.mjs";
import { getVideoProviderModel } from "./video-provider-registry.mjs";
import { reserveRemoteRequest } from "./usage-guardrails.mjs";

const JOB_TYPE = "video.generate";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,180}$/;

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * Durable enqueue boundary for governed remote video generation.
 *
 * This service deliberately does not contact a provider. It creates a durable
 * job only after provider capability validation, project authorization,
 * explicit budget approval, and an atomic rolling-window usage reservation.
 * The worker that consumes video.generate jobs is a separate release gate.
 */
export function createVideoGenerationJobService({
  db,
  authorizeProject = () => false,
  reserveBudget,
  usageLimit,
  providerResolver = (providerId, modelId) => {
    const model = getVideoProviderModel(providerId, modelId);
    return model ? { providerId, modelId, availability: model.availability, capabilities: model.capabilities } : null;
  }
} = {}) {
  if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
    throw new Error("Video generation jobs require the application database.");
  }
  if (typeof authorizeProject !== "function" || typeof reserveBudget !== "function" || typeof providerResolver !== "function") {
    throw new Error("Video generation jobs require project authorization, budget approval and provider resolution.");
  }

  return Object.freeze({
    enqueue({ ownerId, projectId = null, idempotencyKey, input } = {}) {
      if (typeof ownerId !== "string" || !ownerId.trim()) throw fail("Authenticated owner is required.", "VIDEO_JOB_OWNER_REQUIRED");
      if (projectId !== null && projectId !== undefined && projectId !== "" && !authorizeProject(ownerId, projectId)) {
        throw fail("Project is not accessible for editing.", "VIDEO_JOB_PROJECT_FORBIDDEN");
      }
      const key = idempotencyKey == null || idempotencyKey === "" ? null : String(idempotencyKey);
      if (key !== null && !IDEMPOTENCY_KEY.test(key)) throw fail("Idempotency key is invalid.", "VIDEO_JOB_IDEMPOTENCY_INVALID");

      const request = normalizeVideoGenerationRequest({ ...(input || {}), ...(projectId ? { projectId } : {}) });
      const providerId = request.provider;
      const modelId = request.model;
      if (!providerId || !modelId) throw fail("An explicit provider and model are required.", "VIDEO_JOB_PROVIDER_REQUIRED");
      const provider = providerResolver(providerId, modelId);
      if (!provider || provider.availability !== "enabled") throw fail("The selected video provider/model is not enabled for user-facing execution.", "VIDEO_JOB_PROVIDER_DISABLED");
      assertVideoCapabilities(request, provider.capabilities || {});
      const requestJson = stableJson({ ...request, projectId: projectId || null });
      const requestHash = createHash("sha256").update(requestJson).digest("hex");

      const run = db.transaction(() => {
        if (key) {
          const existing = db.prepare("SELECT * FROM jobs WHERE owner_id=? AND idempotency_key=?").get(ownerId, key);
          if (existing) {
            const same = existing.job_type === JOB_TYPE &&
              existing.project_id === (projectId || null) &&
              createHash("sha256").update(stableJson(JSON.parse(existing.input_json))).digest("hex") === requestHash;
            if (!same) throw fail("This idempotency key was already used for a different video request.", "VIDEO_JOB_IDEMPOTENCY_CONFLICT");
            return { job: existing, idempotentReplay: true };
          }
        }

        const budget = reserveBudget({ ownerId, projectId: projectId || null, provider: providerId, model: modelId, capability: "video.generate", requestHash });
        if (!budget || budget.approved !== true || typeof budget.reservationId !== "string" || !budget.reservationId.trim()) {
          throw fail("A confirmed budget reservation is required before remote video generation can be queued.", "VIDEO_JOB_BUDGET_NOT_APPROVED");
        }
        const usage = reserveRemoteRequest(db, {
          ownerId,
          projectId: projectId || null,
          provider: { provider: providerId, remote: true },
          capability: "video.generate",
          limit: usageLimit
        });
        const id = randomUUID();
        const storedInput = { ...request, provider: providerId, model: modelId, requestHash, budgetReservationId: budget.reservationId, remoteUsageReservationId: usage.reservationId };
        db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,input_json,idempotency_key) VALUES(?,?,? ,?,'queued',?,?)")
          .run(id, ownerId, projectId || null, JOB_TYPE, stableJson(storedInput), key);
        const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
        return { job, idempotentReplay: false };
      });

      const result = run();
      return Object.freeze({
        job: Object.freeze({
          id: result.job.id,
          ownerId: result.job.owner_id,
          projectId: result.job.project_id,
          jobType: result.job.job_type,
          status: result.job.status,
          createdAt: result.job.created_at,
          input: JSON.parse(result.job.input_json)
        }),
        idempotentReplay: result.idempotentReplay
      });
    }
  });
}
