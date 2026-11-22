const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USD_PER_RUNWAY_CREDIT = 0.01;
const fail = (message, code) => Object.assign(new Error(message), { code });

/**
 * Settle a Runway generation from the cost receipt on GET /v1/tasks/:id.
 * This is task-correlated provider evidence, unlike router dry-run estimates
 * or workspace-level aggregates. The resolver performs no network request:
 * the adapter supplies the cost field from the exact persisted task response.
 */
export function createRunwayTaskReceiptCostResolver() {
  const resolve = async function resolveRunwayTaskReceiptCost({
    input, task, providerTaskId
  } = {}) {
    const id = String(providerTaskId || "");
    if (!UUID.test(id) || input?.provider !== "runway" ||
        typeof input?.model !== "string" || !input.model.trim() ||
        task?.provider !== "runway" || task?.model !== input.model ||
        task?.taskId !== id || task?.status !== "succeeded") {
      throw fail("Runway settlement requires the exact succeeded task and matching provider/model identity.", "RUNWAY_TASK_RECEIPT_IDENTITY_INVALID");
    }
    const credits = task.actualCostCredits;
    if (!Number.isSafeInteger(credits) || credits < 1 || credits > 1000000000) {
      throw fail("Runway task response did not contain a valid realized cost in provider credits.", "RUNWAY_TASK_RECEIPT_COST_MISSING");
    }
    const amountMinor = credits;
    return Object.freeze({
      amount: Number((amountMinor / 100).toFixed(2)),
      currency: "USD",
      actualCredits: credits,
      creditsCharged: credits,
      model: input.model,
      evidenceReference: "runway-task-receipt:" + id + ":credits:" + credits
    });
  };
  return resolve;
}
