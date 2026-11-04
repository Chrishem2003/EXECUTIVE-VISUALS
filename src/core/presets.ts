// Original preset library: camera moves, framing, light and look.
// Every name and description here is written for this product. Presets are plain
// data plus pure helpers, so they can be tested without a browser or a provider.

export type PresetCategory = "camera" | "framing" | "light" | "look";
export type PresetTarget = "video" | "image" | "both";

export interface Preset {
  id: string;
  name: string;
  category: PresetCategory;
  applies: PresetTarget;
  summary: string;
  /** Prompt fragment appended to a generation prompt. */
  prompt: string;
  /** Shot-field values written when the preset is applied to a storyboard shot. */
  movement?: string;
  camera?: string;
  lens?: string;
  lighting?: string;
  /** Suggested clip length for camera moves, in seconds. */
  seconds?: { min: number; max: number };
  tags: string[];
}

export interface ShotLike {
  scene: string;
  action: string;
  camera: string;
  lens: string;
  movement: string;
  lighting: string;
  duration: number;
}

export type ShotPatch = Partial<Pick<ShotLike, "camera" | "lens" | "movement" | "lighting">>;

/** Field limits mirror the server's workspace document validation. */
export const SHOT_FIELD_LIMITS = { camera: 300, lens: 120, movement: 300, lighting: 500 } as const;

export const CATEGORY_LABELS: Record<PresetCategory, string> = {
  camera: "Camera move",
  framing: "Framing",
  light: "Light & mood",
  look: "Look"
};

export const CATEGORY_ORDER: PresetCategory[] = ["camera", "framing", "light", "look"];

type Def = Omit<Preset, "applies" | "tags"> & { applies?: PresetTarget; tags?: string[] };
const def = (p: Def): Preset => ({ applies: p.category === "camera" ? "video" : "both", tags: [], ...p });

