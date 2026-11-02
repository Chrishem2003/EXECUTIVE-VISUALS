import type { EditorialTimeline } from "./timeline.ts";
import type { SourceMediaAsset } from "./source-media-evidence.ts";

export type RightsEvidenceStatus = "passed" | "review" | "blocked" | "not_run";
export interface RightsEvidenceReport {
  status: RightsEvidenceStatus;
  summary: string;
  evidenceRef: string;
  findings: Array<{ code: string; detail: string; assetId?: string }>;
  counts: { referenced: number; cleared: number; pending: number; blocked: number };
}
type Attestation = { status?: string; reference?: string; expiresAt?: string; requiresSubjectConsent?: boolean };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validReference = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 500;

export function assessRightsEvidence(timeline: EditorialTimeline | null, assets: SourceMediaAsset[] = [], now = new Date()): RightsEvidenceReport {
  const findings: RightsEvidenceReport["findings"] = [];
  if (!timeline || !timeline.tracks.some(track => track.clips.length)) {
    return { status: "not_run", summary: "No source clips are available for rights review.", evidenceRef: "rights:none", findings, counts: { referenced: 0, cleared: 0, pending: 0, blocked: 0 } };
  }
  const ids = new Set(timeline.tracks.flatMap(track => track.clips.map(clip => clip.assetId)));
  const library = new Map(assets.map(asset => [asset.id, asset]));
  let cleared = 0, pending = 0, blocked = 0;
  for (const id of ids) {
    const asset = library.get(id);
    if (!asset) {
      pending++;
      findings.push({ code: "RIGHTS_SOURCE_MISSING", detail: "The referenced source is not in the current asset library; rights evidence cannot be verified.", assetId: id });
      continue;
    }
    const rightsValue = asset.metadata?.rights;
    if (!object(rightsValue)) {
      pending++;
      findings.push({ code: "RIGHTS_ATTESTATION_MISSING", detail: "No source-rights attestation is recorded for this asset.", assetId: id });
      continue;
    }
    const rights = rightsValue as Attestation;
    if (rights.status === "denied" || rights.status === "revoked") {
      blocked++;
      findings.push({ code: "RIGHTS_DENIED", detail: "The recorded rights status is denied or revoked; do not use this source in delivery.", assetId: id });
      continue;
    }
    if (rights.expiresAt) {
      const expiry = Date.parse(rights.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
        blocked++;
        findings.push({ code: "RIGHTS_EXPIRED", detail: "The source-rights attestation is expired or has an invalid expiry timestamp.", assetId: id });
        continue;
      }
    }
    if (rights.status !== "cleared" || !validReference(rights.reference)) {
      pending++;
      findings.push({ code: "RIGHTS_CLEARANCE_INCOMPLETE", detail: "Rights must be explicitly marked cleared and include a supporting reference.", assetId: id });
      continue;
    }
    if (rights.requiresSubjectConsent === true) {
      const consentValue = asset.metadata?.subjectConsent;
      const consent = object(consentValue) ? consentValue as Attestation : {};
      if (consent.status === "denied" || consent.status === "revoked") {
        blocked++;
        findings.push({ code: "SUBJECT_CONSENT_DENIED", detail: "The recorded subject-consent status is denied or revoked.", assetId: id });
        continue;
      }
      if (consent.status !== "granted" || !validReference(consent.reference)) {
        pending++;
        findings.push({ code: "SUBJECT_CONSENT_INCOMPLETE", detail: "This source requires explicit subject consent with a supporting reference.", assetId: id });
        continue;
      }
      if (consent.expiresAt) {
        const expiry = Date.parse(consent.expiresAt);
        if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
          blocked++;
          findings.push({ code: "SUBJECT_CONSENT_EXPIRED", detail: "The recorded subject-consent attestation is expired or has an invalid expiry timestamp.", assetId: id });
          continue;
        }
      }
    }
    cleared++;
  }
  const status: RightsEvidenceStatus = blocked ? "blocked" : pending ? "not_run" : "passed";
  const summary = blocked ? blocked + " source(s) have denied, revoked or expired permissions."
    : pending ? cleared + " of " + ids.size + " source(s) have complete rights evidence; " + pending + " need review."
    : "All " + ids.size + " referenced source(s) have explicit rights evidence" + (findings.length ? "." : ".");
  return { status, summary, evidenceRef: "rights:attestation:" + [...ids].sort().join(",").slice(0, 160), findings, counts: { referenced: ids.size, cleared, pending, blocked } };
}
