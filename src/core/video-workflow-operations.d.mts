export type VideoWorkflowOperationOption = { id: string; label: string };
export function getVideoWorkflowOperationOptions(provider: string, model: string): VideoWorkflowOperationOption[];
export function validateRunwayRouterVideoSourceInput(input: {
  sourceVideoAssetId?: string;
  rightsConfirmed?: boolean;
  startFrameAssetId?: string;
  endFrameAssetId?: string;
  referenceImageAssetIds?: string[];
  keyframeIndexes?: unknown[];
}): string;
