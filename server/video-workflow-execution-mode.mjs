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
  const supported = node?.kind === "video.generate" && (
    (provider === "runway" && model === "model-router") ||
    (provider === "luma" && model === "ray-3.2")
  );
  if (supported) return true;
  const error = new Error(
    "This video workflow node has no approved cloud adapter. Choose Runway Model Router or Luma Ray 3.2, or use a separately approved execution environment."
  );
  error.code = "VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE";
  throw error;
}
