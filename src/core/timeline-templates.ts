import { addTrack, createTimeline, validateTimeline, type EditorialTimeline, type TimelineTrack } from "./timeline.ts";

export interface TimelineTemplate {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  frameRate: number;
  tracks: ReadonlyArray<Pick<TimelineTrack, "id" | "name" | "kind">>;
}

export const TIMELINE_TEMPLATES: readonly TimelineTemplate[] = [
  { id: "vertical-short", name: "Vertical short", description: "9:16 social video with picture, overlays, captions and sound.", width: 1080, height: 1920, frameRate: 30, tracks: [{ id: "picture", name: "Picture", kind: "video" }, { id: "overlay", name: "Graphics", kind: "overlay" }, { id: "captions", name: "Captions", kind: "caption" }, { id: "sound", name: "Sound", kind: "audio" }] },
  { id: "cinematic-4k", name: "Cinematic 4K", description: "16:9 4K finishing sequence at 24 fps.", width: 3840, height: 2160, frameRate: 24, tracks: [{ id: "picture", name: "Picture", kind: "video" }, { id: "graphics", name: "Graphics", kind: "overlay" }, { id: "dialogue", name: "Dialogue", kind: "audio" }, { id: "music", name: "Music and effects", kind: "audio" }, { id: "captions", name: "Captions", kind: "caption" }] },
  { id: "podcast", name: "Podcast / interview", description: "Presenter-led 16:9 edit with dedicated camera, graphics, dialogue, music and captions.", width: 1920, height: 1080, frameRate: 30, tracks: [{ id: "camera", name: "Camera", kind: "video" }, { id: "broll", name: "B-roll", kind: "video" }, { id: "graphics", name: "Names and graphics", kind: "overlay" }, { id: "dialogue", name: "Dialogue", kind: "audio" }, { id: "music", name: "Music", kind: "audio" }, { id: "captions", name: "Captions", kind: "caption" }] },
  { id: "product-demo", name: "Product demo", description: "16:9 screen or product footage with callouts, narration and music.", width: 1920, height: 1080, frameRate: 30, tracks: [{ id: "screen", name: "Screen / product", kind: "video" }, { id: "broll", name: "Cutaways", kind: "video" }, { id: "callouts", name: "Callouts", kind: "overlay" }, { id: "voice", name: "Narration", kind: "audio" }, { id: "music", name: "Music", kind: "audio" }, { id: "captions", name: "Captions", kind: "caption" }] },
  { id: "square-social", name: "Square social", description: "1:1 social feed edit with graphics, captions and audio.", width: 1080, height: 1080, frameRate: 30, tracks: [{ id: "picture", name: "Picture", kind: "video" }, { id: "graphics", name: "Graphics", kind: "overlay" }, { id: "captions", name: "Captions", kind: "caption" }, { id: "sound", name: "Sound", kind: "audio" }] }
];

export function getTimelineTemplate(id: string): TimelineTemplate | undefined {
  return TIMELINE_TEMPLATES.find(template => template.id === id);
}

export function createTimelineFromTemplate(templateId: string, projectId: string, id: string, name?: string): EditorialTimeline {
  const template = getTimelineTemplate(templateId);
  if (!template) throw new Error("Unknown timeline template.");
  let timeline = createTimeline(projectId, id, name || template.name, { numerator: template.frameRate, denominator: 1 });
  timeline = { ...timeline, width: template.width, height: template.height, metadata: { ...timeline.metadata, templateId: template.id, templateVersion: 1 } };
  for (const track of template.tracks) {
    timeline = addTrack(timeline, { id: id + "-" + track.id, name: track.name, kind: track.kind, enabled: true, locked: false, clips: [] });
  }
  const validation = validateTimeline(timeline);
  if (!validation.valid) throw new Error(validation.issues[0].message);
  return timeline;
}
