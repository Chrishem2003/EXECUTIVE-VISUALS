// Frame Fit: compute how to reshape one video to other frame shapes.
// Pure arithmetic that yields a crop rectangle (or letterbox) plus an FFmpeg
// filter string. It does not touch media.

export interface FrameTarget { id: string; label: string; width: number; height: number }

export const FRAME_TARGETS: readonly FrameTarget[] = Object.freeze([
  { id: "vertical-9x16", label: "Vertical 9:16", width: 1080, height: 1920 },
  { id: "portrait-4x5", label: "Portrait 4:5", width: 1080, height: 1350 },
  { id: "square-1x1", label: "Square 1:1", width: 1080, height: 1080 },
  { id: "classic-4x3", label: "Classic 4:3", width: 1440, height: 1080 },
  { id: "landscape-16x9", label: "Landscape 16:9", width: 1920, height: 1080 },
  { id: "ultrawide-21x9", label: "Ultrawide 21:9", width: 2560, height: 1080 }
]);

export type FitMode = "crop" | "letterbox";
export interface FitInput { srcWidth: number; srcHeight: number; target: string; focusX?: number; focusY?: number; mode?: FitMode }
export interface FitResult {
  ok: boolean;
  problems: string[];
  target?: FrameTarget;
  mode?: FitMode;
  crop?: { x: number; y: number; width: number; height: number };
  keptPercent?: number;
  ffmpegFilter?: string;
  notes: string[];
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const validSize = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 16 && n <= 16384;

export function fitFrame(input: FitInput): FitResult {
  const problems: string[] = [];
  const target = FRAME_TARGETS.find(t => t.id === input.target);
  if (!validSize(input.srcWidth) || !validSize(input.srcHeight)) problems.push("Source width and height must be whole numbers from 16 to 16384.");
  if (!target) problems.push("Unknown frame target.");
  const fx = input.focusX ?? 0.5;
  const fy = input.focusY ?? 0.5;
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fx > 1 || fy < 0 || fy > 1) problems.push("Focus point must be between 0 and 1.");
  const mode: FitMode = input.mode === "letterbox" ? "letterbox" : "crop";
  if (problems.length || !target) return { ok: false, problems, notes: [] };

  const { srcWidth: sw, srcHeight: sh } = input;
  const notes: string[] = [];
  if (mode === "letterbox") {
    return {
      ok: true, problems: [], target, mode, keptPercent: 100,
      ffmpegFilter: "scale=" + target.width + ":" + target.height + ":force_original_aspect_ratio=decrease,pad=" + target.width + ":" + target.height + ":(ow-iw)/2:(oh-ih)/2:black",
      notes: ["Whole frame kept; bars fill the unused space."]
    };
  }
  const targetAspect = target.width / target.height;
  const sourceAspect = sw / sh;
  let w = sw, h = sh;
  if (sourceAspect > targetAspect) w = even(sh * targetAspect);
  else if (sourceAspect < targetAspect) h = even(sw / targetAspect);
  w = Math.min(w, sw);
  h = Math.min(h, sh);
  const x = clamp(Math.round(fx * sw - w / 2), 0, sw - w);
  const y = clamp(Math.round(fy * sh - h / 2), 0, sh - h);
  const keptPercent = Math.round((w * h) / (sw * sh) * 100);
  if (keptPercent < 50) notes.push("Only " + keptPercent + "% of the frame is kept. Move the focus point onto the subject.");
  if (w < target.width || h < target.height) notes.push("The crop is smaller than the output, so it will be scaled up and may look soft.");
  return {
    ok: true, problems: [], target, mode, crop: { x, y, width: w, height: h }, keptPercent,
    ffmpegFilter: "crop=" + w + ":" + h + ":" + x + ":" + y + ",scale=" + target.width + ":" + target.height + ":flags=lanczos",
    notes
  };
}

export function fitAllTargets(srcWidth: number, srcHeight: number, focusX = 0.5, focusY = 0.5, mode: FitMode = "crop") {
  return FRAME_TARGETS.map(t => fitFrame({ srcWidth, srcHeight, target: t.id, focusX, focusY, mode }));
}
