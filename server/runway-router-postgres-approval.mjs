const SCHEMA = "executive_visuals";
const fail = (message, code) => Object.assign(new Error(message), { code });

function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Runway approval URL must be absolute."); }
  const local = ["localhost","127.0.0.1","::1","[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("Runway approval URL must use HTTPS without embedded credentials, query or fragment.");
  }
  return url.origin;
}

/**
 * PostgreSQL bridge for the Runway dry-run approval lifecycle.
 * Recording uses a server-only service key. Human approval uses the
 * approver's short-lived user access token and the public anon key.
 */
export function createRunwayRouterPostgresApprovalClient({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  anonKey = process.env.SUPABASE_ANON_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000
} = {}) {
  if (!url || !serviceRoleKey || !anonKey) throw new Error("Runway approval bridge requires Supabase URL, service-role key and anon key.");
  if (typeof fetchImpl !== "function") throw new Error("Runway approval bridge requires fetch.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error("Runway approval timeout is invalid.");
  const base = origin(url);

  async function rpc(name, args, { apiKey, bearer } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + "/rest/v1/rpc/" + name, {
        method: "POST",
        headers: {
          apikey: apiKey,
          authorization: "Bearer " + bearer,
          "content-type": "application/json",
          "accept-profile": SCHEMA,
          "content-profile": SCHEMA,
          accept: "application/json"
        },
        body: JSON.stringify(args),
        signal: controller.signal,
        redirect: "error"
      });
      const raw = await response.text();
      let body = null;
      if (raw) {
        try { body = JSON.parse(raw); }
        catch { throw fail("Runway approval service returned invalid JSON.", "RUNWAY_APPROVAL_RESPONSE_INVALID"); }
      }
      if (!response.ok) {
        const error = fail(
          typeof body?.message === "string" ? body.message.replaceAll(serviceRoleKey,"[redacted]").slice(0,300) : "Runway approval request failed.",
          "RUNWAY_APPROVAL_HTTP_" + response.status
        );
        error.status = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      if (error?.name === "AbortError") throw fail("Runway approval request timed out.", "RUNWAY_APPROVAL_TIMEOUT");
      throw error;
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    async recordPreflight({
      ownerId, projectId = null, decision, requestHash, jobInput,
      approvedMaxAmount, currency = "USD", ttlSeconds = 900,
      maxEstimatedCredits
    } = {}) {
      if (typeof ownerId !== "string" || !ownerId.trim()) throw fail("Owner ID is required.", "RUNWAY_PREFLIGHT_ARGUMENTS_INVALID");
      if (projectId !== null && (typeof projectId !== "string" || !projectId.trim())) throw fail("Project ID is invalid.", "RUNWAY_PREFLIGHT_ARGUMENTS_INVALID");
      if (!decision || decision.dryRun !== true || decision.taskCreated !== false || decision.billed !== false ||
          decision.provider !== "runway" || decision.model !== "gen4.5" ||
          typeof decision.configId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(decision.configId) ||
          typeof decision.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(decision.inputHash) ||
          !Number.isSafeInteger(decision.estimatedCredits) || decision.estimatedCredits < 0) {
        throw fail("Only a verified non-billable Gen-4.5 router preflight can be recorded.", "RUNWAY_PREFLIGHT_DECISION_INVALID");
      }
      if (!jobInput || typeof jobInput !== "object" || Array.isArray(jobInput) ||
          jobInput.provider !== "runway" || jobInput.model !== "gen4.5" ||
          jobInput.requestHash !== requestHash || (jobInput.projectId || null) !== projectId ||
          Buffer.byteLength(JSON.stringify(jobInput), "utf8") > 32000 ||
          typeof requestHash !== "string" || !/^[a-f0-9]{64}$/.test(requestHash) ||
          !Number.isSafeInteger(maxEstimatedCredits) || maxEstimatedCredits < decision.estimatedCredits ||
          decision.budgetCheck !== "within_limit" ||
          decision.maxEstimatedCredits !== maxEstimatedCredits) {
        throw fail("The preflight fingerprint and explicit credit ceiling must match.", "RUNWAY_PREFLIGHT_BUDGET_INVALID");
      }
      if (typeof approvedMaxAmount !== "number" || !Number.isFinite(approvedMaxAmount) || approvedMaxAmount <= 0 ||
          currency !== "USD" || !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 900) {
        throw fail("The monetary reservation and expiry bounds are invalid.", "RUNWAY_PREFLIGHT_BUDGET_INVALID");
      }
      const result = await rpc("record_runway_router_preflight", {
        p_owner_id: ownerId,
        p_project_id: projectId,
        p_config_id: decision.configId,
        p_input_hash: decision.inputHash,
        p_request_hash: requestHash,
        p_job_input: jobInput,
        p_estimated_credits: decision.estimatedCredits,
        p_max_estimated_credits: maxEstimatedCredits,
        p_approved_max_amount: approvedMaxAmount,
        p_currency: currency,
        p_ttl_seconds: ttlSeconds
      }, { apiKey: serviceRoleKey, bearer: serviceRoleKey });
      if (!Array.isArray(result) || result.length !== 1 ||
          typeof result[0]?.router_approval_id !== "string" ||
          typeof result[0]?.budget_approval_id !== "string" ||
          typeof result[0]?.expires_at !== "string") {
        throw fail("Runway approval service returned an invalid record.", "RUNWAY_APPROVAL_RESPONSE_INVALID");
      }
      return Object.freeze({
        routerApprovalId: result[0].router_approval_id,
        budgetApprovalId: result[0].budget_approval_id,
        expiresAt: result[0].expires_at,
        inputHash: decision.inputHash,
        configId: decision.configId
      });
    },

    async approve({ approvalId, accessToken } = {}) {
      if (typeof approvalId !== "string" || !/^[0-9a-f-]{36}$/i.test(approvalId)) throw fail("Approval ID is invalid.", "RUNWAY_APPROVAL_ARGUMENT_INVALID");
      if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 8192) throw fail("A current approver access token is required.", "RUNWAY_APPROVAL_AUTH_REQUIRED");
      const result = await rpc("approve_runway_router_preflight", { p_approval_id: approvalId }, {
        apiKey: anonKey, bearer: accessToken
      });
      if (result !== true) throw fail("Runway approval was not confirmed by PostgreSQL.", "RUNWAY_APPROVAL_RESPONSE_INVALID");
      return true;
    }
  });
}
