const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const STORAGE_READ_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
const fail = (message, code) => Object.assign(new Error(message), { code });

function safeProjectId(value) {
  const projectId = String(value || "").trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw fail("Configure a valid Google Cloud project ID.", "GEMINI_GCS_CONFIG_MISSING");
  }
  return projectId;
}

function safeProjectNumber(value) {
  const projectNumber = String(value || "").trim();
  if (!/^\d{6,20}$/.test(projectNumber)) {
    throw fail("Configure the numeric Google Cloud project number.", "GEMINI_GCS_PROJECT_NUMBER_MISSING");
  }
  return projectNumber;
}

function safeBucket(value) {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) &&
    !value.includes("..") && !value.includes(".-") && !value.includes("-.");
}

/**
 * Read-only preflight for Gemini Files GCS registration.
 * It never creates service identities or changes bucket IAM policies.
 */
export function createGoogleGeminiGcsIamVerifier({
  env = process.env,
  getAccessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000
} = {}) {
  if (typeof getAccessToken !== "function" || typeof fetchImpl !== "function") {
    throw new TypeError("Gemini GCS IAM verifier requires an OAuth token provider and fetch.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error("Gemini GCS IAM verifier timeout is invalid.");
  }
  const projectId = safeProjectId(env.GOOGLE_CLOUD_PROJECT_ID);
  const projectNumber = safeProjectNumber(env.GOOGLE_CLOUD_PROJECT_NUMBER);
  const buckets = [...new Set(String(env.GEMINI_GCS_ALLOWED_BUCKETS || "")
    .split(",").map(value => value.trim()).filter(Boolean))];
  if (!buckets.length || buckets.some(bucket => !safeBucket(bucket))) {
    throw fail("Configure an explicit valid GEMINI_GCS_ALLOWED_BUCKETS allowlist.", "GEMINI_GCS_BUCKET_ALLOWLIST_MISSING");
  }
  const serviceAgent = "service-" + projectNumber + "@gcp-sa-generativelanguage.iam.gserviceaccount.com";

  async function getJson(url, accessToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: "Bearer " + accessToken, accept: "application/json" },
          redirect: "error",
          signal: controller.signal
        });
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "Google Cloud IAM preflight timed out." : "Google Cloud IAM preflight request failed.",
          error?.name === "AbortError" ? "GEMINI_GCS_IAM_TIMEOUT" : "GEMINI_GCS_IAM_REQUEST_FAILED");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
        throw fail("Google Cloud IAM preflight response is too large.", "GEMINI_GCS_IAM_RESPONSE_INVALID");
      }
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { throw fail("Google Cloud IAM preflight returned invalid JSON.", "GEMINI_GCS_IAM_RESPONSE_INVALID"); }
      }
      if (!response.ok) {
        const error = fail("Google Cloud IAM preflight was rejected (HTTP " + response.status + ").",
          response.status === 403 ? "GEMINI_GCS_IAM_PREFLIGHT_FORBIDDEN" : "GEMINI_GCS_IAM_PREFLIGHT_FAILED");
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async check() {
      let accessToken;
      try {
        accessToken = await getAccessToken({
          projectId,
          scopes: [CLOUD_PLATFORM_SCOPE, STORAGE_READ_SCOPE]
        });
      } catch {
        throw fail("Google Cloud OAuth token acquisition failed for the IAM preflight.", "GEMINI_GCS_OAUTH_FAILED");
      }
      if (typeof accessToken !== "string" || accessToken.length < 20 ||
          accessToken.length > 8192 || /\s/.test(accessToken)) {
        throw fail("Google Cloud OAuth token provider returned an invalid token.", "GEMINI_GCS_OAUTH_FAILED");
      }

      const service = await getJson(
        "https://serviceusage.googleapis.com/v1/projects/" + projectNumber +
          "/services/generativelanguage.googleapis.com",
        accessToken
      );
      const apiEnabled = service?.state === "ENABLED";
      const bucketResults = [];
      for (const bucket of buckets) {
        const policy = await getJson(
          "https://storage.googleapis.com/storage/v1/b/" + encodeURIComponent(bucket) +
            "/iam?optionsRequestedPolicyVersion=3",
          accessToken
        );
        const bindings = Array.isArray(policy?.bindings) ? policy.bindings : [];
        const hasViewer = bindings.some(binding =>
          binding?.role === "roles/storage.objectViewer" &&
          !binding.condition &&
          Array.isArray(binding.members) &&
          binding.members.includes("serviceAccount:" + serviceAgent)
        );
        bucketResults.push(Object.freeze({ bucket, serviceAgentHasObjectViewer: hasViewer }));
      }
      const bucketsReady = bucketResults.every(item => item.serviceAgentHasObjectViewer);
      return Object.freeze({
        ready: apiEnabled && bucketsReady,
        projectId,
        apiEnabled,
        serviceAgent,
        buckets: bucketResults
      });
    }
  });
}
