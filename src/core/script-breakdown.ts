// Script Breakdown: turn pasted script text into a draft shot list.
// Pure and deterministic. Nothing is generated; it only proposes shots that the
// user reviews before adding them to the storyboard.
import { applyPresetToShot, getPreset, type ShotLike } from "./presets.ts";

export interface DraftShot {
  scene: string;
  action: string;
  duration: number;
  camera: string;
  lens: string;
  movement: string;
  lighting: string;
  presetIds: string[];
}

export interface BreakdownOptions {
  maxShots?: number;
  wordsPerSecond?: number;
  minSeconds?: number;
  maxSeconds?: number;
}

export interface BreakdownResult {
  shots: DraftShot[];
  totalSeconds: number;
  warnings: string[];
}

export const MAX_SCRIPT_CHARS = 20000;
const HEADING = /^(?:INT|EXT|INT\.?\/EXT|EXT\.?\/INT|I\/E)[.\s]/i;

type Rule = [RegExp, string];
const FRAMING_RULES: Rule[] = [
  [/\b(close[- ]?up|macro|detail|hands?|eyes?|fingers?)\b/i, "close-detail"],
  [/\b(over[- ]the[- ]shoulder|conversation|talks? with)\b/i, "over-the-shoulder"],
  [/\b(from above|aerial|overhead|rooftop|bird'?s)\b/i, "high-angle-overview"],
  [/\b(towering|hero|powerful|triumph)\b/i, "low-angle-power"],
  [/\b(wide|landscape|skyline|city|street|field|valley|establish\w*|horizon)\b/i, "wide-establishing"],
  [/\b(says|speaks|looks at|smiles|face|portrait)\b/i, "portrait-tele"]
];
const MOVEMENT_RULES: Rule[] = [
  [/\b(follows?|walks?|runs?|chases?|races?)\b/i, "trail-follow"],
  [/\b(reveals?|uncovers?|opens?)\b/i, "pull-back-reveal"],
  [/\b(approach\w*|toward\w*|closer|enters?)\b/i, "slow-push-in"],
  [/\b(spins?|circles?|around)\b/i, "orbit-sweep"],
  [/\b(still|silence|silent|pause\w*|waits?)\b/i, "locked-frame"]
];
const LIGHT_RULES: Rule[] = [
  [/\b(sunrise|sunset|golden)\b/i, "warm-golden-hour"],
  [/\b(dusk|twilight|blue hour)\b/i, "blue-hour-calm"],
  [/\b(night|neon|club)\b/i, "neon-night"],
  [/\b(candle|fire|lantern)\b/i, "candle-glow"],
  [/\b(noon|desert|harsh|blazing)\b/i, "hard-noon-contrast"],
  [/\b(dark|shadow\w*|secret|tense|dim)\b/i, "moody-low-key"],
  [/\b(studio|interview|product)\b/i, "soft-studio-key"],
  [/\b(overcast|rain\w*|fog\w*|mist\w*)\b/i, "overcast-even"]
];

const firstMatch = (rules: Rule[], text: string): string | null => {
  for (const [pattern, id] of rules) if (pattern.test(text)) return id;
  return null;
};
const wordCount = (text: string) => (text.match(/\S+/g) || []).length;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Split non-heading text into sentences and merge tiny fragments into a neighbour. */
function sentencesOf(lines: string[]): string[] {
  const raw = lines.join(" ").split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);
  const merged: string[] = [];
  for (const sentence of raw) {
    if (wordCount(sentence) < 4 && merged.length) merged[merged.length - 1] += " " + sentence;
    else merged.push(sentence);
  }
  if (merged.length > 1 && wordCount(merged[0]) < 4) merged.splice(0, 2, merged[0] + " " + merged[1]);
  return merged;
}

export function breakdownScript(text: string, options: BreakdownOptions = {}): BreakdownResult {
  const warnings: string[] = [];
  const maxShots = clamp(Math.floor(options.maxShots ?? 24), 1, 60);
  const wps = clamp(options.wordsPerSecond ?? 2.5, 0.5, 6);
  const minSeconds = clamp(Math.floor(options.minSeconds ?? 2), 1, 30);
  const maxSeconds = clamp(Math.floor(options.maxSeconds ?? 8), minSeconds, 60);
  let source = typeof text === "string" ? text : "";
  if (source.length > MAX_SCRIPT_CHARS) {
    source = source.slice(0, MAX_SCRIPT_CHARS);
    warnings.push("Script was longer than " + MAX_SCRIPT_CHARS + " characters; only the first part was used.");
  }
  if (!source.trim()) return { shots: [], totalSeconds: 0, warnings: ["Paste a script or outline to break it into shots."] };

  // Walk lines, tracking the current scene heading.
  const blocks: Array<{ scene: string; lines: string[] }> = [];
  let scene = "Opening";
  let current: { scene: string; lines: string[] } | null = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (HEADING.test(line)) {
      scene = line.replace(/\s+/g, " ").slice(0, 120);
      current = null;
      continue;
    }
    if (!current) { current = { scene, lines: [] }; blocks.push(current); }
    current.lines.push(line);
  }

  const all: Array<{ scene: string; sentence: string }> = [];
  for (const block of blocks) for (const sentence of sentencesOf(block.lines)) all.push({ scene: block.scene, sentence });
  if (!all.length) return { shots: [], totalSeconds: 0, warnings: ["No action lines were found, only scene headings."] };
  if (all.length > maxShots) {
    warnings.push(all.length + " sentences found; the first " + maxShots + " became shots. Raise the limit or split the script.");
  }

  const shots: DraftShot[] = all.slice(0, maxShots).map((item, index) => {
    const action = item.sentence.slice(0, 4000);
    const ids: string[] = [];
    const framing = firstMatch(FRAMING_RULES, action) || (index === 0 ? "wide-establishing" : null);
    for (const id of [framing, firstMatch(MOVEMENT_RULES, action), firstMatch(LIGHT_RULES, action + " " + item.scene)]) {
      if (id && getPreset(id)) ids.push(id);
    }
    let fields: ShotLike = { scene: item.scene, action, camera: "", lens: "", movement: "", lighting: "", duration: 0 };
    for (const id of ids) {
      const preset = getPreset(id);
      if (preset) fields = { ...fields, ...applyPresetToShot(fields, preset) };
    }
    return {
      scene: item.scene, action,
      duration: clamp(Math.round(wordCount(action) / wps), minSeconds, maxSeconds),
      camera: fields.camera || "Medium shot", lens: fields.lens || "50mm",
      movement: fields.movement || "Locked frame", lighting: fields.lighting || "Soft key / natural fill",
      presetIds: ids
    };
  });
  return { shots, totalSeconds: shots.reduce((n, s) => n + s.duration, 0), warnings };
}
