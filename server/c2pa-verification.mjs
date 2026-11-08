import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
const VALIDATION_STATES = new Set(["Invalid", "Valid", "Trusted"]);
const SUPPORTED_EXTENSIONS = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/gif": [".gif"],
  "video/mp4": [".mp4"],
  "application/mp4": [".mp4"],
  "video/quicktime": [".mov"],
  "audio/mpeg": [".mp3"],
  "audio/mp4": [".m4a"],
  "audio/wav": [".wav"],
  "audio/x-wav": [".wav"],
  "application/pdf": [".pdf"]
};

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

function buildContext(Sdk, trustAnchorPem, allowedSignerPem) {
  const hasTrustPolicy = Boolean(trustAnchorPem || allowedSignerPem);
  const trust = {
    verifyTrustList: true,
    ...(trustAnchorPem ? { userAnchors: trustAnchorPem } : {}),
    ...(allowedSignerPem ? { allowedList: allowedSignerPem } : {})
  };
  const settings = {
    verify: {
      verifyAfterReading: true,
      verifyTrust: hasTrustPolicy,
      verifyTimestampTrust: hasTrustPolicy,
      ocspFetch: false,
      remoteManifestFetch: false
    },
    ...(hasTrustPolicy ? { trust } : {})
  };
  return {
    context: new Sdk.Context(settings),
    hasTrustPolicy,
    trustPolicyType: allowedSignerPem ? "allowed_list" : trustAnchorPem ? "user_anchors" : "none"
  };
}

export function createC2paVerifier({
  sdkLoader = () => import("@contentauth/c2pa-node"),
  trustAnchors = process.env.C2PA_TRUST_ANCHORS || "",
  allowedSigners = process.env.C2PA_ALLOWED_SIGNERS || "",
  maxBytes = Number(process.env.C2PA_MAX_VERIFY_BYTES || DEFAULT_MAX_BYTES)
} = {}) {
  let sdkPromise;
  return async function verifyC2paAsset({ path, mimeType, size }) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return errorResult("C2PA_LIMIT_CONFIG_INVALID");
    if (typeof path !== "string" || !path || typeof mimeType !== "string" || !mimeType) {
      return errorResult("C2PA_ASSET_DESCRIPTOR_INVALID");
    }
    if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
      return errorResult(size > maxBytes ? "C2PA_ASSET_TOO_LARGE" : "C2PA_ASSET_SIZE_INVALID");
    }
    const absolutePath = resolve(path);
    const supportedExtensions = SUPPORTED_EXTENSIONS[mimeType.toLowerCase()];
    if (!supportedExtensions || !supportedExtensions.includes(extname(absolutePath).toLowerCase())) {
      return {
        status: "not_supported",
        manifestPresent: false,
        embedded: false,
        validationState: null,
        validationFindings: [],
        errorCode: "C2PA_FORMAT_UNSUPPORTED_OR_EXTENSION_MISMATCH"
      };
    }
    let actualSize;
    try {
      const info = statSync(absolutePath);
      if (!info.isFile()) return errorResult("C2PA_ASSET_NOT_FILE");
      actualSize = info.size;
    } catch {
      return errorResult("C2PA_ASSET_UNAVAILABLE");
    }
    if (actualSize !== size) return errorResult("C2PA_ASSET_SIZE_MISMATCH");
    const readPemPolicy = (filePath, invalidCode, unavailableCode) => {
      if (!filePath) return "";
      try {
        const absolute = resolve(filePath);
        const info = statSync(absolute);
        if (!info.isFile() || info.size < 1 || info.size > 4 * 1024 * 1024) throw new Error("invalid policy file");
        const pem = readFileSync(absolute, "utf8");
        if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw new Error("invalid PEM");
        return pem;
      } catch (error) {
        return { errorCode: error?.message === "invalid policy file" || error?.message === "invalid PEM" ? invalidCode : unavailableCode };
      }
    };
    const trustAnchorPem = readPemPolicy(trustAnchors, "C2PA_TRUST_ANCHORS_INVALID", "C2PA_TRUST_ANCHORS_UNAVAILABLE");
    if (typeof trustAnchorPem !== "string") return errorResult(trustAnchorPem.errorCode);
    const allowedSignerPem = readPemPolicy(allowedSigners, "C2PA_ALLOWED_SIGNERS_INVALID", "C2PA_ALLOWED_SIGNERS_UNAVAILABLE");
    if (typeof allowedSignerPem !== "string") return errorResult(allowedSignerPem.errorCode);

    try {
      sdkPromise ||= Promise.resolve().then(sdkLoader);
      const Sdk = await sdkPromise;
      if (typeof Sdk?.Reader?.fromAsset !== "function" || typeof Sdk?.Context !== "function") {
        return errorResult("C2PA_SDK_API_UNSUPPORTED");
      }
      const { context, hasTrustPolicy, trustPolicyType } = buildContext(Sdk, trustAnchorPem, allowedSignerPem);
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
        trustPolicyConfigured: hasTrustPolicy,
        trustPolicyType
      };
    } catch (error) {
      return errorResult(error?.code === "ERR_MODULE_NOT_FOUND" ? "C2PA_SDK_UNAVAILABLE" : "C2PA_SDK_VERIFICATION_FAILED");
    }
  };
}

export const verifyC2paAsset = createC2paVerifier();
