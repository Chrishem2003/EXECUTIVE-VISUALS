// Turn a storyboard into files a team can read, print or open in a spreadsheet.
// Pure functions only: no browser, network or provider is involved.

export interface ExportShot {
  scene: string;
  action: string;
  camera: string;
  lens: string;
  movement: string;
  lighting: string;
  duration: number;
}

export type ExportFormat = "markdown" | "csv" | "timing" | "json";
export const EXPORT_FORMATS: readonly ExportFormat[] = Object.freeze(["markdown", "csv", "timing", "json"]);
export const MAX_EXPORT_SHOTS = 200;

const text = (value: unknown, max = 4000) => String(value ?? "").replace(/\r\n?/g, "\n").slice(0, max);
const seconds = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n * 10) / 10, 3600) : 0;
};

/** Normalise untrusted shot objects; drops non-objects and caps the count. */
export function cleanShots(input: unknown): ExportShot[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_EXPORT_SHOTS).filter(item => item && typeof item === "object").map(item => {
    const s = item as Record<string, unknown>;
    return {
      scene: text(s.scene, 200), action: text(s.action), camera: text(s.camera, 300), lens: text(s.lens, 120),
      movement: text(s.movement, 300), lighting: text(s.lighting, 500), duration: seconds(s.duration)
    };
  });
}

/** "00:01:05.5" style clock for a running total. */
export function clock(totalSeconds: number): string {
  const whole = Math.floor(totalSeconds);
  const tenth = Math.round((totalSeconds - whole) * 10);
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return pad(h) + ":" + pad(m) + ":" + pad(s) + (tenth ? "." + tenth : "");
}

/** Start and end time for each shot, back to back. */
export function timeline(shots: ExportShot[]): Array<{ start: number; end: number }> {
  let at = 0;
  return shots.map(shot => {
    const start = at;
    at = Math.round((at + shot.duration) * 10) / 10;
    return { start, end: at };
  });
}

/** Spreadsheet programs run cells that start with these characters as formulas. */
const csvCell = (value: unknown): string => {
  let v = String(value ?? "").replace(/\r?\n/g, " ");
  if (/^[=+\-@\t]/.test(v)) v = "'" + v;
  return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};

function toMarkdown(shots: ExportShot[], title: string): string {
  const times = timeline(shots);
  const total = times.length ? times[times.length - 1].end : 0;
  const lines = ["# " + (title || "Storyboard"), "", shots.length + " shots · " + clock(total) + " total", ""];
  shots.forEach((s, i) => {
    lines.push("## Shot " + (i + 1) + " — " + (s.scene || "Untitled scene"), "", "- Time: " + clock(times[i].start) + " → " + clock(times[i].end) + " (" + s.duration + " s)");
    if (s.camera) lines.push("- Camera: " + s.camera);
    if (s.lens) lines.push("- Lens: " + s.lens);
    if (s.movement) lines.push("- Movement: " + s.movement);
    if (s.lighting) lines.push("- Lighting: " + s.lighting);
    lines.push("", s.action || "(no action written)", "");
  });
  return lines.join("\n");
}

function toCsv(shots: ExportShot[]): string {
  const times = timeline(shots);
  const header = ["Shot", "Scene", "Start", "End", "Seconds", "Action", "Camera", "Lens", "Movement", "Lighting"];
  const rows = shots.map((s, i) => [i + 1, s.scene, clock(times[i].start), clock(times[i].end), s.duration, s.action, s.camera, s.lens, s.movement, s.lighting]);
  return [header, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Plain cue list for an editor: number, start --> end, one-line description. */
function toTiming(shots: ExportShot[]): string {
  const times = timeline(shots);
  return shots.map((s, i) => (i + 1) + "\n" + clock(times[i].start) + " --> " + clock(times[i].end) + "\n" +
    (s.scene ? s.scene + ": " : "") + s.action.replace(/\s+/g, " ").slice(0, 160) + "\n").join("\n");
}

export function exportStoryboard(input: unknown, format: ExportFormat, title = ""): { ok: boolean; content: string; mime: string; extension: string; shots: number; problems: string[] } {
  const none = (problem: string) => ({ ok: false, content: "", mime: "text/plain", extension: "txt", shots: 0, problems: [problem] });
  if (!EXPORT_FORMATS.includes(format)) return none("Choose markdown, csv, timing or json.");
  const shots = cleanShots(input);
  if (!shots.length) return none("Add at least one shot before exporting.");
  const name = text(title, 80).trim();
  const times = timeline(shots);
  const out = {
    markdown: () => ({ content: toMarkdown(shots, name), mime: "text/markdown", extension: "md" }),
    csv: () => ({ content: toCsv(shots), mime: "text/csv", extension: "csv" }),
    timing: () => ({ content: toTiming(shots), mime: "text/plain", extension: "txt" }),
    json: () => ({ content: JSON.stringify({ title: name || "Storyboard", shots: shots.map((s, i) => ({ number: i + 1, ...s, ...times[i] })) }, null, 2), mime: "application/json", extension: "json" })
  }[format]();
  return { ok: true, ...out, shots: shots.length, problems: [] };
}
