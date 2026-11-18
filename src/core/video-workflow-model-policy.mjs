/**
 * Keep the Video Studio model picker aligned with the server-side governed
 * execution allowlist. Legacy saved configurations remain visible but disabled
 * so users can understand and replace them without losing workflow history.
 */
const RELEASE_BLOCKED_MODELS = new Set(["kling_4_flash", "gemini_omni_flash_1.2"]);

export function isVideoWorkflowModelReleaseBlocked(model) {
  return RELEASE_BLOCKED_MODELS.has(String(model || "").trim());
}

export function getVideoWorkflowModelOptions(provider, selectedModel = "") {
  if (String(provider || "") === "luma") {
    return [{ id: "ray-3.2", label: "Luma Ray 3.2", disabled: false }];
  }
  const options = [
    { id: "model-router", label: "Runway Model Router", disabled: false },
    { id: "gen4.5", label: "Gen-4.5", disabled: false },
    { id: "seedance2_5", label: "Seedance 2.5", disabled: false },
    { id: "kling_4", label: "Kling 4.0", disabled: false },
    { id: "kling3.0_standard", label: "Kling 3.0 Standard", disabled: false },
    { id: "kling3.0_pro", label: "Kling 3.0 Pro", disabled: false },
    { id: "kling3.0_4k", label: "Kling 3.0 4K", disabled: false }
  ];
  const legacy = String(selectedModel || "").trim();
  if (isVideoWorkflowModelReleaseBlocked(legacy)) {
    const labels = {
      kling_4_flash: "Kling 4.0 Flash — unavailable (release gate)",
      "gemini_omni_flash_1.2": "Gemini Omni Flash 1.2 — unavailable (release gate)"
    };
    options.push({ id: legacy, label: labels[legacy], disabled: true });
  }
  return options;
}
