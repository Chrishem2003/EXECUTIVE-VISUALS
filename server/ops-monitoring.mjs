const HEALTH_RESPONSE_LIMIT = 64 * 1024;
const WEBHOOK_RESPONSE_LIMIT = 4 * 1024;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function safeHttpsEndpoint(value, label) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw fail("MONITORING_ENDPOINT_INVALID", label + " must be a valid absolute HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw fail("MONITORING_ENDPOINT_INVALID", label + " must use HTTPS without embedded credentials, query parameters or fragments.");
  }
  return url;
}

async function readBoundedText(response, maxBytes, label) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw fail("MONITORING_RESPONSE_TOO_LARGE", label + " response exceeded its size limit.");
  }
  if (!response.body?.getReader) {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) throw fail("MONITORING_RESPONSE_TOO_LARGE", label + " response exceeded its size limit.");
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw fail("MONITORING_RESPONSE_TOO_LARGE", label + " response exceeded its size limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function runExecutiveVisualsMonitoring({
  healthUrl = process.env.EXECUTIVE_VISUALS_HEALTH_URL,
  webhookUrl = process.env.OPS_ALERT_WEBHOOK_URL,
  testAlert = false,
  fetchImpl = globalThis.fetch,
  now = () => new Date()
} = {}) {
  if (typeof fetchImpl !== "function") throw fail("MONITORING_FETCH_REQUIRED", "Monitoring requires fetch.");
  const webhook = safeHttpsEndpoint(webhookUrl, "OPS_ALERT_WEBHOOK_URL");
  const health = testAlert ? null : safeHttpsEndpoint(healthUrl, "EXECUTIVE_VISUALS_HEALTH_URL");

  async function notify(payload) {
    const response = await fetchImpl(webhook.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
    await readBoundedText(response, WEBHOOK_RESPONSE_LIMIT, "Operations alert webhook");
    if (!response.ok) throw fail("MONITORING_ALERT_DELIVERY_FAILED", "Operations alert webhook rejected delivery with HTTP " + response.status + ".");
    return response.status;
  }

  if (testAlert) {
    const status = await notify({
      text: "Executive Visuals monitoring test: alert delivery is configured.",
      source: "executive-visuals",
      event: "monitoring.test",
      severity: "info",
      timestamp: now().toISOString()
    });
    return { result: "alert_delivery_confirmed", httpStatus: status, event: "monitoring.test" };
  }

  let failure = null;
  try {
    const response = await fetchImpl(health.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      redirect: "error"
    });
    const raw = await readBoundedText(response, HEALTH_RESPONSE_LIMIT, "Application health");
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    const statusValue = String(data?.status || data?.health?.status || "").toLowerCase().slice(0, 40);
    const failedChecks = Array.isArray(data?.checks)
      ? data.checks.filter(item => ["failed", "error", "unhealthy", "blocked"].includes(String(item?.status || "").toLowerCase()))
        .map(item => String(item.name || item.key || "unknown").slice(0, 80)).slice(0, 20)
      : [];
    if (!response.ok || data?.ok === false || ["error", "unhealthy", "failed", "down"].includes(statusValue) || failedChecks.length) {
      failure = { httpStatus: response.status, reportedStatus: statusValue || "unspecified", failedChecks };
    } else if (!data) {
      failure = { httpStatus: response.status, reportedStatus: "invalid_json", failedChecks: [] };
    }
  } catch (error) {
    failure = {
      httpStatus: null,
      reportedStatus: "probe_failed",
      failedChecks: [],
      errorCode: String(error?.code || error?.name || "NETWORK_ERROR").slice(0, 80)
    };
  }

  if (failure) {
    const status = await notify({
      text: "Executive Visuals health check failed: " + health.host,
      source: "executive-visuals",
      event: "health.check.failed",
      severity: "critical",
      timestamp: now().toISOString(),
      details: failure
    });
    return { result: "health_failure_alerted", webhookStatus: status, host: health.host, ...failure, exitCode: 1 };
  }

  return { result: "healthy", checkedAt: now().toISOString(), host: health.host, exitCode: 0 };
}
