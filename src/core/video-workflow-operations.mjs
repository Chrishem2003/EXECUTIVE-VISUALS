const GENERATE = Object.freeze({ id: "generate", label: "Generate (text or first frame)" });
const VIDEO_EDIT = Object.freeze({ id: "video-to-video", label: "Transform source video" });
const DRAFT_ENHANCE = Object.freeze({ id: "draft-enhancement", label: "Enhance completed draft to 1080p" });

/**
 * Return the single source of truth for video operation choices in the
 * workflow editor and its dynamic form refresh handler.
 */
export function getVideoWorkflowOperationOptions(provider, model) {
  if (provider === "luma") {
    return [
      { id: "generate", label: "Generate new video" },
      { id: "edit", label: "Edit existing video" },
      { id: "reframe", label: "Reframe existing video" }
    ];
  }
  if (provider !== "runway") return [{ id: "generate", label: "Generate new video" }];
  if (model === "model-router") return [
    { id: "text-to-video", label: "Generate from text" },
    { id: "image-to-video", label: "Generate from first frame" },
    { id: "video-to-video", label: "Transform source video" }
  ];
  if (model === "seedance2_5") return [GENERATE, VIDEO_EDIT, DRAFT_ENHANCE].map(value => ({ ...value }));
  if (["kling_4", "kling_4_flash", "gemini_omni_flash_1.2"].includes(model)) {
    return [GENERATE, VIDEO_EDIT].map(value => ({ ...value }));
  }
  return [{ id: "generate", label: "Generate new video" }];
}
