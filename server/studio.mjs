import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { addJobEvent, audit, canWriteProject, getAccessibleAsset, parseJson, recordModelUsage } from "./db.mjs";
import { GatewayError, gatewayStatus } from "./gateway-core.mjs";
import { assertIdentityUseAllowed } from "./identity-consent.mjs";
import { storeGeneratedMedia } from "./media-store.mjs";
import { invalid, normalizeParams } from "./studio-schema.mjs";
import { reserveRemoteRequest } from "./usage-guardrails.mjs";
import { finishingCatalog } from "./finishing.mjs";
import { ENHANCE_OPERATIONS, PREFIX as ENHANCE, runEnhance } from "./engines/enhance.mjs";
import { AVATAR_PARAMS, PREFIX as AVATAR, runAvatar } from "./engines/avatar.mjs";
import { TRANSFORM_OPERATIONS, PREFIX as TRANSFORM, runTransform } from "./engines/transform.mjs";
import { LIPSYNC_PARAMS, PREFIX as LIPSYNC, runLipsync } from "./engines/lipsync.mjs";

/**
 * Studio engines that fill the gaps in the provider registry: neural enhancement,
 * video transforms, presenter video and lip-sync. Speech, transcription, image and video generation keep
 * their own adapters. Spending is limited by the shared remote-usage reservation,
 * and identity use is governed by the shared consent model.
 */

export const STUDIO_JOBS = new Set(["studio.enhance", "studio.avatar", "studio.transform", "studio.lipsync"]);
export const isStudioJob = type => STUDIO_JOBS.has(type);

const MAX_SOURCE_BYTES = 200 * 1024 * 1024;
const MAX_NARRATION_BYTES = 25 * 1024 * 1024;
const PROVIDER_REF = "^[A-Za-z0-9_.:-]{1,128}$";

const AVATAR_FORM = [
  { key: "avatarRef", label: "Presenter reference in your gateway", type: "text", required: true, max: 128, pattern: PROVIDER_REF },
  { key: "voiceRef", label: "Voice reference (optional)", type: "text", max: 128, pattern: PROVIDER_REF },
  ...AVATAR_PARAMS
];

const engineView = (prefix, label) => ({ id: prefix.toLowerCase(), label, ...gatewayStatus(prefix) });

/** Catalog the browser renders its forms from, so client and server cannot drift. */
export function studioCatalog() {
  return {
    engines: { enhance: engineView(ENHANCE, "Enhancement"), avatar: engineView(AVATAR, "Presenter video"), transform: engineView(TRANSFORM, "Video transform"), lipsync: engineView(LIPSYNC, "Lip-sync") },
    enhance: Object.entries(ENHANCE_OPERATIONS).map(([id, op]) => ({ id, ...op })),
    transform: Object.entries(TRANSFORM_OPERATIONS).map(([id, op]) => ({ id, ...op })),
    avatar: { params: AVATAR_FORM },
    lipsync: { params: LIPSYNC_PARAMS },
    finishing: finishingCatalog()
  };
}

function requireAsset(db, userId, assetId, accepts, label) {
  const asset = getAccessibleAsset(db, userId, String(assetId || ""), false);
  if (!asset) throw invalid(`${label} was not found or you do not have access to it.`, "ASSET_NOT_FOUND", 404);
  if (!accepts.some(prefix => asset.media_type.startsWith(`${prefix}/`))) throw invalid(`${label} must be ${accepts.join(" or ")} media.`, "UNSUPPORTED_ASSET");
  return asset;
}

/** Characters live in the project workspace document; consent is part of each record. */
function findCharacter(db, projectId, characterId) {
  if (!projectId) throw invalid("Presenter video needs a project, because identity consent is recorded per project.", "PROJECT_REQUIRED");
  const row = db.prepare("SELECT document_json FROM project_workspace_documents WHERE project_id=?").get(projectId);
  const document = parseJson(row?.document_json, {});
  return (document.characters || []).find(item => String(item.id) === String(characterId));
}

/** Throws unless the character's recorded consent covers every scope in use. */
export function assertIdentity(db, projectId, characterId, scopes) {
  const character = findCharacter(db, projectId, characterId);
  try {
    for (const scope of scopes) assertIdentityUseAllowed(character, scope);
  } catch (error) {
    throw Object.assign(error, { status: 422 });
  }
  return character;
}

export function assertAvatarIdentity(db, projectId, characterId, voiceRef) {
  return assertIdentity(db, projectId, characterId, voiceRef ? ["face-animation", "voice"] : ["face-animation"]);
}

