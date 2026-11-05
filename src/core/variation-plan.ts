// Variation planner: from one base prompt, build a small set of draft prompts that
// each change exactly one thing (camera, light or look). Pairs with cheap draft
// models: explore here, then spend on the one you like. Pure and deterministic.

import { composePrompt, listPresets, type PresetCategory } from "./presets.ts";

export type VaryAxis = "camera" | "light" | "look";
export const VARY_AXES: readonly VaryAxis[] = Object.freeze(["camera", "light", "look"]);
export const MIN_VARIATIONS = 2;
export const MAX_VARIATIONS = 8;

export interface Variation {
  index: number;
  presetId: string;
  label: string;
  prompt: string;
}

export interface VariationPlan {
  ok: boolean;
  axis: VaryAxis;
  variations: Variation[];
  problems: string[];
}

const CATEGORY_FOR: Record<VaryAxis, PresetCategory> = { camera: "camera", light: "light", look: "look" };

/**
 * `target` filters presets that suit the output type (a still image cannot use a camera move).
 * `fixed` ids are held constant in every variation, so only the chosen axis changes.
 */
export function planVariations(
  base: string,
  options: { axis?: VaryAxis; count?: number; target?: "video" | "image"; fixed?: readonly string[]; maxLength?: number } = {}
): VariationPlan {
  const axis = options.axis && VARY_AXES.includes(options.axis) ? options.axis : "light";
  const target = options.target === "image" ? "image" : "video";
  const requested = Number.isInteger(options.count) ? (options.count as number) : 4;
  const count = Math.min(MAX_VARIATIONS, Math.max(MIN_VARIATIONS, requested));
  const text = typeof base === "string" ? base.trim() : "";
  if (!text) return { ok: false, axis, variations: [], problems: ["Write a base prompt first."] };

  const fixed = (options.fixed || []).filter(id => typeof id === "string");
  const pool = listPresets({ category: CATEGORY_FOR[axis], target }).filter(p => !fixed.includes(p.id));
  if (pool.length < MIN_VARIATIONS) {
    return { ok: false, axis, variations: [], problems: ["Not enough " + axis + " presets suit " + target + " output to compare."] };
  }

  const variations: Variation[] = [];
  for (const preset of pool) {
    if (variations.length >= count) break;
    const built = composePrompt(text, [...fixed, preset.id], { maxLength: options.maxLength ?? 1500 });
    if (built.dropped.includes(preset.id)) continue; // would not fit the length limit, so skip it
    variations.push({ index: variations.length + 1, presetId: preset.id, label: preset.name, prompt: built.prompt });
  }
  if (variations.length < MIN_VARIATIONS) {
    return { ok: false, axis, variations: [], problems: ["The base prompt is too long to add variations. Shorten it."] };
  }
  return { ok: true, axis, variations, problems: [] };
}
