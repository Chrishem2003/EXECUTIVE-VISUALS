import { createHash } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
const MIME_EXTENSIONS = {
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

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Creates a C2PA transformation signer backed by an injected protected signer provider.
 *
 * The application receives only a key reference and public certificate chain. The provider
 * performs the private-key operation in a KMS/HSM or authenticated remote signing service.
 * This adapter is disabled unless explicitly enabled and a provider is injected.
 */
export function createC2paTransformationSigner({
  enabled = process.env.C2PA_SIGNING_ENABLED === "true",
  mediaRoot = process.env.C2PA_SIGNING_MEDIA_ROOT || "",
  certificateChain,
  keyRef = process.env.C2PA_SIGNING_KEY_REF || "",
  signingProvider,
  tsaUrl = process.env.C2PA_TSA_URL || "",
  requireTimestamp = true,
  algorithm = "es256",
  reserveSize = 10000,
  maxBytes = Number(process.env.C2PA_MAX_VERIFY_BYTES || DEFAULT_MAX_BYTES),
  appName = "CHRISHEM EXCLUSIVE VISUALS",
  appVersion = "0.1.0",
  sdkLoader = () => import("@contentauth/c2pa-node")
} = {}) {
  return async function signC2paTransformation({
    inputPath,
    outputPath,
    mimeType,
    sourcePath = inputPath,
    sourceMimeType = mimeType,
    actionDescription,
    sourceAssetId = null,
    signal
  }) {
    if (signal?.aborted) fail("JOB_CANCELLED");
    if (!enabled) fail("C2PA_SIGNING_DISABLED");
    if (!mediaRoot) fail("C2PA_MEDIA_ROOT_REQUIRED");
    if (!Buffer.isBuffer(certificateChain) || !certificateChain.includes(Buffer.from("-----BEGIN CERTIFICATE-----")) || certificateChain.includes(Buffer.from("PRIVATE KEY"))) {
      fail("C2PA_SIGNING_CERTIFICATE_REQUIRED");
    }
    if (typeof keyRef !== "string" || !keyRef.trim()) fail("C2PA_SIGNING_KEY_REFERENCE_REQUIRED");
    if (!signingProvider || typeof signingProvider.sign !== "function") fail("C2PA_PROTECTED_SIGNER_UNAVAILABLE");
    if (algorithm !== "es256") fail("C2PA_SIGNING_ALGORITHM_UNSUPPORTED");
    if (!Number.isSafeInteger(reserveSize) || reserveSize < 4096 || reserveSize > 65536) fail("C2PA_SIGNING_RESERVE_SIZE_INVALID");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail("C2PA_LIMIT_CONFIG_INVALID");
    if (requireTimestamp && !tsaUrl) fail("C2PA_TIMESTAMP_AUTHORITY_REQUIRED");
    if (tsaUrl) {
      let parsed;
      try { parsed = new URL(tsaUrl); } catch { fail("C2PA_TIMESTAMP_AUTHORITY_INVALID"); }
      if (parsed.protocol !== "https:") fail("C2PA_TIMESTAMP_AUTHORITY_INVALID");
    }
    if (typeof actionDescription !== "string" || !actionDescription.trim() || actionDescription.length > 500) {
      fail("C2PA_TRANSFORMATION_DESCRIPTION_INVALID");
    }
    if (typeof inputPath !== "string" || typeof outputPath !== "string" || !inputPath || !outputPath || !mimeType) {
      fail("C2PA_ASSET_DESCRIPTOR_INVALID");
    }
    const inputExtensions = MIME_EXTENSIONS[mimeType.toLowerCase()];
    const sourceExtensions = MIME_EXTENSIONS[sourceMimeType.toLowerCase()];
    if (!inputExtensions || !inputExtensions.includes(extname(inputPath).toLowerCase()) ||
        !inputExtensions.includes(extname(outputPath).toLowerCase()) ||
        !sourceExtensions || !sourceExtensions.includes(extname(sourcePath).toLowerCase())) {
      fail("C2PA_FORMAT_UNSUPPORTED_OR_EXTENSION_MISMATCH");
    }

    let root, source, input, destination, outputParent;
    try {
      root = realpathSync(resolve(mediaRoot));
      source = realpathSync(resolve(sourcePath));
      input = realpathSync(resolve(inputPath));
      outputParent = realpathSync(dirname(resolve(outputPath)));
      destination = resolve(outputPath);
    } catch {
      fail("C2PA_ASSET_PATH_UNAVAILABLE");
    }
    if (!isWithin(root, source) || !isWithin(root, input) || !isWithin(root, outputParent) || !isWithin(root, destination)) {
      fail("C2PA_ASSET_PATH_OUTSIDE_MEDIA_ROOT");
    }
    if (source === destination || input === destination) fail("C2PA_SOURCE_OUTPUT_MUST_DIFFER");
    let sourceInfo, inputInfo;
    try {
      sourceInfo = statSync(source);
      inputInfo = statSync(input);
      if (!sourceInfo.isFile()) fail("C2PA_SOURCE_NOT_FILE");
      if (!inputInfo.isFile()) fail("C2PA_INPUT_NOT_FILE");
    } catch (error) {
      if (typeof error?.code === "string" && error.code.startsWith("C2PA_")) throw error;
      fail("C2PA_SOURCE_UNAVAILABLE");
    }
    if (sourceInfo.size < 1 || sourceInfo.size > maxBytes) fail("C2PA_SOURCE_SIZE_INVALID");
    if (inputInfo.size < 1 || inputInfo.size > maxBytes) fail("C2PA_INPUT_SIZE_INVALID");
    if (existsSync(destination)) fail("C2PA_OUTPUT_ALREADY_EXISTS");

    let outputCreated = false;
    try {
      const Sdk = await sdkLoader();
      if (!Sdk?.Builder?.newAsync || !Sdk?.CallbackSigner?.newSigner || !Sdk?.Reader?.fromAsset || !Sdk?.Context) {
        fail("C2PA_SDK_API_UNSUPPORTED");
      }
      const readContext = new Sdk.Context({
        verify: {
          verifyAfterReading: true,
          verifyTrust: false,
          remoteManifestFetch: false,
          ocspFetch: false
        }
      });
      const sourceReader = await Sdk.Reader.fromAsset({ path: source, mimeType: sourceMimeType }, readContext);
      let sourceManifestState = null;
      if (sourceReader) {
        sourceManifestState = sourceReader.json()?.validation_state ?? null;
        if (!["Valid", "Trusted"].includes(sourceManifestState)) fail("C2PA_SOURCE_MANIFEST_INVALID");
      }

      const builderContext = new Sdk.Context({
        builder: { generateC2paArchive: true },
        verify: {
          verifyAfterSign: true,
          verifyTrust: false,
          remoteManifestFetch: false
        }
      });
      const builder = await Sdk.Builder.newAsync(builderContext);
      if (sourceReader) {
        await builder.addIngredientFromReader(sourceReader);
      } else if (source !== input) {
        await builder.addIngredient(JSON.stringify({
          title: basename(source),
          format: sourceMimeType,
          instance_id: "urn:sha256:" + await sha256File(source),
          relationship: "parentOf"
        }), { path: source, mimeType: sourceMimeType });
      }
      builder.setIntent("edit");
      builder.addAction(JSON.stringify({
        action: "c2pa.edited",
        softwareAgent: { name: appName, version: appVersion },
        parameters: { description: actionDescription }
      }));

      const callbackSigner = Sdk.CallbackSigner.newSigner({
        alg: algorithm,
        certs: [certificateChain],
        reserveSize,
        directCoseHandling: false,
        ...(tsaUrl ? { tsaUrl } : {})
      }, async data => {
        const payload = Buffer.from(data);
        const signature = await signingProvider.sign({ keyRef, algorithm, payload, signal });
        if (signal?.aborted) fail("JOB_CANCELLED");
        if (!Buffer.isBuffer(signature) && !(signature instanceof Uint8Array)) {
          fail("C2PA_PROTECTED_SIGNER_RESPONSE_INVALID");
        }
        return Buffer.from(signature);
      });

      await builder.signAsync(
        callbackSigner,
        { path: input, mimeType },
        { path: destination, mimeType }
      );
      outputCreated = true;
      if (signal?.aborted) fail("JOB_CANCELLED");

      const outputInfo = statSync(destination);
      if (!outputInfo.isFile() || outputInfo.size < 1 || outputInfo.size > maxBytes) {
        fail("C2PA_SIGNED_OUTPUT_SIZE_INVALID");
      }
      const outputReader = await Sdk.Reader.fromAsset({ path: destination, mimeType }, readContext);
      if (!outputReader || !outputReader.isEmbedded?.()) fail("C2PA_SIGNED_OUTPUT_MANIFEST_MISSING");
      const outputStore = outputReader.json();
      const validationState = outputStore?.validation_state ?? null;
      if (!["Valid", "Trusted"].includes(validationState)) fail("C2PA_SIGNED_OUTPUT_VALIDATION_FAILED");
      const activeManifest = outputReader.getActive?.();
      const ingredientCount = Array.isArray(activeManifest?.ingredients) ? activeManifest.ingredients.length : 0;
      if (ingredientCount < 1) fail("C2PA_INGREDIENT_LINEAGE_MISSING");

      return {
        status: "signed_and_verified",
        mimeType,
        byteSize: outputInfo.size,
        sha256: await sha256File(destination),
        validationState,
        sourceManifestState,
        sourceManifestPreserved: Boolean(sourceReader),
        ingredientCount,
        sourceAssetId: typeof sourceAssetId === "string" ? sourceAssetId : null,
        sourceAndInputDiffer: source !== input,
        timestampConfigured: Boolean(tsaUrl)
      };
    } catch (error) {
      if (outputCreated || existsSync(destination)) {
        try { await unlink(destination); } catch { /* best-effort cleanup of partial derivative */ }
      }
      if ((typeof error?.code === "string" && error.code.startsWith("C2PA_"))) throw error;
      fail("C2PA_TRANSFORMATION_SIGNING_FAILED");
    }
  };
}
