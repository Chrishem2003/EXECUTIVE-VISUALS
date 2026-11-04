const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, code) => Object.assign(new Error(message), { code });

/**
 * Convert Luma's per-generation settled credit charge to USD using an
 * explicitly configured account/contract rate. Never substitute list pricing.
 */
export function createLumaActualCostResolver({ usdPerCredit } = {}) {
  const rateText = String(usdPerCredit ?? "").trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(rateText) || Number(rateText) <= 0) {
    throw fail("LUMA_USD_PER_CREDIT must be an explicit positive account/contract rate.", "LUMA_BILLING_RATE_REQUIRED");
  }
  const rate = Number(rateText);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) {
    throw fail("Luma USD-per-credit rate is outside the supported range.", "LUMA_BILLING_RATE_INVALID");
  }

  return async function resolveLumaActualCost({ providerTaskId, task, model } = {}) {
    if (model !== "ray-3.2" || typeof providerTaskId !== "string" || !UUID.test(providerTaskId) ||
        task?.taskId !== providerTaskId || task?.providerGenerationId !== providerTaskId) {
      throw fail("Luma settlement lookup requires the exact persisted generation UUID and model.", "LUMA_BILLING_INPUT_INVALID");
    }
    const usage = task.usage;
    if (!usage || !Number.isSafeInteger(usage.credits_charged) || usage.credits_charged < 0) {
      throw fail("Luma generation billing has not settled or usage reporting is unavailable; keep the budget reservation unresolved.", "LUMA_BILLING_NOT_SETTLED");
    }
    const amount = Number((usage.credits_charged * rate).toFixed(9));
    if (!Number.isFinite(amount) || amount < 0) {
      throw fail("Luma settled usage could not be converted using the configured account rate.", "LUMA_BILLING_AMOUNT_INVALID");
    }
    return Object.freeze({
      amount,
      currency: "USD",
      evidenceReference: "luma-generation-usage:" + providerTaskId + ":" + usage.credits_charged + "credits@" + rateText + "USD",
      creditsCharged: usage.credits_charged,
      usdPerCredit: rateText
    });
  };
}
