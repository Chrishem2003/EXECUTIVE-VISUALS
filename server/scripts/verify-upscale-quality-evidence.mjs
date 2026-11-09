import { loadUpscaleQualityEvidence } from "../upscale-quality-evidence.mjs";

const result = await loadUpscaleQualityEvidence();
const models = Object.fromEntries(Object.entries(result.models).map(([id, item]) => [id, {
  qualityVerified: item.qualityVerified === true,
  recordCount: item.qualityEvidence?.recordCount || 0,
  checkedAt: item.qualityEvidence?.checkedAt || null,
  reason: item.reason
}]));
const report = {
  configured: result.configured,
  verifiedModelCount: Object.values(models).filter(model => model.qualityVerified).length,
  models,
  reason: result.reason
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (!result.configured) process.exitCode = 2;
else if (!report.verifiedModelCount) process.exitCode = 1;
