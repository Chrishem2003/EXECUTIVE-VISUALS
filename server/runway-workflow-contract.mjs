const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_TYPES = new Set(["image", "video", "audio"]);
const STATUSES = new Set(["PENDING", "THROTTLED", "RUNNING", "SUCCEEDED", "FAILED"]);
const fail = (message, code = "RUNWAY_WORKFLOW_INVALID_INPUT") =>
  Object.assign(new Error(message), { code });

function validateUri(uri, type) {
  if (typeof uri !== "string" || uri.length < 13 || uri.length > 5242880) {
    throw fail("Workflow media URI is outside the supported size bounds.", "RUNWAY_WORKFLOW_MEDIA_INVALID");
  }
  const valid = /^https:\/\//i.test(uri) || /^runway:\/\//i.test(uri) ||
    (type === "image" && /^data:image\//i.test(uri)) ||
    (type === "video" && /^data:video\//i.test(uri)) ||
    (type === "audio" && /^data:audio\//i.test(uri));
  if (!valid) throw fail("Workflow media URI has an unsupported scheme or media type.", "RUNWAY_WORKFLOW_MEDIA_INVALID");
  return uri;
}

function inputManifestMap(inputs) {
  if (!Array.isArray(inputs)) throw fail("A published workflow input manifest is required.");
  const map = new Map();
  for (const item of inputs) {
    if (!item || typeof item.nodeId !== "string" || !item.nodeId.trim() ||
        typeof item.outputKey !== "string" || !item.outputKey.trim() ||
        !["primitive", ...MEDIA_TYPES].includes(item.type)) {
      throw fail("Published workflow input manifest contains an invalid input.");
    }
    const key = item.nodeId + ":" + item.outputKey;
    if (map.has(key)) throw fail("Published workflow input manifest contains duplicate inputs.");
    map.set(key, { ...item });
  }
  return map;
}

/**
 * Build a Runway Workflow invocation request from a published-version manifest.
 * Media inputs use private asset IDs and require authenticated project scope.
 * This is a request planner only; it does not call Runway or create an invocation.
 */
export async function buildRunwayWorkflowInvocationPayload({
  workflowId, inputs, nodeOutputs, projectId,
  getAuthorizedAssetContext, resolvePrivateAsset
} = {}) {
  if (typeof workflowId !== "string" || !UUID.test(workflowId)) {
    throw fail("A published Runway Workflow version UUID is required.", "RUNWAY_WORKFLOW_ID_INVALID");
  }
  if (!nodeOutputs || typeof nodeOutputs !== "object" || Array.isArray(nodeOutputs)) {
    throw fail("Workflow nodeOutputs must be an object.");
  }
  const manifest = inputManifestMap(inputs);
  const output = {};
  const pendingAssets = [];
  for (const [nodeId, values] of Object.entries(nodeOutputs)) {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw fail("Workflow node outputs must be objects keyed by published node ID.");
    }
    for (const [outputKey, value] of Object.entries(values)) {
      const spec = manifest.get(nodeId + ":" + outputKey);
      if (!spec || spec.exposedToApp === false) {
        throw fail("Workflow input does not match an exposed input in this published version.", "RUNWAY_WORKFLOW_INPUT_NOT_EXPOSED");
      }
      if (spec.type === "primitive") {
        if (!value || value.type !== "primitive" ||
            !["string", "number", "boolean"].includes(typeof value.value) ||
            (typeof value.value === "number" && !Number.isFinite(value.value))) {
          throw fail("Primitive workflow inputs require a finite string, number or boolean value.");
        }
        output[nodeId] ||= {};
        output[nodeId][outputKey] = { type: "primitive", value: value.value };
        continue;
      }
      if (!MEDIA_TYPES.has(spec.type) || !value || value.type !== spec.type ||
          typeof value.assetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.assetId)) {
        throw fail("Workflow media inputs require a matching media type and private asset ID.", "RUNWAY_WORKFLOW_MEDIA_INVALID");
      }
      pendingAssets.push({ nodeId, outputKey, type: spec.type, assetId: value.assetId });
    }
  }
  if (pendingAssets.length) {
    if (typeof getAuthorizedAssetContext !== "function") {
      throw fail("Authenticated project access is required for workflow media.", "RUNWAY_WORKFLOW_ASSET_AUTH_REQUIRED");
    }
    if (typeof resolvePrivateAsset !== "function") {
      throw fail("A private asset resolver is required for workflow media.", "RUNWAY_WORKFLOW_ASSET_RESOLVER_REQUIRED");
    }
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw fail("A project ID is required for workflow media.", "RUNWAY_WORKFLOW_MEDIA_INVALID");
    }
    let scope;
    try { scope = await getAuthorizedAssetContext({ projectId }); }
    catch { throw fail("The active user is not authorized for this workflow project.", "RUNWAY_WORKFLOW_ASSET_FORBIDDEN"); }
    if (!scope || typeof scope.ownerId !== "string" || !scope.ownerId.trim() || scope.projectId !== projectId) {
      throw fail("Authenticated project scope is invalid.", "RUNWAY_WORKFLOW_ASSET_FORBIDDEN");
    }
    for (const asset of pendingAssets) {
      let resolved;
      try {
        resolved = await resolvePrivateAsset({
          assetId: asset.assetId, ownerId: scope.ownerId,
          projectId: scope.projectId, mediaType: asset.type
        });
      } catch {
        throw fail("A private workflow media asset could not be resolved.", "RUNWAY_WORKFLOW_ASSET_UNAVAILABLE");
      }
      output[asset.nodeId] ||= {};
      output[asset.nodeId][asset.outputKey] = {
        type: asset.type,
        uri: validateUri(resolved?.uri, asset.type)
      };
    }
  }
  return Object.freeze({
    workflowId,
    payload: Object.freeze({ nodeOutputs: output })
  });
}

