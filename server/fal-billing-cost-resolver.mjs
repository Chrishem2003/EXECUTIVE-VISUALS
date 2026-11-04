const API_ORIGIN = "https://api.fal.ai";
const fail = (message, code) => Object.assign(new Error(message), { code });

/**
 * Resolve a single FAL request against the provider's billed-event ledger.
 * This deliberately does not estimate cost from model list prices or output
 * duration. Missing or ambiguous billing evidence fails closed.
 */
export function createFalBillingCostResolver({
  apiKey = process.env.FAL_BILLING_KEY || process.env.FAL_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000
} = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw fail("FAL billing reconciliation requires a server-side API key.", "VIDEO_BILLING_CONFIG_INVALID");
  if (typeof fetchImpl !== "function") throw new Error("FAL billing resolver requires fetch.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error("FAL billing resolver timeout is invalid.");

  return async function resolveFalActualCost({ providerTaskId, model, submittedAt, job } = {}) {
    const requestId = String(providerTaskId || "");
    const endpointId = String(model || "");
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(requestId) ||
        !endpointId || endpointId.length > 240 ||
        !/^[a-zA-Z0-9_./:-]+$/.test(endpointId) ||
        endpointId.startsWith("/") || endpointId.includes("..") ||
        endpointId.split("/").some(part => !part || part === ".")) {
      throw fail("FAL billing lookup requires an exact request ID and model endpoint.", "VIDEO_BILLING_INPUT_INVALID");
    }

    const url = new URL("/v1/models/billing-events", API_ORIGIN);
    url.searchParams.set("request_id", requestId);
    url.searchParams.set("endpoint_id", endpointId);
    const submittedTime = submittedAt || job?.created_at || job?.createdAt;
    const lookbackStart = Date.now() - 89 * 24 * 60 * 60 * 1000;
    let startTime = lookbackStart;
    if (submittedTime !== undefined) {
      const parsedStart = Date.parse(submittedTime);
      if (!Number.isFinite(parsedStart)) throw fail("FAL billing lookup requires a valid submission timestamp.", "VIDEO_BILLING_INPUT_INVALID");
      if (parsedStart < lookbackStart) throw fail("FAL billing events can only be queried within the provider 90-day date-range limit.", "VIDEO_BILLING_LOOKBACK_EXCEEDED");
      if (parsedStart > Date.now()) throw fail("FAL submission timestamp cannot be in the future.", "VIDEO_BILLING_INPUT_INVALID");
      startTime = parsedStart;
    }
    url.searchParams.set("start", new Date(startTime).toISOString());
    url.searchParams.set("limit", "10");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: "Key " + key, accept: "application/json" },
          signal: controller.signal,
          redirect: "error"
        });
      } catch (error) {
        throw fail(
          error?.name === "AbortError" ? "FAL billing lookup timed out." : "FAL billing service is unavailable.",
          error?.name === "AbortError" ? "VIDEO_BILLING_TIMEOUT" : "VIDEO_BILLING_UNAVAILABLE"
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw fail("FAL billing access is not authorized for this server key.", "VIDEO_BILLING_ACCESS_DENIED");
      }
      if (response.status === 429) throw fail("FAL billing API rate limit reached.", "VIDEO_BILLING_RATE_LIMITED");
      if (!response.ok) throw fail("FAL billing lookup failed (HTTP " + response.status + ").", "VIDEO_BILLING_LOOKUP_FAILED");
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1024 * 1024) throw fail("FAL billing response is oversized.", "VIDEO_BILLING_INVALID_RESPONSE");
      let data;
      try { data = JSON.parse(raw); }
      catch { throw fail("FAL billing API returned invalid JSON.", "VIDEO_BILLING_INVALID_RESPONSE"); }
      if (!data || !Array.isArray(data.billing_events)) {
        throw fail("FAL billing API returned an invalid billing-event collection.", "VIDEO_BILLING_INVALID_RESPONSE");
      }
      const matches = data.billing_events.filter(event =>
        event?.request_id === requestId && event?.endpoint_id === endpointId
      );
      if (matches.length === 0) {
        throw fail("No billed event is available for this FAL request yet; keep the reservation for reconciliation.", "VIDEO_BILLING_EVENT_NOT_READY");
      }
      if (matches.length !== 1) {
        throw fail("FAL returned multiple billing events for one request; manual reconciliation is required.", "VIDEO_BILLING_EVENT_AMBIGUOUS");
      }
      const event = matches[0];
      const nanoUsd = event.cost_estimate_nano_usd;
      const costTotal = event.cost_total;
      if (!Number.isSafeInteger(nanoUsd) || nanoUsd < 0 ||
          typeof costTotal !== "number" || !Number.isFinite(costTotal) || costTotal < 0 ||
          !Number.isFinite(nanoUsd / 1_000_000_000) ||
          Math.abs(nanoUsd / 1_000_000_000 - costTotal) > 0.0000001 ||
          typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp))) {
        throw fail("FAL billing event cost evidence is malformed or inconsistent.", "VIDEO_BILLING_INVALID_RESPONSE");
      }
      return Object.freeze({
        amount: nanoUsd / 1_000_000_000,
        currency: "USD",
        evidenceReference: "fal-billing-event:" + requestId + ":" + event.timestamp,
        quantity: typeof event.quantity === "number" && Number.isFinite(event.quantity) ? event.quantity : null,
        unit: typeof event.unit === "string" ? event.unit : null,
        unitPrice: typeof event.unit_price === "number" && Number.isFinite(event.unit_price) ? event.unit_price : null,
        discountPercent: typeof event.percent_discount === "number" ? event.percent_discount : null
      });
    } finally {
      clearTimeout(timer);
    }
  };
}
