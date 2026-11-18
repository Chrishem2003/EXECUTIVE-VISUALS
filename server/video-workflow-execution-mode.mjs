const LEGACY_MODE = "legacy";
const CLOUD_MODE = "cloud";

export function assertVideoWorkflowExecutionMode(mode, { cloudBridgeAvailable = false, environment = process.env } = {}) {
  const configured = mode ?? environment.VIDEO_WORKFLOW_EXECUTION_MODE;
  const defaultMode = environment.NODE_ENV === "production" ? CLOUD_MODE : LEGACY_MODE;
  const selected = String(configured || defaultMode).trim().toLowerCase();
  if (selected === LEGACY_MODE) return selected;
  if (selected === CLOUD_MODE) {
    if (cloudBridgeAvailable) return selected;
    const error = new Error(
      "Cloud video workflow execution requires the authenticated cloud timeline API and the governed quote, approval, reservation, durable enqueue and private asset-import bridge."
    );
    error.code = "CLOUD_VIDEO_WORKFLOW_BRIDGE_NOT_CONFIGURED";
    throw error;
  }
  const error = new Error("VIDEO_WORKFLOW_EXECUTION_MODE must be either 'legacy' or 'cloud'.");
  error.code = "VIDEO_WORKFLOW_EXECUTION_MODE_INVALID";
  throw error;
}

/**
 * Cloud execution admits only provider/model pairs with a complete governed
 * quote, owner approval, budget reservation, durable worker and private-media path.
 * Do not silently route catalog-only providers through legacy sync gateways.
 */
export function assertVideoWorkflowNodeSupport(node, mode) {
  if (mode !== CLOUD_MODE) return true;
  const provider = String(node?.config?.provider || "");
  const model = String(node?.config?.model || "");
  // Kling 4.0 Flash and Gemini Omni 1.2 Flash remain deliberately excluded\n  // until exact pricing, SQL policy and end-to-end cloud adapter evidence pass.\n  const supported = node?.kind === "video.generate" && (
    (provider === "runway" && ["model-router","gen4.5","seedance2_5","kling_4","kling3.0_standard","kling3.0_pro","kling3.0_4k"].includes(model)) ||
    (provider === "luma" && model === "ray-3.2")
  );
  if (supported) return true;
  const error = new Error(
    "This video workflow node has no approved cloud adapter. Choose an explicitly governed Runway direct model, Runway Model Router or Luma Ray 3.2, or use a separately approved execution environment."
  );
  error.code = "VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE";
  throw error;
}


const GOVERNED_CLOUD_BLOCKED_CODES = new Set([
  "CLOUD_VIDEO_WORKFLOW_BRIDGE_NOT_CONFIGURED",
  "VIDEO_WORKFLOW_CLOUD_DISABLED",
  "VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE",
  "VIDEO_WORKFLOW_CLOUD_MODE_REQUIRED",
  "VIDEO_WORKFLOW_CLOUD_PROJECT_REQUIRED",
  "VIDEO_WORKFLOW_CLOUD_PROJECT_NOT_LINKED"
]);

/**
 * These errors mean the requested governed cloud execution path is unavailable
 * or needs an operator/project prerequisite. They are blocked, not failed:
 * no provider submission has taken place and the user can resolve the gate.
 */
export function isGovernedCloudWorkflowBlockedCode(code) {
  return GOVERNED_CLOUD_BLOCKED_CODES.has(String(code || ""));
}
