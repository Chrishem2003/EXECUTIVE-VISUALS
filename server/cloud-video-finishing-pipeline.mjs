import { createVideoFinishingPipeline } from "./video-finishing-pipeline.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Bind the generic finishing engine to the authenticated cloud checkpoint
 * repository. The caller supplies verified owner/project IDs and real
 * capability-aware adapters; this factory never discovers vendors or spends
 * money by itself.
 */
export function createCloudVideoFinishingPipeline({
  ownerId,
  projectId,
  resolveAdapter,
  executeStep,
  checkpointStore
} = {}) {
  if (!UUID.test(ownerId || "") || !UUID.test(projectId || "")) {
    throw new Error("Cloud video finishing requires verified owner and project UUIDs.");
  }
  if (!checkpointStore || typeof checkpointStore.get !== "function" || typeof checkpointStore.save !== "function") {
    throw new Error("Cloud video finishing requires durable cloud checkpoint storage.");
  }
  const scopedCheckpoints = Object.freeze({
    get: (pipelineId, stepId) => checkpointStore.get({ ownerId, projectId, pipelineId, stepId }),
    save: record => checkpointStore.save({ ownerId, projectId, record })
  });
  const pipeline = createVideoFinishingPipeline({ resolveAdapter, executeStep, checkpoints: scopedCheckpoints });
  return Object.freeze({
    run: (plan, approval, options) => pipeline.run(plan, approval, options)
  });
}
