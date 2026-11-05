// Quick Start: pick what you want to make, type a topic, get a complete draft
// (shot list, style, frame size, hooks, prompts and a publish checklist) in one step.
// Every template is original to this product. Pure and deterministic: nothing is
// generated or sent anywhere, and the user reviews the draft before it is added.

import { applyPresetToShot, getPreset, shotToPrompt, type ShotLike } from "./presets.ts";
import { BUILT_IN_KITS, kitPatch } from "./style-kit.ts";
import { FRAME_TARGETS } from "./frame-fit.ts";

export interface Beat {
  scene: string;
  /** Visual description. {topic} is replaced with the user's topic. */
  action: string;
  framingId: string;
  cameraId: string;
  /** Share of the total running time. */
  weight: number;
}

export interface QuickStartTemplate {
  id: string;
  name: string;
  tagline: string;
  /** Who it helps, in plain words. */
  forWho: string;
  defaultSeconds: number;
  frameTargetId: string;
  kitId: string;
  beats: Beat[];
  hooks: string[];
  checklist: string[];
}

export interface QuickStartShot extends ShotLike {
  presetIds: string[];
}

export interface QuickStartResult {
  ok: boolean;
  problems: string[];
  template?: { id: string; name: string };
  topic?: string;
  shots: QuickStartShot[];
  totalSeconds: number;
  frameTargetId?: string;
  frameLabel?: string;
  kitId?: string;
  hooks: string[];
  prompts: string[];
  checklist: string[];
}

export const MIN_TOPIC = 3;
export const MAX_TOPIC = 120;
export const MIN_SECONDS = 8;
export const MAX_SECONDS = 120;
const MIN_SHOT_SECONDS = 2;

const beat = (scene: string, action: string, framingId: string, cameraId: string, weight: number): Beat => ({ scene, action, framingId, cameraId, weight });

