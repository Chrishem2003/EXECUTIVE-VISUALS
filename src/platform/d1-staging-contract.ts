export type D1WorkspaceDocument = Record<string, unknown>;

export const D1_WORKSPACE_DOCUMENT_MAX_BYTES = 256 * 1024;

/** Parse the JSON editor value using the same object and byte-size contract as the D1 API. */
export function parseD1WorkspaceDocument(raw: string): D1WorkspaceDocument {
  if (typeof raw !== "string") throw new Error("Workspace document must be JSON text.");
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes > D1_WORKSPACE_DOCUMENT_MAX_BYTES) {
    throw new Error("Workspace document must be no larger than 256 KB.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Workspace document contains invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workspace document must be a JSON object.");
  }
  return value as D1WorkspaceDocument;
}

/** Serialize a workspace update and enforce the upstream request-body limit including its revision envelope. */
export function buildD1WorkspaceUpdatePayload(raw: string, expectedRevision: number): string {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error("Workspace revision must be a positive integer.");
  }
  const document = parseD1WorkspaceDocument(raw);
  const payload = JSON.stringify({ expectedRevision, document });
  if (new TextEncoder().encode(payload).byteLength > D1_WORKSPACE_DOCUMENT_MAX_BYTES) {
    throw new Error("Workspace document plus API envelope must fit within 256 KB.");
  }
  return payload;
}

/** The D1 workspace is a staging-only feature and must be hidden unless the server explicitly advertises its bridge. */
export function isD1StagingWorkspaceEnabled(health: unknown): boolean {
  if (!health || typeof health !== "object" || Array.isArray(health)) return false;
  const staging = (health as { staging?: unknown }).staging;
  if (!staging || typeof staging !== "object" || Array.isArray(staging)) return false;
  return (staging as { d1WorkspaceEnabled?: unknown }).d1WorkspaceEnabled === true;
}
