const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, code) => Object.assign(new Error(message), { code });

/**
 * Settle a Runway generation from cost.credits on GET /v1/tasks/:id.
 * Provider credits are converted to USD first, then priced into Executive
 * Visuals customer credits with the same margin/fee policy as the preflight
 * quote. The provider's credit denomination is never reused as customer units.
 */
export function createRunwayTaskReceiptCostResolver({ quoteCustomerCredits } = {}) {
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
    const providerCredits = task.actualCostCredits;
    if (!Number.isSafeInteger(providerCredits) || providerCredits < 1 || providerCredits > 1000000000) {
      throw fail("Runway task response did not contain a valid realized cost in provider credits.", "RUNWAY_TASK_RECEIPT_COST_MISSING");
    }
    if (typeof quoteCustomerCredits !== "function") {
      throw fail("Verified provider cost cannot be settled without the configured customer-credit pricing policy.", "VIDEO_CUSTOMER_CREDIT_POLICY_UNCONFIGURED");
    }
    // Runway Dev documents one provider credit as USD $0.01. Convert directly
    // to integer USD micro-units before applying the shared cost-plus policy.
    const amountMicros = providerCredits * 10000;
    if (!Number.isSafeInteger(amountMicros) || amountMicros < 1) {
      throw fail("Runway provider credits exceed safe USD micro-unit bounds.", "RUNWAY_TASK_RECEIPT_COST_INVALID");
    }
    let customerCredits;
    try {
      customerCredits = quoteCustomerCredits({ currency: "USD", amountMicros });
    } catch {
      throw fail("Verified provider cost could not be converted using the approved customer-credit pricing policy.", "VIDEO_CUSTOMER_CREDIT_SETTLEMENT_UNRESOLVED");
    }
    if (!Number.isSafeInteger(customerCredits) || customerCredits < 1 || customerCredits > 100000000) {
      throw fail("Customer-credit settlement amount is outside approved bounds.", "VIDEO_CUSTOMER_CREDIT_SETTLEMENT_UNRESOLVED");
    }
    return Object.freeze({
      amount: Number((providerCredits / 100).toFixed(2)),
      currency: "USD",
      actualCredits: customerCredits,
      customerCredits,
      providerCredits,
      model: input.model,
      evidenceReference: "runway-task-receipt:" + id + ":provider-credits:" + providerCredits
    });
  };
  return resolve;
}
