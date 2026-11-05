// Style kits: a named bundle of lighting and look presets applied to every shot,
// so a whole storyboard keeps one consistent visual identity.

import { applyPresetToShot, composePrompt, getPreset, type ShotLike, type ShotPatch } from "./presets.ts";

export interface StyleKit {
  id: string;
  name: string;
  summary: string;
  /** Light and look preset ids, applied in order. */
  presetIds: string[];
  builtIn: boolean;
}

export const MAX_KIT_PRESETS = 6;
export const MAX_CUSTOM_KITS = 12;

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const kit = (id: string, name: string, summary: string, presetIds: string[]): StyleKit => ({ id, name, summary, presetIds, builtIn: true });

/** Written for this product; ids point at presets that already exist in the library. */
export const BUILT_IN_KITS: readonly StyleKit[] = Object.freeze(
  ([
    kit("warm-documentary", "Warm documentary", "Soft natural light and an honest, grounded look.", ["warm-golden-hour", "muted-documentary"]),
    kit("neon-night", "Neon night", "Colored practical light and a high-contrast night look.", ["neon-night", "teal-amber-grade"]),
    kit("clean-product", "Clean product", "Even studio light and a crisp commercial look.", ["soft-studio-key", "clean-commercial"])
  ] as StyleKit[]).map(item => ({ ...item, presetIds: item.presetIds.filter(id => !!getPreset(id)) }))
);

export function validateKit(input: unknown): { ok: boolean; kit?: StyleKit; problems: string[] } {
  const problems: string[] = [];
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 40) problems.push("Give the kit a name of up to 40 characters.");
  const ids = Array.isArray(raw.presetIds) ? raw.presetIds.filter((x): x is string => typeof x === "string") : [];
  const unique = [...new Set(ids)];
  if (!unique.length) problems.push("Pick at least one light or look preset.");
  if (unique.length > MAX_KIT_PRESETS) problems.push("A kit holds at most " + MAX_KIT_PRESETS + " presets.");
  const bad = unique.filter(id => { const p = getPreset(id); return !p || (p.category !== "light" && p.category !== "look"); });
  if (bad.length) problems.push("Only light and look presets can go in a kit: " + bad.join(", ") + ".");
  if (problems.length) return { ok: false, problems };
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const id = typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : (slug || "kit");
  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, 120) : "";
  return { ok: true, problems: [], kit: { id, name, summary, presetIds: unique, builtIn: false } };
}

/** Patch for one shot after all of the kit's presets. A look replaces the previous look. */
export function kitPatch(shot: ShotLike, styleKit: StyleKit): ShotPatch {
  let current: ShotLike = { ...shot };
  let patch: ShotPatch = {};
  for (const id of styleKit.presetIds) {
    const preset = getPreset(id);
    if (!preset) continue;
    const next = applyPresetToShot(current, preset);
    patch = { ...patch, ...next };
    current = { ...current, ...next };
  }
  return patch;
}

export function applyKitToShots<T extends ShotLike>(shots: readonly T[], styleKit: StyleKit): T[] {
  return shots.map(shot => ({ ...shot, ...kitPatch(shot, styleKit) }));
}

/** Prompt text for an image or a video: base prompt plus the kit's fragments. */
export function kitPrompt(base: string, styleKit: StyleKit, maxLength = 1500) {
  return composePrompt(base, styleKit.presetIds, { maxLength });
}
