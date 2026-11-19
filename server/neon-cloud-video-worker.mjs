import { createProviderAwareCloudVideoWorker } from "./cloud-video-provider-worker.mjs";

const fail = (message, code) => Object.assign(new Error(message), { code });

function requireFunction(value, name) {
  if (typeof value !== "function") throw new Error("Neon video worker requires " + name + ".");
}

/**
 * Adapt the Neon primitives to the object-shaped contract used by the existing
 * video worker. Failed jobs are quarantined, not refunded: only authoritative
 * provider evidence may release a customer reservation.
 */
export function createNeonVideoWorkerContracts({ runtime, workerId } = {}) {
  if (!runtime || runtime.backend !== "neon-postgres" ||
      !runtime.queue || !runtime.submissions || !runtime.financials) {
    throw new Error("Neon video worker requires a composed Neon staging runtime.");
  }
  if (typeof workerId !== "string" || !workerId.trim() || workerId.length > 128) {
    throw new Error("Neon video worker ID is invalid.");
  }
  const { queue: durableQueue, submissions, financials } = runtime;
  for (const [service, methods] of [
    [durableQueue, ["claim", "renew", "assertLease", "defer", "quarantine", "recover"]],
    [submissions, ["prepare", "begin", "record", "markUnknown"]],
    [financials, ["finishVideoJob", "settleJob"]]
  ]) for (const method of methods) requireFunction(service?.[method], method);

  const activeJobs = new Map();
  const queue = Object.freeze({
    async claim(id, leaseSeconds, jobTypes) {
      if (id !== workerId) throw new Error("Neon worker claim identity mismatch.");
      const job = await durableQueue.claim(id, leaseSeconds, jobTypes);
      if (job) activeJobs.set(job.id, job);
      return job;
    },
    renew: (...args) => durableQueue.renew(...args),
    assertLease: (...args) => durableQueue.assertLease(...args)
  });

  const enqueue = Object.freeze({
    async finish({ jobId, workerId: activeWorker, leaseToken, status, output = null, error = null, actualAmount = null } = {}) {
      const job = activeJobs.get(jobId);
      if (!job || job.lease_token !== leaseToken || activeWorker !== workerId) return false;
      if (status !== "succeeded") {
        const quarantined = await durableQueue.quarantine(jobId, workerId, leaseToken, {
          code: typeof error?.code === "string" ? error.code.slice(0, 100) : "VIDEO_FAILURE_REQUIRES_RECONCILIATION",
          message: typeof error?.message === "string" ? error.message.slice(0, 500) : "Job failed without verified no-charge evidence; credits remain reserved."
        });
        if (quarantined) activeJobs.delete(jobId);
        return quarantined ? Object.freeze({ finished: true, status: "blocked" }) : false;
      }
      if (!output || typeof output !== "object" || typeof actualAmount !== "number" ||
          !Number.isFinite(actualAmount) || !Number.isSafeInteger(output.actualCredits) ||
          output.actualCredits < 0 || output.actualCredits > 1000000000) {
        throw fail("Neon finalization requires provider cost and measured customer credits.", "NEON_VIDEO_FINALIZATION_EVIDENCE_REQUIRED");
      }
      const evidence = {
        provider: output.provider,
        model: output.model,
        providerTaskId: output.providerTaskId,
        evidenceType: "provider_task_receipt",
        evidenceId: output.providerTaskId,
        evidenceReference: output.costEvidenceReference
      };
      const finished = await financials.finishVideoJob({
        jobId, ownerId: job.owner_id, workerId, leaseToken, status: "succeeded",
        output, actualAmount, actualCredits: output.actualCredits, financialEvidence: evidence
      });
      if (finished) activeJobs.delete(jobId);
      return finished;
    },
    async defer({ jobId, workerId: activeWorker, leaseToken, delaySeconds, reasonCode } = {}) {
      if (activeWorker !== workerId) return false;
      const result = await durableQueue.defer(jobId, workerId, leaseToken, delaySeconds, { code: reasonCode });
      if (result) activeJobs.delete(jobId);
      return result;
    },
    async quarantine({ jobId, workerId: activeWorker, leaseToken, reasonCode } = {}) {
      if (activeWorker !== workerId) return false;
      const result = await durableQueue.quarantine(jobId, workerId, leaseToken, {
        code: typeof reasonCode === "string" ? reasonCode.slice(0, 100) : "VIDEO_REQUIRES_REVIEW",
        message: "Video generation is held for operator reconciliation."
      });
      if (result) activeJobs.delete(jobId);
      return result ? Object.freeze({ finished: true, status: "blocked" }) : false;
    },
    async recoverExpiredVideo(limit = 100) { return durableQueue.recover(limit); }
  });

  return Object.freeze({
    queue,
    enqueue,
    ledger: submissions,
    customerCredits: runtime.customerCredits || financials
  });
}

