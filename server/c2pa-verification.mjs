import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
const VALIDATION_STATES = new Set(["Invalid", "Valid", "Trusted"]);

function safeFindings(statuses) {
  if (!Array.isArray(statuses)) return [];
  return statuses.slice(0, 50).map(item => ({
    code: typeof item?.code === "string" ? item.code.slice(0, 200) : "UNKNOWN_VALIDATION_CODE",
    ...(typeof item?.success === "boolean" ? { success: item.success } : {}),
    ...(typeof item?.explanation === "string" ? { explanation: item.explanation.slice(0, 1000) } : {}),
    ...(typeof item?.url === "string" ? { url: item.url.slice(0, 1000) } : {})
  }));
}

function errorResult(code) {
  return {
    status: "verification_error",
    manifestPresent: false,
    embedded: false,
    validationState: null,
    validationFindings: [],
    errorCode: code
  };
}

function buildContext(Sdk, trustAnchors) {
  const hasTrustPolicy = Boolean(trustAnchors);
  const settings = {
    verify: {
      verifyAfterReading: true,
      verifyTrust: hasTrustPolicy,
      verifyTimestampTrust: hasTrustPolicy,
      ocspFetch: false,
      remoteManifestFetch: false
    },
    ...(hasTrustPolicy ? { trust: { trustAnchors, verifyTrustList: false } } : {})
  };
  return { context: new Sdk.Context(settings), hasTrustPolicy };
}

export function createC2paVerifier({
  sdkLoader = () => import("@contentauth/c2pa-node"),
  trustAnchors = process.env.C2PA_TRUST_ANCHORS || "",
  maxBytes = Number(process.env.C2PA_MAX_VERIFY_BYTES || DEFAULT_MAX_BYTES)
} = {}) {
  let sdkPromise;
  return async function verifyC2paAsset({ path, mimeType, size }) {
    if (typeof path !== "string" || !path || typeof mimeType !== "string" || !mimeType) {
      return errorResult("C2PA_ASSET_DESCRIPTOR_INVALID");
    }
    if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
      return errorResult(size > maxBytes ? "C2PA_ASSET_TOO_LARGE" : "C2PA_ASSET_SIZE_INVALID");
    }
    const absolutePath = resolve(path);
    let actualSize;
    try {
      const info = statSync(absolutePath);
      if (!info.isFile()) return errorResult("C2PA_ASSET_NOT_FILE");
      actualSize = info.size;
    } catch {
      return errorResult("C2PA_ASSET_UNAVAILABLE");
    }
    if (actualSize !== size) return errorResult("C2PA_ASSET_SIZE_MISMATCH");
    if (trustAnchors && !existsSync(resolve(trustAnchors))) {
      return errorResult("C2PA_TRUST_ANCHORS_UNAVAILABLE");
    }

    try {
      sdkPromise ||= Promise.resolve().then(sdkLoader);
      const Sdk = await sdkPromise;
      if (typeof Sdk?.Reader?.fromAsset !== "function" || typeof Sdk?.Context !== "function") {
        return errorResult("C2PA_SDK_API_UNSUPPORTED");
      }
      const { context, hasTrustPolicy } = buildContext(Sdk, trustAnchors ? resolve(trustAnchors) : "");
      const reader = await Sdk.Reader.fromAsset({ path: absolutePath, mimeType }, context);
      if (!reader) {
        return {
          status: "not_available",
          manifestPresent: false,
          embedded: false,
          validationState: null,
          validationFindings: []
        };
      }
      const store = reader.json();
      const validationState = store?.validation_state ?? null;
      const validationFindings = safeFindings(store?.validation_status);
      if (!VALIDATION_STATES.has(validationState)) {
        return {
          ...errorResult("C2PA_VALIDATION_STATE_UNKNOWN"),
          manifestPresent: true,
          embedded: Boolean(reader.isEmbedded?.()),
          validationFindings
        };
      }
      let status = "verification_error";
      if (validationState === "Invalid") status = "invalid";
      if (validationState === "Valid") status = "valid_untrusted";
      if (validationState === "Trusted") status = hasTrustPolicy ? "valid_trusted" : "valid_untrusted";
      return {
        status,
        manifestPresent: true,
        embedded: Boolean(reader.isEmbedded?.()),
        validationState,
        validationFindings,
        trustPolicyConfigured: hasTrustPolicy
      };
    } catch (error) {
      return errorResult(error?.code === "ERR_MODULE_NOT_FOUND" ? "C2PA_SDK_UNAVAILABLE" : "C2PA_SDK_VERIFICATION_FAILED");
    }
  };
}

export const verifyC2paAsset = createC2paVerifier();