/**
 * Interpret invocation responses correctly: SUCCEEDED can still contain
 * per-node errors or missing expected outputs, and is not necessarily complete.
 */
export function normalizeRunwayWorkflowInvocation(payload, expectedOutputNodeIds = []) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      !STATUSES.has(payload.status)) {
    throw fail("Runway returned an invalid workflow invocation status.", "RUNWAY_WORKFLOW_RESPONSE_INVALID");
  }
  if (!Array.isArray(expectedOutputNodeIds) ||
      expectedOutputNodeIds.some(id => typeof id !== "string" || !id.trim())) {
    throw fail("Expected workflow output node IDs must be a string array.");
  }
  const output = payload.output && typeof payload.output === "object" && !Array.isArray(payload.output)
    ? payload.output : {};
  const nodeErrors = payload.nodeErrors && typeof payload.nodeErrors === "object" && !Array.isArray(payload.nodeErrors)
    ? payload.nodeErrors : {};
  const missingOutputs = expectedOutputNodeIds.filter(id =>
    !Array.isArray(output[id]) || output[id].length === 0
  );
  const terminal = payload.status === "SUCCEEDED" || payload.status === "FAILED";
  let outcome = "running";
  if (payload.status === "FAILED") outcome = "failed";
  else if (payload.status === "SUCCEEDED") {
    outcome = Object.keys(nodeErrors).length === 0 && missingOutputs.length === 0
      ? "complete" : "partial";
  }
  const credits = payload.cost?.credits;
  if (credits !== undefined && (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0)) {
    throw fail("Workflow invocation cost evidence is invalid.", "RUNWAY_WORKFLOW_RESPONSE_INVALID");
  }
  return Object.freeze({
    invocationId: typeof payload.id === "string" ? payload.id : null,
    providerStatus: payload.status,
    outcome,
    terminal,
    progress: typeof payload.progress === "number" && Number.isFinite(payload.progress)
      ? Math.max(0, Math.min(1, payload.progress)) : null,
    nodeErrors: Object.freeze({ ...nodeErrors }),
    missingOutputs: Object.freeze(missingOutputs),
    costCredits: credits ?? null,
    costFinalized: terminal && credits !== undefined,
    requiresPrivateOutputIngestion: outcome === "complete" || outcome === "partial"
  });
}

export const RUNWAY_WORKFLOW_POLL_INTERVAL_MS = 5000;
