const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, code) => Object.assign(new Error(message), { code });

/**
 * Resolve the exact Runway task receipt. This returns provider cost only;
 * the shared job executor converts verified USD cost into customer credits
 * using the same margin/fee policy that produced the preflight quote.
 */
export function createRunwayTaskReceiptCostResolver() {
  return async function resolveRunwayTaskReceiptCost({ input, task, providerTaskId } = {}) {
    const id = String(providerTaskId || "");
    if (!UUID.test(id) || input?.provider !== "runway" ||
        typeof input?.model !== "string" || !input.model.trim() ||
        task?.provider !== "runway" || task?.model !== input.model ||
        task?.taskId !== id || task?.status !== "succeeded") {
      throw fail("Runway settlement requires the exact succeeded task and matching provider/model identity.", "RUNWAY_TASK_RECEIPT_IDENTITY_INVALID");
    }
    const providerCredits = task.actualCostCredits;
    if (!Number.isSafeInteger(providerCredits) || providerCredits < 1 || providerCredits > 1000000000) {
      throw fail("Runway task response did not contain a valid realized cost in provider credits.", "RUNWAY_TASK_RECEIPT_COST_MISSING");
    }
    const amountMicros = providerCredits * 10000;
    if (!Number.isSafeInteger(amountMicros) || amountMicros < 1) {
      throw fail("Runway provider credits exceed safe USD micro-unit bounds.", "RUNWAY_TASK_RECEIPT_COST_INVALID");
    }
    return Object.freeze({
      amount: Number((providerCredits / 100).toFixed(2)),
      currency: "USD",
      providerCredits,
      model: input.model,
      evidenceReference: "runway-task-receipt:" + id + ":provider-credits:" + providerCredits
    });
  };
}
