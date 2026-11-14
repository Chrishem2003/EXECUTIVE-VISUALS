import { createLpipsPerceptualAssessor } from "../lpips-perceptual-assessor.mjs";
import { createUpscaleVisualQualityAssessor } from "../upscale-visual-quality.mjs";

const [candidatePath, referencePath, network = "alex", device = "auto"] = process.argv.slice(2);
if (!candidatePath || !referencePath) {
  process.stderr.write("Usage: npm run assess:upscale-pair -- <candidate-image> <same-resolution-reference-image> [alex|vgg|squeeze] [auto|cpu|cuda]\n");
  process.exitCode = 2;
} else {
  try {
    const assessor = createLpipsPerceptualAssessor({ network, device });
    const visualAssessor = createUpscaleVisualQualityAssessor({ lpipsAssessor: assessor });
    const report = await visualAssessor.assess({ candidatePath, referencePath });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message, code: error.code || "AI_UPSCALE_LPIPS_FAILED" }, null, 2) + "\n");
    process.exitCode = 2;
  }
}