export const TEMPLATES: readonly QuickStartTemplate[] = Object.freeze([
  {
    id: "product-ad", name: "Product ad", tagline: "Stop the scroll, show the benefit, ask for the sale.",
    forWho: "Shops and makers selling something they can show.", defaultSeconds: 20, frameTargetId: "portrait-4x5", kitId: "clean-product",
    beats: [
      beat("Hook", "A striking close detail of {topic}, light catching its edges to stop the scroll.", "close-detail", "snap-zoom", 2),
      beat("The problem", "A real moment where life is harder without {topic}, shown in a simple everyday setting.", "over-the-shoulder", "handheld-drift", 3),
      beat("The reveal", "The full view of {topic} appears, clean and confident against a tidy background.", "centered-symmetry", "pull-back-reveal", 3),
      beat("The benefit", "A person using {topic} and clearly enjoying the result, in warm natural movement.", "portrait-tele", "slow-push-in", 4),
      beat("Call to action", "{topic} held in frame with room for a short line of text and your name or link.", "centered-symmetry", "locked-frame", 2)
    ],
    hooks: ["Still doing it the hard way? Meet {topic}.", "The one thing about {topic} nobody tells you.", "Why people are switching to {topic}.", "{topic} in 20 seconds."],
    checklist: ["Add your price or offer as on-screen text.", "Add captions so it works with the sound off.", "Check you have the right to use every image and track.", "Put one clear action at the end: order, message or visit."]
  },
  {
    id: "story-reel", name: "Short story reel", tagline: "A small story with a beginning, a turn and an ending.",
    forWho: "Creators who want a vertical story people watch to the end.", defaultSeconds: 30, frameTargetId: "vertical-9x16", kitId: "neon-night",
    beats: [
      beat("Opening", "A quiet establishing view of the place where {topic} begins.", "wide-establishing", "slow-push-in", 3),
      beat("The spark", "Our main character notices something about {topic} that changes the moment.", "close-detail", "focus-shift", 3),
      beat("The struggle", "The character pushes through a difficulty tied to {topic}, close and tense.", "low-angle-power", "handheld-drift", 4),
      beat("The turn", "A sudden shift: the answer to {topic} becomes clear.", "portrait-tele", "snap-zoom", 3),
      beat("The ending", "A calm, wide image that shows how things changed because of {topic}.", "high-angle-overview", "pull-back-reveal", 3)
    ],
    hooks: ["Nobody believed me about {topic}. Then this happened.", "This is the story of {topic}.", "What {topic} taught me in one day.", "Wait for the end: {topic}."],
    checklist: ["Add a voiceover or text so the story is clear on mute.", "Keep the first two seconds the most interesting.", "Check the ending leaves one clear feeling.", "Use only music and images you may use."]
  },
  {
    id: "podcast-teaser", name: "Podcast teaser", tagline: "A short clip that makes people press play.",
    forWho: "Podcasters and radio hosts promoting an episode.", defaultSeconds: 25, frameTargetId: "square-1x1", kitId: "warm-documentary",
    beats: [
      beat("Cold open", "The strongest line about {topic} appears as large text over a slow, calm image.", "centered-symmetry", "slow-push-in", 3),
      beat("The host", "The host in conversation about {topic}, warm and attentive.", "tight-two-shot", "locked-frame", 3),
      beat("The guest", "The guest answers with energy, the point about {topic} landing clearly.", "portrait-tele", "focus-shift", 4),
      beat("The highlight", "A moving waveform and a bold quote about {topic}.", "close-detail", "slow-push-in", 3),
      beat("Listen now", "The episode title, \"{topic}\", with your show name and where to listen, over a calm background.", "centered-symmetry", "locked-frame", 2)
    ],
    hooks: ["The part of this episode about {topic} surprised me.", "One honest answer about {topic}.", "New episode: {topic}.", "You will want to hear this on {topic}."],
    checklist: ["Add captions; most people watch on mute.", "Put the episode name and where to listen on screen.", "Get permission from the guest to share the clip.", "Keep the best line in the first three seconds."]
  },
  {
    id: "quick-explainer", name: "Quick explainer", tagline: "Explain one idea clearly in under a minute.",
    forWho: "Teachers, health workers and organisations sharing useful information.", defaultSeconds: 45, frameTargetId: "landscape-16x9", kitId: "clean-product",
    beats: [
      beat("The question", "A simple, curious image that asks the question about {topic}.", "wide-establishing", "slow-push-in", 3),
      beat("Why it matters", "A relatable scene that shows why {topic} matters to ordinary people.", "over-the-shoulder", "side-glide", 4),
      beat("Step one", "A clear, well lit demonstration of the first step of {topic}.", "close-detail", "locked-frame", 4),
      beat("Step two", "The second step of {topic}, shown the same way so it is easy to follow.", "close-detail", "locked-frame", 4),
      beat("Step three", "The third step of {topic}, ending with a visible result.", "high-angle-overview", "pull-back-reveal", 4),
      beat("Recap", "The three steps of {topic} summarised on screen, with where to learn more.", "centered-symmetry", "locked-frame", 3)
    ],
    hooks: ["{topic} explained in under a minute.", "Three simple steps for {topic}.", "Everything you need to know about {topic}.", "Do you really understand {topic}?"],
    checklist: ["Check every fact and number before you publish.", "Add captions and keep text large enough for a phone.", "Say where people can learn more.", "Use clear words; avoid jargon."]
  },
  {
    id: "event-promo", name: "Event promo", tagline: "Build excitement and make the date impossible to miss.",
    forWho: "Churches, schools, clubs and promoters filling a room.", defaultSeconds: 20, frameTargetId: "vertical-9x16", kitId: "neon-night",
    beats: [
      beat("The tease", "Quick glimpses of energy and anticipation around {topic}.", "close-detail", "blur-whip", 3),
      beat("The place", "The venue for {topic}, welcoming and full of life.", "wide-establishing", "side-glide", 3),
      beat("The highlights", "People enjoying the best moments of {topic}, smiling and moving.", "low-angle-power", "handheld-drift", 4),
      beat("The details", "Date, time and place for {topic} as big, simple text.", "centered-symmetry", "locked-frame", 3),
      beat("Join us", "An open invitation to {topic}, with how to reserve a spot.", "portrait-tele", "slow-push-in", 2)
    ],
    hooks: ["You are invited: {topic}.", "Mark the date: {topic}.", "Don't miss {topic}.", "{topic} is coming. Bring a friend."],
    checklist: ["Show the date, time and place clearly, and keep them on screen long enough to read.", "Add a way to reserve or ask a question.", "Get permission before showing people's faces.", "Post a reminder the day before."]
  },
  {
    id: "brand-story", name: "Our story", tagline: "Show the people and purpose behind what you do.",
    forWho: "Founders, community projects and small businesses building trust.", defaultSeconds: 40, frameTargetId: "landscape-16x9", kitId: "warm-documentary",
    beats: [
      beat("Where we started", "The humble place where {topic} began, honest and unpolished.", "wide-establishing", "slow-push-in", 4),
      beat("Why we care", "A face and a hand at work on {topic}, showing real commitment.", "portrait-tele", "focus-shift", 4),
      beat("The work", "The daily work behind {topic}, in natural light and movement.", "over-the-shoulder", "handheld-drift", 4),
      beat("The people", "The people {topic} serves, shown with dignity and warmth.", "tight-two-shot", "side-glide", 4),
      beat("What comes next", "A wide, hopeful view of the future of {topic}, with how to support it.", "high-angle-overview", "pull-back-reveal", 3)
    ],
    hooks: ["Why we started {topic}.", "The people behind {topic}.", "This is what {topic} really looks like.", "Our story: {topic}."],
    checklist: ["Use real people and places; trust matters most here.", "Get written permission from everyone shown.", "Say clearly how people can help or get involved.", "Add captions and your name or logo."]
  }
]);