/** Validate a request and return the normalized payload. Nothing leaves the server here. */
export function prepareStudioJob(db, user, body) {
  const jobType = String(body?.jobType || "");
  if (!STUDIO_JOBS.has(jobType)) throw invalid("Unknown studio job type.", "UNKNOWN_STUDIO_JOB");
  const projectId = body.projectId ? String(body.projectId) : null;
  if (projectId && !canWriteProject(db, user.id, projectId)) throw invalid("Project not found or editor access required.", "PROJECT_NOT_FOUND", 404);
  let input;
  if (jobType === "studio.enhance" || jobType === "studio.transform") {
    const operation = String(body.operation || "");
    const spec = (jobType === "studio.enhance" ? ENHANCE_OPERATIONS : TRANSFORM_OPERATIONS)[operation];
    if (!spec) throw invalid("Choose a supported enhancement operation.");
    const source = requireAsset(db, user.id, body.sourceAssetId, spec.media, "Source media");
    if (spec.requiresRights && body.rightsAttested !== true) {
      throw invalid("Confirm that you own this media or hold the rights to modify it before removing a watermark.", "RIGHTS_ATTESTATION_REQUIRED", 422);
    }
    input = { sourceAssetId: source.id, operation, params: normalizeParams(spec.params, body.params), rightsAttested: Boolean(spec.requiresRights) };
  } else if (jobType === "studio.lipsync") {
    const video = requireAsset(db, user.id, body.sourceAssetId, ["video"], "Source video");
    const audio = requireAsset(db, user.id, body.audioAssetId, ["audio"], "Replacement audio");
    const params = normalizeParams(LIPSYNC_PARAMS, body.params);
    assertIdentity(db, projectId, body.identityProfileId, ["lip-sync"]);
    input = { sourceAssetId: video.id, audioAssetId: audio.id, identityProfileId: String(body.identityProfileId), params };
  } else {
    const params = normalizeParams(AVATAR_FORM, body.params);
    assertAvatarIdentity(db, projectId, body.identityProfileId, params.voiceRef);
    input = { identityProfileId: String(body.identityProfileId), params };
    if (body.audioAssetId) input.audioAssetId = requireAsset(db, user.id, body.audioAssetId, ["audio"], "Narration audio").id;
    else if (!params.script) throw invalid("Provide a script or narration audio.");
  }
  return { jobType, projectId, input };
}

async function readAssetBytes(db, mediaRoot, ownerId, assetId, limit, label) {
  const asset = getAccessibleAsset(db, ownerId, String(assetId), false);
  if (!asset) throw Object.assign(new Error(`${label} is no longer available.`), { code: "SOURCE_ASSET_NOT_FOUND" });
  if (asset.byte_size > limit) throw Object.assign(new Error(`${label} is larger than the allowed ${Math.round(limit / 1048576)} MiB.`), { code: "SOURCE_TOO_LARGE" });
  return { asset, buffer: await readFile(join(mediaRoot, asset.storage_path)) };
}

/** Watches this job and, for a workflow node, the parent run, so cancelling either aborts the provider call. */
function cancellation(db, jobIds) {
  const ids = jobIds.filter(Boolean);
  const isCancelled = () => ids.some(id => db.prepare("SELECT status FROM jobs WHERE id=?").get(id)?.status === "cancelled");
  const controller = new AbortController();
  const timer = setInterval(() => { if (isCancelled()) controller.abort(); }, 1000);
  timer.unref();
  return { signal: controller.signal, isCancelled, stop: () => clearInterval(timer) };
}

const summary = stored => ({ id: stored.id, name: stored.name, mediaType: stored.mediaType, size: stored.size, sha256: stored.sha256 });

