const C2PA_STATES = new Set(["Invalid", "Valid", "Trusted"]);

function normalizeFinding(item) {
  if (!item || typeof item !== "object") return null;
  const code = typeof item.code === "string" ? item.code.slice(0, 160) : "C2PA_VALIDATION_FINDING";
  const explanation = typeof item.explanation === "string" ? item.explanation.slice(0, 1000) : "";
  const severity = typeof item.severity === "string" ? item.severity.slice(0, 40) : "unknown";
  return { code, explanation, severity };
}

function getManifestState(store) {
  const state = store?.validation_state;
  if (C2PA_STATES.has(state)) return state;
  const statuses = Array.isArray(store?.validation_status) ? store.validation_status : [];
  if (statuses.some(item => String(item?.code || "").toLowerCase().includes("error"))) return "Invalid";
  return null;
}

/**
 * Inspect an asset using the official Content Authenticity Initiative Node SDK.
 * The caller must authorize access and supply a server-controlled absolute path.
 * No trust state is inferred: only the SDK's explicit ValidationState is used.
 */
export async function inspectC2paAsset({ path, mimeType, sdkLoader = () => import("@contentauth/c2pa-node") }) {
  if (typeof path !== "string" || !path.trim()) throw new TypeError("A server-controlled asset path is required.");
  if (typeof mimeType !== "string" || !mimeType.includes("/")) throw new TypeError("A valid asset MIME type is required.");

  let sdk;
  try {
    sdk = await sdkLoader();
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find package/.test(String(error?.message || ""))) {
      return {
        status: "not_available",
        configured: false,
        validationState: null,
        embedded: false,
        activeManifest: null,
        findings: [{ code: "C2PA_SDK_NOT_INSTALLED", explanation: "Install the official @contentauth/c2pa-node package to enable C2PA inspection.", severity: "info" }]
      };
    }
    throw error;
  }

  if (!sdk?.Reader?.fromAsset || typeof sdk.Context !== "function") {
    return {
      status: "not_available",
      configured: false,
      validationState: null,
      embedded: false,
      activeManifest: null,
      findings: [{ code: "C2PA_SDK_API_UNAVAILABLE", explanation: "The installed CAI SDK does not expose the required Reader and Context APIs.", severity: "error" }]
    };
  }

  const context = new sdk.Context({
    verify: {
      verifyAfterReading: true,
      verifyTrust: true,
      verifyTimestampTrust: true,
      remoteManifestFetch: false
    }
  });
  const reader = await sdk.Reader.fromAsset({ path, mimeType }, context);
  const store = reader.json();
  const activeLabel = store?.active_manifest || null;
  const activeManifest = activeLabel && store?.manifests ? store.manifests[activeLabel] || null : null;
  const validationState = getManifestState(store);
  const validationItems = Array.isArray(store?.validation_status) ? store.validation_status : [];
  const findings = validationItems.map(normalizeFinding).filter(Boolean);

  if (!reader.isEmbedded() && !activeManifest) {
    return {
      status: "not_found",
      configured: true,
      validationState: null,
      embedded: false,
      activeManifest: null,
      findings: [{ code: "C2PA_MANIFEST_NOT_FOUND", explanation: "No embedded C2PA manifest was found in this asset.", severity: "info" }]
    };
  }
  if (!activeManifest || !validationState) {
    return {
      status: "indeterminate",
      configured: true,
      validationState,
      embedded: Boolean(reader.isEmbedded()),
      activeManifest: activeLabel,
      findings: [...findings, { code: "C2PA_VALIDATION_INCOMPLETE", explanation: "The SDK did not provide a complete active manifest and validation state. No validity or trust is inferred.", severity: "warning" }]
    };
  }

  return {
    status: validationState === "Invalid" ? "invalid" : validationState === "Trusted" ? "trusted" : "valid",
    configured: true,
    validationState,
    embedded: Boolean(reader.isEmbedded()),
    activeManifest: activeLabel,
    manifestCount: Object.keys(store?.manifests || {}).length,
    findings
  };
}
