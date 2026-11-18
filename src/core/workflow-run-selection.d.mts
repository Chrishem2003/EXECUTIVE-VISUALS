export interface WorkflowRunReference {
  id?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

export function normalizeWorkflowRunHistory(
  runs: readonly (WorkflowRunReference | null | undefined)[] | null | undefined
): WorkflowRunReference[];

export function getLatestWorkflowRunId(
  runs: readonly WorkflowRunReference[] | null | undefined
): string;
