export interface WorkflowRunReference {
  id?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

export interface NormalizedWorkflowRunSummary {
  id: string;
  status: string;
  created_at?: string;
  updated_at?: string;
}

export function normalizeWorkflowRunHistory(
  runs: readonly (WorkflowRunReference | null | undefined)[] | null | undefined
): NormalizedWorkflowRunSummary[];

export function getLatestWorkflowRunId(
  runs: readonly WorkflowRunReference[] | null | undefined
): string;
