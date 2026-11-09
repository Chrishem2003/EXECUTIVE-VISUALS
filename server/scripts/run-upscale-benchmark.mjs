import { runUpscaleBenchmark } from "../upscale-benchmark-runner.mjs";

const [model, manifestPath, outputDirectory, tileArgument] = process.argv.slice(2);
const tile = tileArgument === undefined ? 128 : Number(tileArgument);
if (!model || !manifestPath || !outputDirectory) {
  process.stderr.write("Usage: node server/scripts/run-upscale-benchmark.mjs <model> <fixture-manifest.json> <output-directory> [tile-size]\n");
  process.exitCode = 2;
} else {
  try {
    const result = await runUpscaleBenchmark({ model, manifestPath, outputDirectory, tile });
    process.stdout.write(JSON.stringify({
      executionBenchmarkPassed: true,
      executionSelfTestPassed: result.executionSelfTest.passed === true,
      model,
      requestedTile: tile,
      fixtureCount: result.records.length,
      qualityVerified: false,
      qualityReviewRequired: true,
      reportPath: result.reportPath,
      nextStep: "Review every source/output pair, then add reviewer ID, timestamp, substantive notes and review-artifact SHA-256 to each record. Execution success is not a visual-quality approval."
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message, code: error.code || "AI_UPSCALE_BENCHMARK_FAILED" }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
