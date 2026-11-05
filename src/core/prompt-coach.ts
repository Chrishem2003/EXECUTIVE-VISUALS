// Prompt Coach: a quick, deterministic quality check for an image or video prompt.
// It never rewrites the user's words; it reports what is missing and suggests
// library presets that fill each gap.
import { composePrompt } from "./presets.ts";

export type CoachMode = "image" | "video";
export interface CoachCheck { id: string; label: string; ok: boolean; tip: string; presetId?: string }
export interface CoachResult {
  score: number;
  level: "weak" | "fair" | "strong";
  wordCount: number;
  checks: CoachCheck[];
  suggestedIds: string[];
}

const SUBJECT = /\b(a|an|the|woman|man|girl|boy|child|person|people|dog|cat|bird|car|bike|robot|house|tree|city|street|product|bottle|phone|watch|shoes?|food|plate|mountain|river|ocean|ship|face|hands?)\b/i;
const SETTING = /\b(in|inside|at|on|beside|against|near|under|above|across|through|outside|indoors|outdoors)\b\s+(?:\w+\s+){0,3}\w+/i;
const CAMERA = /\b(close[- ]?up|wide|medium shot|macro|portrait|overhead|aerial|low[- ]angle|high[- ]angle|over[- ]the[- ]shoulder|\d{2,3}\s?mm|lens|bokeh|depth of field)\b/i;
const LIGHT = /\b(light(?:ing)?|golden hour|sunset|sunrise|neon|candle|backlit|rim light|soft box|studio|shadow\w*|glow\w*|overcast|moody|high[- ]key|low[- ]key)\b/i;
const STYLE = /\b(cinematic|photoreal\w*|film grain|documentary|illustration|watercolou?r|3d render|anime|vintage|retro|pastel|monochrome|black and white|commercial|editorial|color grade|palette)\b/i;
const MOTION = /\b(pan|tilt|dolly|push[- ]in|pull[- ]back|orbit|track\w*|handheld|zoom\w*|glide\w*|sweep\w*|walks?|runs?|turns?|moves?|rises?|falls?|drift\w*)\b/i;
const NEGATIVE_PHRASING = /\b(don'?t|do not|without|no\s+\w+|not\s+\w+)\b/i;

const wordCount = (text: string) => (text.match(/\S+/g) || []).length;

export function coachPrompt(prompt: string, mode: CoachMode = "image"): CoachResult {
  const text = typeof prompt === "string" ? prompt : "";
  const words = wordCount(text);
  const video = mode === "video";
  const checks: CoachCheck[] = [
    { id: "length", label: "Enough detail", ok: words >= 12, tip: "Aim for at least a dozen words: who or what, where, and how it looks." },
    { id: "subject", label: "Clear subject", ok: words > 0 && SUBJECT.test(text), tip: "Name the main subject first." },
    { id: "setting", label: "Setting or place", ok: SETTING.test(text), tip: "Say where it happens (for example: inside a quiet workshop)." },
    { id: "camera", label: "Camera or framing", ok: CAMERA.test(text), tip: "Add a framing or lens, such as a close-up or a wide establishing shot.", presetId: "wide-establishing" },
    { id: "light", label: "Lighting", ok: LIGHT.test(text), tip: "Describe the light: golden hour, soft studio key, neon at night.", presetId: "soft-studio-key" },
    { id: "style", label: "Look or style", ok: STYLE.test(text), tip: "Pick a look: cinematic, documentary, pastel, black and white.", presetId: "clean-commercial" },
    { id: "brevity", label: "Not overloaded", ok: words <= 120, tip: "Over 120 words dilutes results. Keep the strongest details." },
    { id: "positive", label: "Says what you want", ok: !NEGATIVE_PHRASING.test(text), tip: "Describe what you want. Use the negative prompt field for what to avoid." }
  ];
  if (video) checks.splice(3, 0, { id: "motion", label: "Movement", ok: MOTION.test(text), tip: "Say how the subject or camera moves.", presetId: "slow-push-in" });
  const weights: Record<string, number> = { length: 14, subject: 14, setting: 12, camera: 12, light: 12, style: 10, motion: 12, brevity: 7, positive: 7 };
  const total = checks.reduce((n, c) => n + weights[c.id], 0);
  const earned = words === 0 ? 0 : checks.reduce((n, c) => n + (c.ok ? weights[c.id] : 0), 0);
  const score = Math.round((earned / total) * 100);
  return {
    score, level: score >= 75 ? "strong" : score >= 45 ? "fair" : "weak", wordCount: words, checks,
    suggestedIds: words === 0 ? [] : checks.filter(c => !c.ok && c.presetId).map(c => c.presetId as string)
  };
}

/** Append the suggested presets to the user's own text. Never removes anything. */
export function applySuggestions(prompt: string, result: CoachResult, maxLength = 1500) {
  return composePrompt(prompt, result.suggestedIds, { maxLength });
}
