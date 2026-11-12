const SCHEMA = "executive_visuals";
const RPC = "settle_generation_credits_for_job";

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Customer credit ledger URL must be an absolute URL."); }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("Customer credit ledger URL must use HTTPS without embedded credentials, query or fragment.");
  }
  return url.origin;
}

export function createCloudCustomerCreditLedger({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (!url || !serviceRoleKey || typeof fetchImpl !== "function") {
    throw new Error("Customer credit ledger requires server-side Supabase credentials and fetch.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("Customer credit ledger timeout is invalid.");
  }
  const base = endpoint(url);
  return Object.freeze({
    async settleJob({ jobId, ownerId, provider, actualCredits, evidence } = {}) {
      if (typeof jobId !== "string" || !jobId.trim() ||
          typeof ownerId !== "string" || !ownerId.trim() ||
          typeof provider !== "string" || !provider.trim() || provider.length > 100 ||
          !Number.isSafeInteger(actualCredits) || actualCredits < 0 || actualCredits > 1000000000 ||
          !evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
          evidence.provider !== provider ||
          !["provider_task_receipt", "provider_invoice", "provider_usage_reconciliation"].includes(evidence.evidenceType) ||
          typeof evidence.evidenceId !== "string" || !evidence.evidenceId.trim() ||
          typeof evidence.evidenceReference !== "string" || !evidence.evidenceReference.trim()) {
        throw new Error("Customer credit settlement requires a bounded job, owner, provider and authoritative usage evidence.");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(base + "/rest/v1/rpc/" + RPC, {
          method: "POST",
          headers: {
            apikey: serviceRoleKey,
            authorization: "Bearer " + serviceRoleKey,
            "content-type": "application/json",
            "accept-profile": SCHEMA,
            "content-profile": SCHEMA,
            accept: "application/json"
          },
          body: JSON.stringify({
            p_job_id: jobId, p_owner_id: ownerId, p_provider: provider,
            p_actual_credits: actualCredits, p_evidence: evidence
          }),
          signal: controller.signal
        });
        const body = await response.text();
        let rows = null;
        if (body) {
          try { rows = JSON.parse(body); }
          catch { throw new Error("Customer credit ledger returned an invalid response."); }
        }
        if (!response.ok) {
          const error = new Error(typeof rows?.message === "string"
            ? rows.message.replaceAll(serviceRoleKey, "[redacted]").slice(0, 300)
            : "Customer credit settlement failed.");
          error.code = "CLOUD_CUSTOMER_CREDIT_SETTLEMENT_FAILED";
          error.status = response.status;
          throw error;
        }
        if (!Array.isArray(rows) || rows.length !== 1 ||
            !Number.isSafeInteger(Number(rows[0].balance)) ||
            !Number.isSafeInteger(Number(rows[0].adjustment)) ||
            typeof rows[0].replayed !== "boolean") {
          throw new Error("Customer credit settlement returned an invalid receipt.");
        }
        return Object.freeze({
          balance: Number(rows[0].balance),
          adjustment: Number(rows[0].adjustment),
          replayed: rows[0].replayed
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          const timeout = new Error("Customer credit settlement timed out; retry the same evidence idempotently.");
          timeout.code = "CLOUD_CUSTOMER_CREDIT_SETTLEMENT_TIMEOUT";
          throw timeout;
        }
        throw error;
      } finally { clearTimeout(timer); }
    }
  });
}
