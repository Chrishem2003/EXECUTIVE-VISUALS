const LEGACY_MODE = "legacy";
const CLOUD_MODE = "cloud";

export function assertVideoWorkflowExecutionMode(mode = process.env.VIDEO_WORKFLOW_EXECUTION_MODE) {
  const selected = String(mode || LEGACY_MODE).trim().toLowerCase();
  if (selected === LEGACY_MODE) return selected;
  if (selected === CLOUD_MODE) {
    const error = new Error(
      "Cloud video workflow execution is not connected to the authenticated quote, approval, reservation, durable enqueue and asset-publication bridge yet. Disable VIDEO_WORKFLOW_EXECUTION_MODE=cloud until the P0 bridge passes staging acceptance."
    );
    error.code = "CLOUD_VIDEO_WORKFLOW_BRIDGE_NOT_CONFIGURED";
    throw error;
  }
  const error = new Error("VIDEO_WORKFLOW_EXECUTION_MODE must be either 'legacy' or 'cloud'.");
  error.code = "VIDEO_WORKFLOW_EXECUTION_MODE_INVALID";
  throw error;
}
