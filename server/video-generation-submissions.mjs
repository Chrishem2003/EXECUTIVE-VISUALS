import { randomUUID } from "node:crypto";

const STATES = new Set(["prepared", "submitting", "submitted", "unknown", "succeeded", "failed", "cancelled"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const fail = (message, code) => Object.assign(new Error(message), { code });

export function ensureVideoSubmissionSchema(db) {
  if (!db || typeof db.exec !== "function") throw new Error("Video submission ledger requires the application database.");
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_generation_submissions (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','submitting','submitted','unknown','succeeded','failed','cancelled')),
      provider_task_id TEXT UNIQUE,
      submission_started_at TEXT,
      submitted_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_error_code TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS video_submission_state_idx ON video_generation_submissions(state, updated_at);
    CREATE INDEX IF NOT EXISTS video_submission_owner_idx ON video_generation_submissions(owner_id, updated_at DESC);
  `);
}

function rowView(row) {
  if (!row) return null;
  let metadata = {};
  try { metadata = JSON.parse(row.metadata_json || "{}"); } catch {}
  return Object.freeze({
    id: row.id, jobId: row.job_id, ownerId: row.owner_id, provider: row.provider,
    model: row.model, requestHash: row.request_hash, state: row.state,
    providerTaskId: row.provider_task_id, submissionStartedAt: row.submission_started_at,
    submittedAt: row.submitted_at, updatedAt: row.updated_at,
    lastErrorCode: row.last_error_code, metadata: Object.freeze(metadata)
  });
}

export function createVideoSubmissionLedger({ db } = {}) {
  ensureVideoSubmissionSchema(db);

  function get(jobId) {
    return rowView(db.prepare("SELECT * FROM video_generation_submissions WHERE job_id=?").get(jobId));
  }

  return Object.freeze({
    prepare({ jobId, ownerId, provider, model, requestHash, metadata = {} } = {}) {
      for (const [name, value] of Object.entries({ jobId, ownerId, provider, model, requestHash })) {
        if (typeof value !== "string" || !value.trim() || value.length > 256) {
          throw fail("Video submission " + name + " is required and must be bounded.", "VIDEO_SUBMISSION_INVALID");
        }
      }
      const job = db.prepare("SELECT id,owner_id,job_type,input_json FROM jobs WHERE id=?").get(jobId);
      if (!job || job.owner_id !== ownerId || job.job_type !== "video.generate") {
        throw fail("Video submission must reference the owner's video.generate job.", "VIDEO_SUBMISSION_JOB_FORBIDDEN");
      }
      let input;
      try { input = JSON.parse(job.input_json); } catch { throw fail("Video job input is invalid.", "VIDEO_SUBMISSION_JOB_INVALID"); }
      if (input.requestHash !== requestHash || input.provider !== provider || input.model !== model) {
        throw fail("Submission metadata does not match the queued video request.", "VIDEO_SUBMISSION_REQUEST_MISMATCH");
      }

      const existing = get(jobId);
      if (existing) {
        if (existing.ownerId !== ownerId || existing.provider !== provider || existing.model !== model || existing.requestHash !== requestHash) {
          throw fail("A conflicting provider submission already exists for this job.", "VIDEO_SUBMISSION_CONFLICT");
        }
        return Object.freeze({ submission: existing, created: false });
      }

      const id = randomUUID();
      db.prepare(`INSERT INTO video_generation_submissions
        (id,job_id,owner_id,provider,model,request_hash,state,metadata_json)
        VALUES(?,?,?,?,?,?,'prepared',?)`)
        .run(id, jobId, ownerId, provider, model, requestHash, JSON.stringify(metadata));
      return Object.freeze({ submission: get(jobId), created: true });
    },

    beginSubmission(jobId) {
      const now = new Date().toISOString();
      const changed = db.prepare(`UPDATE video_generation_submissions
        SET state='submitting',submission_started_at=?,updated_at=?,last_error_code=NULL
        WHERE job_id=? AND state='prepared'`).run(now, now, jobId);
      return Object.freeze({ started: changed.changes === 1, submission: get(jobId) });
    },

    recordSubmitted(jobId, providerTaskId, metadata = {}) {
      if (typeof providerTaskId !== "string" || !providerTaskId.trim() || providerTaskId.length > 256) {
        throw fail("Provider task ID is required and must be bounded.", "VIDEO_SUBMISSION_TASK_ID_INVALID");
      }
      const now = new Date().toISOString();
      const changed = db.prepare(`UPDATE video_generation_submissions
        SET state='submitted',provider_task_id=?,submitted_at=?,updated_at=?,metadata_json=?
        WHERE job_id=? AND state='submitting'`)
        .run(providerTaskId, now, now, JSON.stringify(metadata), jobId);
      if (changed.changes === 1) return Object.freeze({ recorded: true, submission: get(jobId) });
      const current = get(jobId);
      if (current?.state === "submitted" && current.providerTaskId === providerTaskId) {
        return Object.freeze({ recorded: true, idempotentReplay: true, submission: current });
      }
      if (current?.providerTaskId && current.providerTaskId !== providerTaskId) {
        throw fail("A different provider task is already attached to this job.", "VIDEO_SUBMISSION_TASK_CONFLICT");
      }
      throw fail("Provider task can only be recorded after a submission attempt has started.", "VIDEO_SUBMISSION_STATE_INVALID");
    },

    reconcileSubmitted(jobId, providerTaskId, metadata = {}) {
      if (typeof providerTaskId !== "string" || !providerTaskId.trim() || providerTaskId.length > 256) {
        throw fail("Provider task ID is required and must be bounded.", "VIDEO_SUBMISSION_TASK_ID_INVALID");
      }
      const now = new Date().toISOString();
      const changed = db.prepare(`UPDATE video_generation_submissions
        SET state='submitted',provider_task_id=?,submitted_at=?,updated_at=?,last_error_code=NULL,metadata_json=?
        WHERE job_id=? AND state='unknown'`)
        .run(providerTaskId, now, now, JSON.stringify({ ...metadata, reconciled: true }), jobId);
      if (changed.changes === 1) return Object.freeze({ reconciled: true, submission: get(jobId) });
      const current = get(jobId);
      if (current?.state === "submitted" && current.providerTaskId === providerTaskId) {
        return Object.freeze({ reconciled: true, idempotentReplay: true, submission: current });
      }
      throw fail("Only an unknown provider submission can be reconciled to a known task.", "VIDEO_SUBMISSION_STATE_INVALID");
    },

    markUnknown(jobId, errorCode = "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN") {
      const code = String(errorCode || "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN").slice(0, 120);
      const now = new Date().toISOString();
      const changed = db.prepare(`UPDATE video_generation_submissions
        SET state='unknown',last_error_code=?,updated_at=?
        WHERE job_id=? AND state='submitting'`).run(code, now, jobId);
      if (changed.changes === 1) return Object.freeze({ changed: true, submission: get(jobId) });
      const current = get(jobId);
      if (current?.state === "unknown") return Object.freeze({ changed: false, submission: current });
      throw fail("Only an in-flight provider submission can be quarantined as unknown.", "VIDEO_SUBMISSION_STATE_INVALID");
    },

    markTerminal(jobId, state, metadata = {}) {
      if (!TERMINAL.has(state)) throw fail("Provider terminal state is invalid.", "VIDEO_SUBMISSION_STATE_INVALID");
      const now = new Date().toISOString();
      const changed = db.prepare(`UPDATE video_generation_submissions
        SET state=?,updated_at=?,metadata_json=?
        WHERE job_id=? AND state='submitted'`).run(state, now, JSON.stringify(metadata), jobId);
      if (changed.changes === 1) return Object.freeze({ changed: true, submission: get(jobId) });
      const current = get(jobId);
      if (current?.state === state) return Object.freeze({ changed: false, submission: current });
      throw fail("A provider submission must be acknowledged before it can become terminal.", "VIDEO_SUBMISSION_STATE_INVALID");
    },

    get,
    listAmbiguous(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw fail("Ambiguous submission limit is invalid.", "VIDEO_SUBMISSION_LIMIT_INVALID");
      return db.prepare(`SELECT * FROM video_generation_submissions
        WHERE state IN ('submitting','unknown') ORDER BY updated_at ASC LIMIT ?`)
        .all(limit).map(rowView);
    }
  });
}
