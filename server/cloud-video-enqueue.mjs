const SCHEMA = "executive_visuals";
const RPC = Object.freeze({
  enqueue: "enqueue_video_generation_job",
  settle: "settle_video_generation_budget_reservation"
});

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Cloud video enqueue URL must be a valid absolute URL."); }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("Cloud video enqueue URL must use HTTPS and must not contain credentials, query parameters or fragments.");
  }
  return url.origin;
}

export function createCloudVideoEnqueue({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (!url || !serviceRoleKey) throw new Error("Cloud video enqueue requires server-side SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  if (typeof fetchImpl !== "function") throw new Error("Cloud video enqueue requires a fetch implementation.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Cloud video enqueue timeout must be between 1000 and 120000 milliseconds.");
  const base = endpoint(url);

  async function call(name, args) {
    if (!Object.values(RPC).includes(name)) throw new Error("Unsupported cloud video enqueue operation.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + "/rest/v1/rpc/" + name, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: "Bearer " + serviceRoleKey,
          "content-type": "application/json",
          "accept-profile": SCHEMA,
          "content-profile": SCHEMA,
          accept: "application/json"
        },
        body: JSON.stringify(args),
        signal: controller.signal
      });
      const body = await response.text();
      let parsed = null;
      if (body) {
        try { parsed = JSON.parse(body); }
        catch { throw new Error("Cloud video enqueue returned a non-JSON response (HTTP " + response.status + ")."); }
      }
      if (!response.ok) {
        const message = typeof parsed?.message === "string" ? parsed.message.replaceAll(serviceRoleKey, "[redacted]").slice(0, 300) : "Cloud video enqueue request failed.";
        const error = new Error(message);
        error.code = "CLOUD_VIDEO_ENQUEUE_HTTP_" + response.status;
        error.status = response.status;
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("Cloud video enqueue request timed out.");
        timeout.code = "CLOUD_VIDEO_ENQUEUE_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  function required(value, name, max = 256) {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(name + " is required and must be bounded.");
    return value;
  }

  return Object.freeze({
    async enqueue({
      ownerId, projectId = null, idempotencyKey, provider, model, requestHash,
      input, budgetApprovalId, reservedAmount, currency
    } = {}) {
      required(ownerId, "Owner ID");
      if (projectId !== null) required(projectId, "Project ID");
      required(idempotencyKey, "Idempotency key", 180);
      required(provider, "Provider", 100);
      required(model, "Model", 160);
      required(budgetApprovalId, "Budget approval ID");
      if (!/^[A-Za-z0-9._:-]{1,180}$/.test(idempotencyKey)) throw new Error("Idempotency key has an invalid format.");
      if (typeof requestHash !== "string" || !/^[a-f0-9]{64}$/.test(requestHash)) throw new Error("Request hash must be a lowercase SHA-256 digest.");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Video generation input must be an object.");
      if (input.provider !== provider || input.model !== model || input.requestHash !== requestHash ||
          (input.projectId || null) !== projectId) throw new Error("Video generation input does not match its enqueue scope.");
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 32000) throw new Error("Video generation input exceeds the 32000-byte limit.");
      if (typeof reservedAmount !== "number" || !Number.isFinite(reservedAmount) || reservedAmount <= 0 || reservedAmount > 100000000) {
        throw new Error("Reserved amount must be a positive bounded number.");
      }
      if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter uppercase code.");
      const rows = await call(RPC.enqueue, {
        p_owner_id: ownerId, p_project_id: projectId, p_idempotency_key: idempotencyKey,
        p_provider: provider, p_model: model, p_request_hash: requestHash, p_input: input,
        p_budget_approval_id: budgetApprovalId, p_reserved_amount: reservedAmount, p_currency: currency
      });
      if (!Array.isArray(rows) || rows.length !== 1 ||
          typeof rows[0]?.job_id !== "string" || rows[0]?.job_status !== "queued" ||
          typeof rows[0]?.idempotent_replay !== "boolean" ||
          typeof rows[0]?.budget_reservation_id !== "string") {
        throw new Error("Cloud video enqueue returned an invalid job/reservation result.");
      }
      return Object.freeze({
        jobId: rows[0].job_id,
        status: rows[0].job_status,
        idempotentReplay: rows[0].idempotent_replay,
        budgetReservationId: rows[0].budget_reservation_id
      });
    },
    async settle({ jobId, workerId, actualAmount = null } = {}) {
      required(jobId, "Job ID");
      required(workerId, "Worker ID", 128);
      if (actualAmount !== null && (typeof actualAmount !== "number" || !Number.isFinite(actualAmount) || actualAmount < 0 || actualAmount > 100000000)) {
        throw new Error("Actual amount must be null or a non-negative bounded number.");
      }
      const result = await call(RPC.settle, {
        p_job_id: jobId, p_worker_id: workerId, p_actual_amount: actualAmount
      });
      if (typeof result !== "boolean") throw new Error("Cloud video budget settlement returned an invalid result.");
      return result;
    }
  });
}