export const PRESETS: readonly Preset[] = Object.freeze([
  // ---- Camera moves (video) ----
  def({ id: "slow-push-in", name: "Slow Push-In", category: "camera", summary: "A gentle glide toward the subject that builds closeness and focus.", movement: "Slow push-in: steady glide toward the subject", prompt: "slow, smooth push-in toward the subject, steady and gentle, background softly compressing", seconds: { min: 4, max: 8 }, tags: ["intimate", "calm"] }),
  def({ id: "pull-back-reveal", name: "Pull-Back Reveal", category: "camera", summary: "Start tight on a detail, then retreat to show the full setting.", movement: "Pull-back reveal: begin on a detail, retreat to the wide scene", prompt: "begins tight on a small detail then pulls back smoothly to reveal the whole environment", seconds: { min: 4, max: 8 }, tags: ["reveal", "establishing"] }),
  def({ id: "orbit-sweep", name: "Orbit Sweep", category: "camera", summary: "The camera circles the subject, showing it from every side.", movement: "Orbit sweep: camera circles the subject", prompt: "camera orbits around the subject in a smooth arc, subject stays centered, background rotating behind", seconds: { min: 5, max: 10 }, tags: ["hero", "product"] }),
  def({ id: "snap-zoom", name: "Snap Zoom", category: "camera", summary: "A fast punch toward the subject for emphasis on a beat.", movement: "Snap zoom: fast punch-in on the subject", prompt: "sudden fast zoom-in on the subject for emphasis, crisp and energetic", seconds: { min: 2, max: 4 }, tags: ["energy", "beat"] }),
  def({ id: "stretch-pull", name: "Stretch Pull", category: "camera", summary: "Backing away while zooming in, so the background seems to stretch.", movement: "Stretch pull: move back while zooming in, background stretches", prompt: "camera moves backward while zooming in so the background appears to stretch behind the subject, unsettling and dramatic", seconds: { min: 3, max: 6 }, tags: ["tension", "drama"] }),
  def({ id: "high-drop", name: "High Drop", category: "camera", summary: "Descend from an overhead angle down to eye level.", movement: "High drop: descend from overhead to eye level", prompt: "camera descends from a high overhead angle down to eye level, smooth and controlled", seconds: { min: 4, max: 8 }, tags: ["establishing", "scale"] }),
  def({ id: "ground-rise", name: "Ground Rise", category: "camera", summary: "Start near the floor and lift up to reveal the subject.", movement: "Ground rise: start low and rise up to reveal the subject", prompt: "camera starts close to the ground and rises steadily upward to reveal the subject standing tall", seconds: { min: 4, max: 7 }, tags: ["hero", "reveal"] }),
  def({ id: "blur-whip", name: "Blur Whip", category: "camera", summary: "A rapid sideways swing with motion blur, ideal for transitions.", movement: "Blur whip: rapid pan with motion blur", prompt: "very fast horizontal camera whip with heavy motion blur, as a transition between two scenes", seconds: { min: 1, max: 3 }, tags: ["transition", "energy"] }),
  def({ id: "handheld-drift", name: "Handheld Drift", category: "camera", summary: "A subtle, human sway that feels observed and real.", movement: "Handheld drift: subtle natural camera sway", prompt: "handheld camera with subtle natural sway, documentary realism, slightly imperfect framing", seconds: { min: 4, max: 10 }, tags: ["documentary", "natural"] }),
  def({ id: "side-glide", name: "Side Glide", category: "camera", summary: "Smooth lateral tracking that keeps pace beside the subject.", movement: "Side glide: smooth lateral tracking beside the subject", prompt: "smooth lateral tracking shot moving alongside the subject at the same pace", seconds: { min: 4, max: 8 }, tags: ["walking", "smooth"] }),
  def({ id: "trail-follow", name: "Trail Follow", category: "camera", summary: "Follow from behind as the subject moves forward.", movement: "Trail follow: camera follows behind the moving subject", prompt: "camera follows closely behind the subject as they move forward, steady over-the-back view", seconds: { min: 4, max: 9 }, tags: ["journey", "pursuit"] }),
  def({ id: "lift-and-tilt", name: "Lift and Tilt", category: "camera", summary: "Rise vertically while tilting down to look back at the scene.", movement: "Lift and tilt: rise vertically while tilting down", prompt: "camera rises vertically on a crane while tilting down to look over the scene below", seconds: { min: 5, max: 9 }, tags: ["scale", "cinematic"] }),
  def({ id: "focus-shift", name: "Focus Shift", category: "camera", summary: "Attention moves from foreground to background by pulling focus.", movement: "Focus shift: pull focus between foreground and background", prompt: "shallow depth of field, focus smoothly shifts from the foreground element to the subject behind it", seconds: { min: 3, max: 6 }, tags: ["story", "detail"] }),
  def({ id: "base-to-top", name: "Base-to-Top Tilt", category: "camera", summary: "A vertical tilt from the bottom of something tall to its top.", movement: "Base-to-top tilt: tilt up from the base to the top", prompt: "camera tilts upward from the base to the top of the subject, emphasizing height and presence", seconds: { min: 3, max: 6 }, tags: ["architecture", "hero"] }),
  def({ id: "pass-through", name: "Pass-Through", category: "camera", summary: "Glide through an opening or gap into the next space.", movement: "Pass-through: glide through an opening into a new space", prompt: "camera glides forward through a doorway or gap into a new space, revealing it as it passes", seconds: { min: 4, max: 8 }, tags: ["transition", "immersive"] }),
  def({ id: "frozen-moment-arc", name: "Frozen-Moment Arc", category: "camera", summary: "Time seems to stop while the camera arcs around the subject.", movement: "Frozen-moment arc: action freezes while the camera arcs around", prompt: "the action appears frozen mid-motion while the camera sweeps in a wide arc around the subject", seconds: { min: 3, max: 6 }, tags: ["dramatic", "slow-motion"] }),
  def({ id: "locked-frame", name: "Locked Frame", category: "camera", summary: "A fixed tripod view where only the subject moves.", movement: "Locked frame: static camera, only the subject moves", prompt: "completely static locked-off camera, motion comes only from the subject", seconds: { min: 3, max: 10 }, tags: ["calm", "formal"] }),
  def({ id: "tilted-horizon-roll", name: "Tilted Horizon Roll", category: "camera", summary: "A slow roll that tips the horizon for unease.", movement: "Tilted horizon roll: slow roll that tips the horizon", prompt: "camera slowly rolls so the horizon tilts, creating unease and tension", seconds: { min: 3, max: 6 }, tags: ["tension", "stylized"] }),
  def({ id: "layer-slide", name: "Layer Slide", category: "camera", summary: "A sideways slide that makes foreground and background layers separate.", movement: "Layer slide: lateral slide emphasizing depth layers", prompt: "camera slides sideways so foreground, midground and background shift at different speeds, strong parallax depth", seconds: { min: 4, max: 8 }, tags: ["depth", "elegant"] }),
  def({ id: "low-hero-approach", name: "Low Hero Approach", category: "camera", summary: "A low angle moving toward a figure to make them look powerful.", movement: "Low hero approach: low angle moving toward the subject", prompt: "low-angle camera moves toward the subject, making them appear powerful and imposing against the sky", seconds: { min: 3, max: 7 }, tags: ["hero", "power"] }),

  // ---- Framing (video + image) ----
  def({ id: "wide-establishing", name: "Wide Establishing", category: "framing", summary: "Show the full place and where the subject sits in it.", camera: "Wide establishing shot", lens: "24mm wide angle", prompt: "wide establishing composition showing the full environment, subject small within the scene, 24mm wide-angle lens" }),
  def({ id: "close-detail", name: "Close Detail", category: "framing", summary: "A tight view of texture, hands or a small object.", camera: "Close-up on detail", lens: "100mm macro", prompt: "extreme close-up on fine detail and texture, 100mm macro lens, very shallow depth of field" }),
  def({ id: "portrait-tele", name: "Portrait Tele", category: "framing", summary: "Flattering head-and-shoulders framing with a soft background.", camera: "Head-and-shoulders portrait", lens: "85mm portrait", prompt: "flattering head-and-shoulders portrait, 85mm lens, creamy out-of-focus background" }),
  def({ id: "over-the-shoulder", name: "Over-the-Shoulder", category: "framing", summary: "Frame one person from behind another for conversations.", camera: "Over-the-shoulder shot", lens: "50mm", prompt: "over-the-shoulder composition, foreground shoulder softly blurred, focus on the person facing the camera" }),
  def({ id: "centered-symmetry", name: "Centered Symmetry", category: "framing", summary: "Perfectly balanced, centered composition.", camera: "Centered symmetrical shot", lens: "35mm", prompt: "perfectly symmetrical centered composition, strong leading lines, balanced and deliberate" }),
  def({ id: "low-angle-power", name: "Low Angle Power", category: "framing", summary: "Camera below the subject to add stature.", camera: "Low-angle shot", lens: "28mm", prompt: "low-angle composition looking up at the subject, adding stature and dominance" }),
  def({ id: "high-angle-overview", name: "High Angle Overview", category: "framing", summary: "Look down to show layout, scale or vulnerability.", camera: "High-angle overview", lens: "35mm", prompt: "high-angle view looking down at the scene, clear layout and scale" }),
  def({ id: "tight-two-shot", name: "Tight Two-Shot", category: "framing", summary: "Two subjects close together in one frame.", camera: "Two-shot, medium close", lens: "50mm", prompt: "two subjects close together in one frame, medium close-up, natural interaction" }),

  // ---- Light and mood (video + image) ----
  def({ id: "warm-golden-hour", name: "Warm Golden Hour", category: "light", summary: "Low, warm sun with long soft shadows.", lighting: "Golden hour: low warm sun, long soft shadows, gentle rim light", prompt: "golden hour lighting, low warm sun, long soft shadows, gentle rim light on the subject" }),
  def({ id: "blue-hour-calm", name: "Blue Hour Calm", category: "light", summary: "Cool twilight with a quiet, reflective feel.", lighting: "Blue hour: cool twilight, soft ambient glow", prompt: "blue hour twilight, cool tones, soft ambient glow, quiet reflective mood" }),
  def({ id: "neon-night", name: "Neon Night", category: "light", summary: "Saturated colored signs reflecting on wet surfaces.", lighting: "Neon night: colored practical lights, wet reflections", prompt: "night scene lit by saturated neon signs, colored reflections on wet surfaces, deep shadows" }),
  def({ id: "soft-studio-key", name: "Soft Studio Key", category: "light", summary: "Clean, flattering studio light with gentle fill.", lighting: "Soft studio key light with gentle fill and subtle rim", prompt: "clean soft studio lighting, large key light, gentle fill, subtle rim light, neutral backdrop" }),
  def({ id: "hard-noon-contrast", name: "Hard Noon Contrast", category: "light", summary: "Strong overhead sun with sharp shadows.", lighting: "Midday sun: hard overhead light, sharp shadows, high contrast", prompt: "harsh midday sun, hard shadows, high contrast, bright highlights" }),
  def({ id: "moody-low-key", name: "Moody Low-Key", category: "light", summary: "Mostly shadow with one deliberate light source.", lighting: "Low-key: single directional source, deep shadows", prompt: "low-key lighting, mostly shadow, a single directional light source, dramatic and moody" }),
  def({ id: "overcast-even", name: "Overcast Even", category: "light", summary: "Flat, diffused light that is easy on skin and color.", lighting: "Overcast: soft diffused light, minimal shadows", prompt: "overcast sky, soft diffused light, minimal shadows, natural true-to-life color" }),
  def({ id: "candle-glow", name: "Candle Glow", category: "light", summary: "Intimate flickering warm light.", lighting: "Candlelight: warm flickering glow, intimate falloff", prompt: "lit only by candles, warm flickering glow, intimate falloff into darkness" }),

  // ---- Look (video + image) ----
  def({ id: "film-grain-35", name: "Film Grain 35", category: "look", summary: "Organic grain and gentle halation like photographed film.", prompt: "shot on 35mm film, organic grain, gentle halation, rich natural color" }),
  def({ id: "clean-commercial", name: "Clean Commercial", category: "look", summary: "Bright, crisp, polished advertising finish.", prompt: "bright clean commercial look, crisp detail, polished color, high clarity" }),
  def({ id: "muted-documentary", name: "Muted Documentary", category: "look", summary: "Desaturated, honest, observational color.", prompt: "muted documentary look, desaturated natural color, honest and observational" }),
  def({ id: "ink-black-and-white", name: "Ink Black & White", category: "look", summary: "High-contrast monochrome with deep blacks.", prompt: "high-contrast black and white, deep blacks, bright highlights, fine grain" }),
  def({ id: "pastel-dream", name: "Pastel Dream", category: "look", summary: "Soft pastel palette with a gentle glow.", prompt: "soft pastel color palette, dreamy glow, airy and gentle" }),
  def({ id: "retro-tape", name: "Retro Tape", category: "look", summary: "Soft, slightly noisy home-video nostalgia.", prompt: "retro videotape look, soft edges, slight color bleed and noise, nostalgic home-video feel" }),
  def({ id: "vivid-social-pop", name: "Vivid Social Pop", category: "look", summary: "Punchy saturated color tuned for small screens.", prompt: "vivid saturated colors, punchy contrast, bold and eye-catching for mobile screens" }),
  def({ id: "teal-amber-grade", name: "Teal-Amber Grade", category: "look", summary: "Cool shadows with warm skin and highlights.", prompt: "cinematic color grade, teal shadows, warm amber highlights, filmic contrast" })
]);

