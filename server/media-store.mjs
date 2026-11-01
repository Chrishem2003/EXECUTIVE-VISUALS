import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join, relative, sep, resolve } from "node:path";
import { json } from "./db.mjs";

/**
 * Stores engine output as a private, checksum-verified asset with provenance.
 * Binary kinds are identified from the file's own signature, never from a
 * header sent by a gateway. Generalizes the image-only store.
 */

const bad = (code, message) => Object.assign(new Error(message), { code });
const ascii = (buffer, start, end) => buffer.toString("latin1", start, end);

export function detectBinary(buffer) {
  const b = buffer;
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { kind: "image", mimeType: "image/png", extension: "png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", mimeType: "image/jpeg", extension: "jpg" };
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { kind: "image", mimeType: "image/webp", extension: "webp" };
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE") return { kind: "audio", mimeType: "audio/wav", extension: "wav" };
  if (b.length >= 3 && ascii(b, 0, 3) === "ID3") return { kind: "audio", mimeType: "audio/mpeg", extension: "mp3" };
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { kind: "audio", mimeType: "audio/mpeg", extension: "mp3" };
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    return brand === "qt  " ? { kind: "video", mimeType: "video/quicktime", extension: "mov" } : { kind: "video", mimeType: "video/mp4", extension: "mp4" };
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: "video", mimeType: "video/webm", extension: "webm" };
  throw bad("MEDIA_SIGNATURE_INVALID", "Generated output has an unsupported or invalid file signature.");
}

const TEXT_TYPES = {
  vtt: { kind: "text", mimeType: "text/vtt", extension: "vtt" },
  srt: { kind: "text", mimeType: "text/plain", extension: "srt" },
  txt: { kind: "text", mimeType: "text/plain", extension: "txt" }
};

function textType(format, buffer) {
  const type = TEXT_TYPES[format];
  if (!type) throw bad("MEDIA_SIGNATURE_INVALID", "Unsupported text output format.");
  if (buffer.includes(0)) throw bad("MEDIA_SIGNATURE_INVALID", "Text output contains binary data.");
  return type;
}

const safeSegment = value => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";

/**
 * `kind` limits what the caller will accept ("image", "video", "audio" or "text").
 * For text, pass `textFormat` ("vtt" | "srt" | "txt").
 */
export async function storeGeneratedMedia({ db, mediaRoot, ownerId, projectId = null, jobId, kind, textFormat, buffer, model, prompt = "", engine, derivativeOf = null, extra = {} }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw bad("MEDIA_SIGNATURE_INVALID", "Generated output is empty.");
  const type = kind === "text" ? textType(textFormat, buffer) : detectBinary(buffer);
  if (type.kind !== kind) throw bad("MEDIA_KIND_MISMATCH", `The engine returned ${type.kind} where ${kind} was expected.`);
  const id = randomUUID();
  const directory = join(mediaRoot, safeSegment(ownerId), safeSegment(projectId || "personal"));
  const absolute = resolve(directory, `${id}.${type.extension}`);
  const root = resolve(mediaRoot);
  const storagePath = relative(root, absolute).split(sep).join("/");
  if (storagePath.startsWith("..") || resolve(root, storagePath) !== absolute) throw bad("ASSET_PATH_INVALID", "Generated asset path failed validation.");
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(absolute, buffer, { flag: "wx" });
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const metadata = {
      generated: true,
      engine,
      model,
      promptHash: createHash("sha256").update(String(prompt)).digest("hex"),
      jobId,
      createdAt: new Date().toISOString(),
      ...extra
    };
    const name = `${engine || "generated"}-${id}.${type.extension}`;
    db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,derivative_of,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, ownerId, projectId, name, type.mimeType, buffer.length, sha256, storagePath, derivativeOf, json(metadata));
    return { id, projectId, name, mediaType: type.mimeType, size: buffer.length, sha256, storagePath, metadata };
  } catch (error) {
    await unlink(absolute).catch(() => {});
    throw error;
  }
}
