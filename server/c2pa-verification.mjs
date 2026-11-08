const C2PA_STATES = new Set(["Invalid", "Valid", "Trusted"]);

function normalizeFinding(item) {
  if (!item || typeof item !== "object") return null;
  const finding = {
    code: typeof item.code === "string" ? item.code.slice(0, 160) : "C2PA_VALIDATION_FINDING",
    explanation: typeof item.explanation === "string" ? item.explanation.slice(0, 1000) : ""
  };
  if (typeof item.success === "boolean") finding.success = item.success;
  if (typeof item.url === "string") finding.url = item.url.slice(0, 500);
  return finding;
}

function collectFindings(store) {
  const legacy = Array.isArray(store?.validation_status) ? store.validation_status : [];
  const results = store?.validation_results?.activeManifest;
  const modern = results && typeof results === "object"
    ? ["failure", "informational", "success"].flatMap(group => Array.isArray(results[group]) ? results[group] : [])
    : [];
  const unique = new Map();
  for (const item of [...legacy, ...modern]) {
    const finding = normalizeFinding(item);
    if (finding) unique.set(finding.code + "\\0" + finding.explanation, finding);
  }
  return [...unique.values()];
}

function getManifestState(store) {
  const state = store?.validation_state;
  return C2PA_STATES.has(state) ? state : null;
}

function noManifestResult(configured) {
  return {
    status: configured ? "not_found" : "not_available",
    configured,
    validationState: null,
    embedded: false,
    activeManifest: null,
    manifestCount: 0,
    findings: [{
      code: configured ? "C2PA_MANIFEST_NOT_FOUND" : "C2PA_SDK_NOT_INSTALLED",
      explanation: configured ? "No C2PA manifest was found in this asset." : "Install the official @contentauth/c2pa-node package to enable C2PA inspection.",
      success: null
    }]
  };
}

/**
 * Inspect an asset using the official Content Authenticity Initiative Node SDK.
 * The caller must authorize access and supply a server-controlled absolute path.
 * Trust and validity are taken only from the SDK's explicit validation_state.
 */
export async function inspectC2paAsset({ path, mimeType, sdkLoader = () => import("@contentauth/c2pa-node") }) {
  if (typeof path !== "string" || !path.trim()) throw new TypeError("A server-controlled asset path is required.");
  if (typeof mimeType !== "string" || !mimeType.includes("/")) throw new TypeError("A valid asset MIME type is required.");

  let sdk;
  try {
    sdk = await sdkLoader();
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find package/.test(String(error?.message || ""))) {
      return noManifestResult(false);
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
      findings: [{ code: "C2PA_SDK_API_UNAVAILABLE", explanation: "The installed CAI SDK does not expose the required Reader and Context APIs.", success: null }]
    };
  }

  const context = new sdk.Context({
    verify: {
      verifyAfterReading: true,
      verifyTrust: true,
      verifyTimestampTrust: true,
      remoteManifestFetch: false
    },
    trust: {
      verifyTrustList: true
    }
  });
  const reader = await sdk.Reader.fromAsset({ path, mimeType }, context);
  // The official SDK returns null when an asset contains no C2PA manifest.
  if (!reader) return noManifestResult(true);

  const store = reader.json();
  const activeLabel = store?.active_manifest || null;
  const activeManifest = activeLabel && store?.manifests ? store.manifests[activeLabel] || null : null;
  const validationState = getManifestState(store);
  const findings = collectFindings(store);
  const embedded = Boolean(reader.isEmbedded());

  if (!activeManifest && !validationState) {
    return {
      status: "indeterminate",
      configured: true,
      validationState: null,
      embedded,
      activeManifest: activeLabel,
      manifestCount: Object.keys(store?.manifests || {}).length,
      findings: [...findings, {
        code: "C2PA_VALIDATION_INCOMPLETE",
        explanation: "The SDK did not provide a complete active manifest and validation state. No validity or trust is inferred.",
        success: null
      }]
    };
  }
  if (!activeManifest || !validationState) {
    return {
      status: "indeterminate",
      configured: true,
      validationState,
      embedded,
      activeManifest: activeLabel,
      manifestCount: Object.keys(store?.manifests || {}).length,
      findings: [...findings, {
        code: "C2PA_VALIDATION_INCOMPLETE",
        explanation: "The SDK did not provide a complete active manifest and validation state. No validity or trust is inferred.",
        success: null
      }]
    };
  }

  return {
    status: validationState === "Invalid" ? "invalid" : validationState === "Trusted" ? "trusted" : "valid",
    configured: true,
    validationState,
    embedded,
    activeManifest: activeLabel,
    manifestCount: Object.keys(store?.manifests || {}).length,
    findings
  };
}