const BY_ID: ReadonlyMap<string, Preset> = new Map(PRESETS.map(p => [p.id, p]));

export function getPreset(id: string): Preset | undefined {
  return BY_ID.get(id);
}

export interface PresetFilter {
  category?: PresetCategory | "all";
  /** "video" keeps video and both; "image" keeps image and both. */
  target?: "video" | "image";
  query?: string;
}

export function listPresets(filter: PresetFilter = {}): Preset[] {
  const q = (filter.query ?? "").trim().toLowerCase();
  return PRESETS.filter(p => {
    if (filter.category && filter.category !== "all" && p.category !== filter.category) return false;
    if (filter.target && p.applies !== "both" && p.applies !== filter.target) return false;
    if (!q) return true;
    return (p.name + " " + p.summary + " " + p.tags.join(" ") + " " + CATEGORY_LABELS[p.category]).toLowerCase().includes(q);
  });
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max).trimEnd();
}

/**
 * Append preset prompt fragments to a base prompt. Fragments are ordered
 * camera -> framing -> light -> look, duplicates are dropped, unknown ids are
 * reported instead of silently ignored, and whole fragments are dropped (never
 * cut in half) when a length limit is given.
 */
export function composePrompt(base: string, ids: readonly string[], opts: { maxLength?: number } = {}): { prompt: string; unknown: string[]; dropped: string[] } {
  const unknown: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  const chosen: Preset[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const p = BY_ID.get(id);
    if (p) chosen.push(p); else unknown.push(id);
  }
  chosen.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  let prompt = base.trim();
  for (const p of chosen) {
    if (prompt.toLowerCase().includes(p.prompt.toLowerCase())) continue;
    const next = prompt ? prompt.replace(/[.,;\s]+$/, "") + ", " + p.prompt : p.prompt;
    if (opts.maxLength !== undefined && next.length > opts.maxLength) { dropped.push(p.id); continue; }
    prompt = next;
  }
  return { prompt, unknown, dropped };
}