export async function executeStudioJob({ db, job, mediaRoot, onProgress = () => {}, parentJobId = null, nodeId = null, workflowRunId = null }) {
  const input = parseJson(job.input_json, {});
  const owner = job.owner_id;
  const emit = (type, data) => addJobEvent(db, job.id, owner, type, data);
  const guard = cancellation(db, [job.id, parentJobId]);
  const { signal } = guard;
  const started = Date.now();
  const store = fields => storeGeneratedMedia({ db, mediaRoot, ownerId: owner, projectId: job.project_id, jobId: job.id, ...fields });
  // Reserve a shared remote-usage slot once the gateway config is known to be valid.
  const reserve = (provider, capability) => cfg => reserveRemoteRequest(db, { ownerId: owner, projectId: job.project_id || null, jobId: job.id, provider: { provider, remote: !cfg.local }, capability });
  try {
    emit("studio.started", { jobType: job.job_type });
    onProgress(5);
    let stored;
    let model;
    if (job.job_type === "studio.enhance" || job.job_type === "studio.transform") {
      const engine = job.job_type.slice(7);
      const { asset, buffer } = await readAssetBytes(db, mediaRoot, owner, input.sourceAssetId, MAX_SOURCE_BYTES, "Source media");
      if (input.rightsAttested) audit(db, owner, "studio.rights_attested", "asset", asset.id, { operation: input.operation }, job.project_id);
      const result = await (engine === "enhance" ? runEnhance : runTransform)({ operation: input.operation, params: input.params, blob: new Blob([buffer], { type: asset.media_type }), name: asset.original_name, signal, onReady: reserve(engine, `${engine}.${input.operation}`), onProgress: p => onProgress(10 + p * 0.8) });
      model = result.model;
      stored = await store({ kind: asset.media_type.startsWith("video/") ? "video" : "image", buffer: result.buffer, model, engine, prompt: input.operation, derivativeOf: asset.id, extra: { operation: input.operation, params: input.params } });
    } else if (job.job_type === "studio.lipsync") {
      // Consent is checked again here, so revoking or expiring it stops queued work.
      const character = assertIdentity(db, job.project_id, input.identityProfileId, ["lip-sync"]);
      audit(db, owner, "studio.identity_used", "character", String(character.id), { jobId: job.id, scopes: ["lip-sync"] }, job.project_id);
      const v = await readAssetBytes(db, mediaRoot, owner, input.sourceAssetId, MAX_SOURCE_BYTES, "Source video");
      const a = await readAssetBytes(db, mediaRoot, owner, input.audioAssetId, MAX_NARRATION_BYTES, "Replacement audio");
      const result = await runLipsync({ params: input.params, video: { blob: new Blob([v.buffer], { type: v.asset.media_type }), name: v.asset.original_name }, audio: { blob: new Blob([a.buffer], { type: a.asset.media_type }), name: a.asset.original_name }, signal, onReady: reserve("lipsync", "lipsync.generate"), onProgress: p => onProgress(10 + p * 0.8) });
      model = result.model;
      stored = await store({ kind: "video", buffer: result.buffer, model, engine: "lipsync", prompt: "lip-sync", derivativeOf: v.asset.id, extra: { identityProfileId: String(character.id), audioAssetId: a.asset.id } });
    } else if (job.job_type === "studio.avatar") {
      // Consent is checked again here, so revoking or expiring it stops queued work.
      const character = assertAvatarIdentity(db, job.project_id, input.identityProfileId, input.params.voiceRef);
      audit(db, owner, "studio.identity_used", "character", String(character.id), { jobId: job.id, scopes: input.params.voiceRef ? ["face-animation", "voice"] : ["face-animation"] }, job.project_id);
      let audio;
      if (input.audioAssetId) {
        const a = await readAssetBytes(db, mediaRoot, owner, input.audioAssetId, MAX_NARRATION_BYTES, "Narration audio");
        audio = `data:${a.asset.media_type};base64,${a.buffer.toString("base64")}`;
      }
      const result = await runAvatar({ avatarRef: input.params.avatarRef, voiceRef: input.params.voiceRef, params: input.params, audio, signal, onReady: reserve("avatar", "avatar.generate"), onProgress: p => onProgress(10 + p * 0.8) });
      model = result.model;
      stored = await store({ kind: "video", buffer: result.buffer, model, engine: "avatar", prompt: input.params.script || input.audioAssetId || "", extra: { identityProfileId: String(character.id) } });
    } else {
      throw Object.assign(new Error("No studio adapter for this job type."), { code: "ENGINE_UNAVAILABLE" });
    }
    if (guard.isCancelled()) throw Object.assign(new Error("Job cancelled."), { code: "JOB_CANCELLED" });
    recordModelUsage(db, { ownerId: owner, projectId: job.project_id || null, jobId: job.id, workflowRunId, nodeId, provider: job.job_type.slice(7), capability: job.job_type === "studio.avatar" ? "avatar.generate" : job.job_type === "studio.lipsync" ? "lipsync.generate" : `${job.job_type.slice(7)}.${input.operation}`, model, durationMs: Date.now() - started });
    emit("studio.output_created", { assetId: stored.id, sha256: stored.sha256, model });
    audit(db, owner, "studio.output_created", "asset", stored.id, { jobType: job.job_type, model }, job.project_id);
    return { outputAsset: summary(stored) };
  } catch (error) {
    if (error instanceof GatewayError && error.code.endsWith("_GATEWAY_CANCELLED")) throw Object.assign(new Error("Job cancelled."), { code: "JOB_CANCELLED" });
    throw error;
  } finally {
    guard.stop();
  }
}
