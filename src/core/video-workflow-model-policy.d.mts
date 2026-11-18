export type VideoWorkflowModelOption = {
  id: string;
  label: string;
  disabled: boolean;
};

export function isVideoWorkflowModelReleaseBlocked(model: unknown): boolean;
export function getVideoWorkflowModelOptions(provider: unknown, selectedModel?: unknown): VideoWorkflowModelOption[];