/**
 * Compose the existing provider-aware executor over Neon. Remote execution is
 * deliberately opt-in, and every adapter operation is wrapped in a mandatory
 * owner/project authorization callback supplied by the application boundary.
 */
export function createNeonCloudVideoWorker({
  runtime,
  workerId,
  adapters,
  authorizeJob,
  env = process.env,
  deferSeconds = 30
} = {}) {
  if (env.NEON_STAGING_RUNTIME_ENABLED !== "true" ||
      env.NEON_STAGING_BRANCH_NAME !== "executive-visuals-staging") {
    throw new Error("Neon video worker requires the explicitly enabled staging runtime and approved staging branch.");
  }
  if (env.CLOUD_VIDEO_WORKER_ENABLED !== "true" ||
      env.VIDEO_GATEWAY_ENABLED !== "true" ||
      env.VIDEO_GATEWAY_ALLOW_REMOTE !== "true") {
    throw new Error("Neon remote video execution requires explicit worker and remote gateway gates.");
  }
  requireFunction(authorizeJob, "an owner/project authorization callback");
  if (!Array.isArray(adapters) || adapters.length < 1 || adapters.length > 100) {
    throw new Error("Neon video worker requires between 1 and 100 provider adapters.");
  }

  const contracts = createNeonVideoWorkerContracts({ runtime, workerId });
  const guardedAdapters = adapters.map(adapter => {
    if (!adapter || typeof adapter !== "object" ||
        typeof adapter.submit !== "function" || typeof adapter.getStatus !== "function" ||
        typeof adapter.ingestOutputs !== "function" || typeof adapter.resolveActualCost !== "function") {
      throw new Error("Each Neon provider adapter must implement submit, status, private ingestion and actual-cost reconciliation.");
    }
    const authorize = async (context, operation) => {
      const job = context?.job;
      if (!job?.id || !job.owner_id || !job.job_type || job.job_type !== "video.generate") {
        throw fail("Neon worker operation is missing its owned video job context.", "VIDEO_JOB_SCOPE_INVALID");
      }
      let allowed = false;
      try {
        allowed = await authorizeJob({
          ownerId: job.owner_id, projectId: job.project_id || null,
          jobId: job.id, provider: adapter.provider, model: adapter.model, operation
        });
      } catch {}
      if (allowed !== true) throw fail("Owner/project authorization failed; provider execution is blocked.", "VIDEO_TENANT_AUTHORIZATION_DENIED");
    };
    return Object.freeze({
      provider: adapter.provider,
      model: adapter.model,
      minimumPollIntervalMs: adapter.minimumPollIntervalMs,
      async prepareInput(input, context) {
        await authorize(context, "prepare");
        return typeof adapter.prepareInput === "function" ? adapter.prepareInput(input, context) : input;
      },
      async submit(input, context) { await authorize(context, "submit"); return adapter.submit(input, context); },
      async getStatus(taskId, context) { await authorize(context, "poll"); return adapter.getStatus(taskId, context); },
      async ingestOutputs(args) { await authorize(args, "publish"); return adapter.ingestOutputs(args); },
      async resolveActualCost(args) { await authorize(args, "reconcile_cost"); return adapter.resolveActualCost(args); }
    });
  });

  const worker = createProviderAwareCloudVideoWorker({
    workerId, ...contracts, adapters: guardedAdapters, deferSeconds
  });
  return Object.freeze({
    runCycle: worker.runCycle,
    recoverExpired: worker.recoverExpired,
    listSupported: worker.listSupported
  });
}
