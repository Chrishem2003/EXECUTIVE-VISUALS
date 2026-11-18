export interface WorkflowRunReference {
  id?: string;
  status?: string;
}

export function getLatestWorkflowRunId(
  runs: readonly WorkflowRunReference[] | null | undefined
): string;
