import { createHash } from "node:crypto";

const fail = (message, code) => Object.assign(new Error(message), { code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIG = /^[a-z][a-z0-9_-]{0,63}$/;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (plain(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

function requestFingerprint(input) {
  const { requestHash: _ignored, ...unsigned } = input;
  return createHash("sha256").update(stableJson(unsigned)).digest("hex");
}

function normalizeJobInput({ ownerId, projectId, prompt, durationSeconds, aspectRatio = "16:9" } = {}) {
  if (typeof ownerId !== "string" || !UUID.test(ownerId)) throw fail("A verified owner identity is required.", "RUNWAY_WORKFLOW_AUTH_REQUIRED");
  if (typeof projectId !== "string" || !UUID.test(projectId)) throw fail("A valid project is required.", "RUNWAY_WORKFLOW_PROJECT_REQUIRED");
  if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > 1000) throw fail("Runway Gen-4.5 prompts must contain 1 to 1,000 characters.", "RUNWAY_WORKFLOW_INPUT_INVALID");
  if (![5, 10].includes(durationSeconds)) throw fail("The current Gen-4.5 worker supports 5- or 10-second clips.", "RUNWAY_WORKFLOW_INPUT_INVALID");
  if (!["16:9", "9:16", "1:1"].includes(aspectRatio)) throw fail("The current Gen-4.5 worker supports 16:9, 9:16 or 1:1 aspect ratios.", "RUNWAY_WORKFLOW_INPUT_INVALID");
  const input = {
    projectId,
    provider: "runway",
    model: "gen4.5",
    prompt: prompt.trim(),
    durationSeconds,
    aspectRatio,
    outputFormat: "mp4"
  };
  return Object.freeze({ ...input, requestHash: requestFingerprint(input) });
}

/**
 * Server-side Runway workflow coordinator.
 *
 * It joins a non-billable router dry-run, a durable PostgreSQL approval,
 * authenticated human approval, and the existing atomic enqueue RPC.
 * The caller must supply an authorization function backed by verified
 * project membership. It never submits a provider task itself.
 */
export function createRunwayRouterWorkflow({
  dryRun,
  approvals,
  enqueue,
  authorizeProject = async () => false
} = {}) {
  if (!dryRun || typeof dryRun.preflight !== "function") throw new Error("Runway workflow requires a dry-run client.");
  if (!approvals || typeof approvals.recordPreflight !== "function" || typeof approvals.approve !== "function") {
    throw new Error("Runway workflow requires the PostgreSQL approval client.");
  }
  if (!enqueue || typeof enqueue.enqueue !== "function") throw new Error("Runway workflow requires the durable cloud video enqueue client.");
  if (typeof authorizeProject !== "function") throw new Error("Runway workflow requires a project authorization function.");

  return Object.freeze({
    async preflight({
      ownerId, projectId, configId, prompt, durationSeconds, aspectRatio = "16:9",
      maxEstimatedCredits, approvedMaxAmount, currency = "USD", ttlSeconds = 900
    } = {}) {
      if (typeof configId !== "string" || !CONFIG.test(configId)) throw fail("A saved Runway router configuration is required.", "RUNWAY_ROUTER_CONFIG_INVALID");
      if (await authorizeProject({ ownerId, projectId, action: "write" }) !== true) {
        throw fail("Project editor authorization is required before Runway preflight.", "RUNWAY_WORKFLOW_PROJECT_FORBIDDEN");
      }
      if (!Number.isSafeInteger(maxEstimatedCredits) || maxEstimatedCredits < 0) {
        throw fail("An explicit maximum Runway credit ceiling is required.", "RUNWAY_WORKFLOW_BUDGET_INVALID");
      }
      if (typeof approvedMaxAmount !== "number" || !Number.isFinite(approvedMaxAmount) || approvedMaxAmount <= 0 ||
          approvedMaxAmount > 100000000 || currency !== "USD") {
        throw fail("A positive bounded USD approval ceiling is required.", "RUNWAY_WORKFLOW_BUDGET_INVALID");
      }
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 900) {
        throw fail("Approval expiry must be between 60 and 900 seconds.", "RUNWAY_WORKFLOW_TTL_INVALID");
      }

      const jobInput = normalizeJobInput({ ownerId, projectId, prompt, durationSeconds, aspectRatio });
      const decision = await dryRun.preflight({
        configId, prompt: jobInput.prompt, durationSeconds: jobInput.durationSeconds,
        aspectRatio: jobInput.aspectRatio
      }, { maxEstimatedCredits });
      if (decision?.dryRun !== true || decision.taskCreated !== false || decision.billed !== false ||
          decision.provider !== "runway" || decision.model !== "gen4.5" ||
          decision.configId !== configId || decision.budgetCheck !== "within_limit" ||
          decision.maxEstimatedCredits !== maxEstimatedCredits ||
          !/^[a-f0-9]{64}$/.test(decision.inputHash || "")) {
        throw fail("The router decision does not match the approved Runway Gen-4.5 workflow.", "RUNWAY_WORKFLOW_DECISION_INVALID");
      }

      const recorded = await approvals.recordPreflight({
        ownerId, projectId, decision, requestHash: jobInput.requestHash, jobInput,
        approvedMaxAmount, currency, ttlSeconds, maxEstimatedCredits
      });
      return Object.freeze({
        status: "pending_approval",
        provider: "runway",
        model: "gen4.5",
        routerApprovalId: recorded.routerApprovalId,
        budgetApprovalId: recorded.budgetApprovalId,
        expiresAt: recorded.expiresAt,
        requestHash: jobInput.requestHash,
        routerInputHash: decision.inputHash,
        routerConfigId: configId,
        estimatedCredits: decision.estimatedCredits,
        maxEstimatedCredits,
        approvedMaxAmount,
        currency,
        jobInput
      });
    },

    async getJobStatus({ ownerId, jobId } = {}) {
      if (typeof ownerId !== "string" || !UUID.test(ownerId)) {
        throw fail("A verified owner identity is required.", "RUNWAY_WORKFLOW_AUTH_REQUIRED");
      }
      if (typeof jobId !== "string" || !UUID.test(jobId)) {
        throw fail("A valid video job ID is required.", "RUNWAY_WORKFLOW_JOB_INVALID");
      }
      if (typeof enqueue.getJobStatus !== "function") {
        throw fail("Durable Runway job status is not configured.", "RUNWAY_WORKFLOW_STATUS_UNAVAILABLE");
      }
      return enqueue.getJobStatus({ ownerId, jobId });
    },

    async approve({ routerApprovalId, accessToken } = {}) {
      if (typeof routerApprovalId !== "string" || !UUID.test(routerApprovalId)) {
        throw fail("A valid Runway router approval ID is required.", "RUNWAY_APPROVAL_ARGUMENT_INVALID");
      }
      await approvals.approve({ approvalId: routerApprovalId, accessToken });
      return Object.freeze({ approvalId: routerApprovalId, status: "approved" });
    },

    async enqueueApproved({
      ownerId, projectId, idempotencyKey, receipt, jobInput, reservedAmount, currency = "USD"
    } = {}) {
      if (!plain(receipt) || typeof receipt.routerApprovalId !== "string" ||
          typeof receipt.budgetApprovalId !== "string" || typeof receipt.routerInputHash !== "string" ||
          typeof receipt.routerConfigId !== "string" || typeof receipt.requestHash !== "string") {
        throw fail("A complete PostgreSQL preflight receipt is required.", "RUNWAY_APPROVAL_REQUIRED");
      }
      if (!plain(jobInput) || jobInput.provider !== "runway" || jobInput.model !== "gen4.5" ||
          jobInput.requestHash !== receipt.requestHash || jobInput.projectId !== projectId ||
          requestFingerprint(jobInput) !== receipt.requestHash) {
        throw fail("The enqueue payload differs from the preflighted generation request.", "RUNWAY_APPROVAL_PAYLOAD_MISMATCH");
      }
      if (await authorizeProject({ ownerId, projectId, action: "write" }) !== true) {
        throw fail("Project editor authorization is required to enqueue generation.", "RUNWAY_WORKFLOW_PROJECT_FORBIDDEN");
      }
      const result = await enqueue.enqueue({
        ownerId, projectId, idempotencyKey, provider: "runway", model: "gen4.5",
        requestHash: receipt.requestHash, input: jobInput,
        budgetApprovalId: receipt.budgetApprovalId, reservedAmount, currency,
        routerApprovalId: receipt.routerApprovalId,
        routerInputHash: receipt.routerInputHash,
        routerConfigId: receipt.routerConfigId
      });
      return Object.freeze({ ...result, provider: "runway", model: "gen4.5" });
    }
  });
}
