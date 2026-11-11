const LEGACY_MODE = "legacy";
const CLOUD_MODE = "cloud";

export function assertVideoWorkflowExecutionMode(mode = process.env.VIDEO_WORKFLOW_EXECUTION_MODE, { cloudBridgeAvailable = false } = {}) {
  const selected = String(mode || LEGACY_MODE).trim().toLowerCase();
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
