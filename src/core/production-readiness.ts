export type ProductionCheckId = "sequence" | "source_media" | "shot_capability" | "continuity" | "rights" | "captions" | "audio" | "delivery";
export type ProductionCheckStatus = "passed" | "review" | "blocked" | "not_run";
export interface ProductionCheckEvidence {
  status: ProductionCheckStatus;
  summary: string;
  findings?: Array<{ code: string; detail: string }>;
  evidenceRef?: string;
}
export interface ProductionReadinessInput {
  checks?: Partial<Record<ProductionCheckId, ProductionCheckEvidence>>;
}
export interface ProductionReadinessCheck {
  id: ProductionCheckId;
  label: string;
  required: true;
  status: ProductionCheckStatus;
  summary: string;
  findings: Array<{ code: string; detail: string }>;
  evidenceRef?: string;
}
export interface ProductionReadinessReport {
  schemaVersion: 1;
  decision: "blocked" | "review_required" | "ready_for_human_approval";
  checks: ProductionReadinessCheck[];
  counts: { passed: number; review: number; blocked: number; notRun: number; total: number };
  policy: {
    allRequiredChecksPassed: boolean;
    humanApprovalGranted: false;
    mediaRendered: false;
    providerSubmitted: false;
    missingEvidenceFailsClosed: true;
  };
}
const REQUIRED: Array<{ id: ProductionCheckId; label: string }> = [
  { id: "sequence", label: "Sequence structure" },
  { id: "source_media", label: "Source media integrity" },
  { id: "shot_capability", label: "Shot and engine compatibility" },
  { id: "continuity", label: "Story and visual continuity" },
  { id: "rights", label: "Rights and identity permissions" },
  { id: "captions", label: "Captions and localization" },
  { id: "audio", label: "Audio quality and accessibility" },
  { id: "delivery", label: "Delivery specification and export" },
];

/** Combines only supplied evidence. Missing checks remain not_run and can never become a pass. */
export function buildProductionReadinessReport(input: ProductionReadinessInput = {}): ProductionReadinessReport {
  const checks: ProductionReadinessCheck[] = REQUIRED.map(({ id, label }) => {
    const evidence = input.checks?.[id];
    return {
      id, label, required: true,
      status: evidence?.status ?? "not_run",
      summary: evidence?.summary?.trim() || (evidence?.status === "not_run" || !evidence ? "Not run — evidence is not available." : "Evidence supplied without a summary."),
      findings: Array.isArray(evidence?.findings) ? evidence.findings.map(item => ({
        code: String(item.code).slice(0, 80),
        detail: String(item.detail).slice(0, 1000),
      })) : [],
      ...(evidence?.evidenceRef ? { evidenceRef: evidence.evidenceRef.slice(0, 240) } : {}),
    };
  });
  const counts = {
    passed: checks.filter(item => item.status === "passed").length,
    review: checks.filter(item => item.status === "review").length,
    blocked: checks.filter(item => item.status === "blocked").length,
    notRun: checks.filter(item => item.status === "not_run").length,
    total: checks.length,
  };
  const allRequiredChecksPassed = counts.passed === checks.length;
  const decision = counts.blocked ? "blocked" : allRequiredChecksPassed ? "ready_for_human_approval" : "review_required";
  return {
    schemaVersion: 1, decision, checks, counts,
    policy: {
      allRequiredChecksPassed,
      humanApprovalGranted: false,
      mediaRendered: false,
      providerSubmitted: false,
      missingEvidenceFailsClosed: true,
    },
  };
}