/** Fields to write onto a shot when a preset is applied to it. */
export function applyPresetToShot(shot: Pick<ShotLike, "lighting">, preset: Preset): ShotPatch {
  switch (preset.category) {
    case "camera":
      return preset.movement ? { movement: clip(preset.movement, SHOT_FIELD_LIMITS.movement) } : {};
    case "framing": {
      const patch: ShotPatch = {};
      if (preset.camera) patch.camera = clip(preset.camera, SHOT_FIELD_LIMITS.camera);
      if (preset.lens) patch.lens = clip(preset.lens, SHOT_FIELD_LIMITS.lens);
      return patch;
    }
    case "light":
      return preset.lighting ? { lighting: clip(preset.lighting, SHOT_FIELD_LIMITS.lighting) } : {};
    case "look": {
      const tag = "Look: " + preset.name;
      if (shot.lighting.includes(tag)) return {};
      const base = shot.lighting.replace(/\s*·\s*Look: [^·]*$/, "").trim();
      return { lighting: clip((base ? base + " · " : "") + tag, SHOT_FIELD_LIMITS.lighting) };
    }
  }
}

/** Turn a storyboard shot into a single generation prompt. */
export function shotToPrompt(shot: ShotLike): string {
  const parts = [
    shot.scene.trim(),
    shot.action.trim(),
    "Camera: " + [shot.camera, shot.lens].filter(Boolean).join(", "),
    shot.movement ? "Movement: " + shot.movement : "",
    shot.lighting ? "Lighting: " + shot.lighting : "",
    shot.duration > 0 ? "Duration: " + shot.duration + " seconds" : ""
  ];
  return parts.filter(Boolean).join(". ").replace(/\.\s*\./g, ".");
}