const BY_ID: ReadonlyMap<string, QuickStartTemplate> = new Map(TEMPLATES.map(t => [t.id, t]));

export function getTemplate(id: string): QuickStartTemplate | undefined {
  return BY_ID.get(id);
}

/** Collapse whitespace, remove control characters, and bound the length. */
export function cleanTopic(input: unknown): string {
  return String(input ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC);
}

const fill = (text: string, topic: string) => text.replace(/\{topic\}/g, topic);

/** Split a total across beats by weight: whole seconds, none under the minimum, summing exactly. */
export function splitSeconds(total: number, weights: readonly number[]): number[] {
  const count = weights.length;
  if (!count) return [];
  const sum = weights.reduce((a, b) => a + b, 0) || count;
  const seconds = weights.map(w => Math.max(MIN_SHOT_SECONDS, Math.round((total * w) / sum)));
  let diff = total - seconds.reduce((a, b) => a + b, 0);
  // Fix rounding drift on the longest shots first, never below the minimum.
  const order = seconds.map((_, i) => i).sort((a, b) => seconds[b] - seconds[a]);
  let guard = 0;
  while (diff !== 0 && guard++ < 1000) {
    for (const i of order) {
      if (diff === 0) break;
      if (diff > 0) { seconds[i] += 1; diff -= 1; }
      else if (seconds[i] > MIN_SHOT_SECONDS) { seconds[i] -= 1; diff += 1; }
    }
  }
  return seconds;
}

export function buildQuickStart(input: { templateId?: string; topic?: unknown; seconds?: unknown } = {}): QuickStartResult {
  const empty = (problems: string[]): QuickStartResult => ({ ok: false, problems, shots: [], totalSeconds: 0, hooks: [], prompts: [], checklist: [] });
  const template = getTemplate(String(input.templateId ?? ""));
  if (!template) return empty(["Choose what you want to make."]);
  const topic = cleanTopic(input.topic);
  if (topic.length < MIN_TOPIC) return empty(["Type a topic of at least " + MIN_TOPIC + " characters, for example the name of your product, show or event."]);
  const requested = input.seconds === undefined || input.seconds === "" ? template.defaultSeconds : Number(input.seconds);
  if (!Number.isFinite(requested)) return empty(["Length must be a number of seconds."]);
  const floor = Math.max(MIN_SECONDS, template.beats.length * MIN_SHOT_SECONDS);
  const total = Math.min(MAX_SECONDS, Math.max(floor, Math.round(requested)));
  const kit = BUILT_IN_KITS.find(k => k.id === template.kitId);
  const target = FRAME_TARGETS.find(t => t.id === template.frameTargetId);
  const durations = splitSeconds(total, template.beats.map(b => b.weight));

  const shots: QuickStartShot[] = template.beats.map((b, i) => {
    let fields: ShotLike = { scene: b.scene, action: fill(b.action, topic).slice(0, 4000), camera: "", lens: "", movement: "", lighting: "", duration: durations[i] };
    const presetIds: string[] = [];
    for (const id of [b.framingId, b.cameraId]) {
      const preset = getPreset(id);
      if (!preset) continue;
      fields = { ...fields, ...applyPresetToShot(fields, preset) };
      presetIds.push(id);
    }
    if (kit) {
      fields = { ...fields, ...kitPatch(fields, kit) };
      presetIds.push(...kit.presetIds);
    }
    return { ...fields, presetIds };
  });

  const problems: string[] = [];
  if (requested !== total) problems.push("Length was set to " + total + " seconds so every shot has room to breathe.");
  return {
    ok: true, problems, template: { id: template.id, name: template.name }, topic, shots,
    totalSeconds: shots.reduce((a, s) => a + s.duration, 0),
    frameTargetId: template.frameTargetId, frameLabel: target ? target.label : template.frameTargetId, kitId: template.kitId,
    hooks: template.hooks.map(h => fill(h, topic)),
    prompts: shots.map(s => shotToPrompt(s)),
    checklist: [...template.checklist]
  };
}
