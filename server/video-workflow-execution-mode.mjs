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
 * The production cloud lane currently has one fully governed workflow adapter.
 * Do not silently route other provider/model combinations through legacy sync gateways.
 */
export function assertVideoWorkflowNodeSupport(node, mode) {
  if (mode !== CLOUD_MODE) return true;
  const supported = node?.kind === "video.generate" &&
    String(node.config?.provider || "") === "runway" &&
    String(node.config?.model || "") === "model-router";
  if (supported) return true;
  const error = new Error(
    "This video workflow node has no approved cloud adapter. Choose the supported Runway Model Router or use a separately approved execution environment."
  );
  error.code = "VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE";
  throw error;
}
