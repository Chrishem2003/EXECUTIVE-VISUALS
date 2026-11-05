import { Buffer } from "node:buffer";

const ACTIVE = "ACTIVE";
const PROCESSING = "PROCESSING";
const FAILED = "FAILED";
const STATES = new Set(["UPLOADING", "OUTCOME_UNKNOWN", "PROVIDER_CREATED"]);

function expectedHash(sha256) {
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) return null;
  return Buffer.from(sha256, "hex").toString("base64");
}

function metadataMatches(file, attempt) {
  const hash = expectedHash(attempt.sha256);
  return Boolean(hash && file &&
    file.displayName === attempt.displayName &&
    file.mimeType === attempt.mimeType &&
    Number(file.sizeBytes) === Number(attempt.sizeBytes) &&
    file.sha256Hash === hash);
}

/**
 * Reconciles uncertain uploads using only provider metadata. A missing or
 * ambiguous list result is never treated as proof that an upload did not occur.
 */
export function createGoogleGeminiFilesRecoveryWorker({
  repository, gateway, now = () => Date.now(), maxPages = 10
} = {}) {
  if (!repository || typeof repository.listRecoveryAttempts !== "function" ||
      typeof repository.updateUploadAttempt !== "function" ||
      typeof repository.recordProviderFile !== "function") {
    throw new TypeError("Gemini Files recovery requires the durable upload-attempt repository.");
  }
  if (!gateway || typeof gateway.listProviderFiles !== "function" ||
      typeof gateway.getProviderFile !== "function") {
    throw new TypeError("Gemini Files recovery requires provider metadata listing and lookup.");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new TypeError("Gemini Files recovery page limit is invalid.");
  }

  async function quarantine(attempt, code, status, results) {
    await repository.updateUploadAttempt({
      attemptId: attempt.id,
      expectedState: attempt.state,
      state: "QUARANTINED",
      errorCode: code,
      reconciledAt: new Date(now()).toISOString()
    });
    results.push({ attemptId: attempt.id, status });
  }

  async function listCandidates(displayName) {
    let pageToken;
    let complete = false;
    const matches = [];
    for (let page = 0; page < maxPages; page++) {
      const result = await gateway.listProviderFiles({ pageSize: 100, ...(pageToken ? { pageToken } : {}) });
      for (const file of result.files) if (file.displayName === displayName) matches.push(file);
      pageToken = result.nextPageToken || null;
      if (!pageToken) { complete = true; break; }
    }
    return { matches, complete };
  }

  return Object.freeze({
    async run({ before = new Date(now()).toISOString(), limit = 100 } = {}) {
      const attempts = await repository.listRecoveryAttempts({ before, limit });
      const results = [];
      for (const attempt of attempts) {
        if (!STATES.has(attempt.state)) {
          results.push({ attemptId: attempt.id, status: "ignored_state" });
          continue;
        }
        try {
          let file = null;
          if (attempt.providerFileName) {
            file = await gateway.getProviderFile(attempt.providerFileName);
          } else {
            const listed = await listCandidates(attempt.displayName);
            if (!listed.complete) {
              await quarantine(attempt, "GEMINI_FILE_RECOVERY_PAGINATION_INCOMPLETE", "pagination_incomplete_quarantined", results);
              continue;
            }
            if (listed.matches.length > 1) {
              await quarantine(attempt, "GEMINI_FILE_RECOVERY_MULTIPLE_MATCHES", "ambiguous_multiple_matches", results);
              continue;
            }
            if (listed.matches.length === 0) {
              await quarantine(attempt, "GEMINI_FILE_RECOVERY_NO_PROVIDER_EVIDENCE", "no_provider_evidence_quarantined", results);
              continue;
            }
            file = listed.matches[0];
          }

          if (!metadataMatches(file, attempt)) {
            await quarantine(attempt, "GEMINI_FILE_RECOVERY_METADATA_MISMATCH", "metadata_mismatch_quarantined", results);
            continue;
          }
          if (file.state === FAILED) {
            await repository.updateUploadAttempt({
              attemptId: attempt.id, expectedState: attempt.state,
              state: "FAILED", errorCode: "GEMINI_FILE_PROVIDER_PROCESSING_FAILED",
              reconciledAt: new Date(now()).toISOString()
            });
            results.push({ attemptId: attempt.id, status: "provider_processing_failed" });
            continue;
          }
          if (file.state !== ACTIVE) {
            if (file.state === PROCESSING || file.state === "STATE_UNSPECIFIED") {
              await repository.updateUploadAttempt({
                attemptId: attempt.id, expectedState: attempt.state,
                state: "PROVIDER_CREATED", providerFileName: file.name,
                providerFileUri: file.uri,
                ...(file.expirationTime ? { providerExpiresAt: file.expirationTime } : {})
              });
              results.push({ attemptId: attempt.id, status: "provider_processing" });
            } else {
              await quarantine(attempt, "GEMINI_FILE_RECOVERY_PROVIDER_STATE_UNRECOGNIZED", "provider_state_unrecognized_quarantined", results);
            }
            continue;
          }

          const expiresAt = file.expirationTime || attempt.providerExpiresAt;
          if (!expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now()) {
            await quarantine(attempt, "GEMINI_FILE_RECOVERY_EXPIRY_UNVERIFIED", "expiry_unverified_quarantined", results);
            continue;
          }
          await repository.recordProviderFile({
            provider: "google-gemini-files",
            assetId: attempt.assetId, ownerId: attempt.ownerId, projectId: attempt.projectId,
            name: file.name, uri: file.uri, mimeType: file.mimeType,
            sizeBytes: Number(file.sizeBytes), sha256: attempt.sha256,
            state: "ACTIVE", uploadedAt: new Date(now()).toISOString(), expiresAt
          });
          await repository.updateUploadAttempt({
            attemptId: attempt.id, expectedState: attempt.state,
            state: "COMPLETED", providerFileName: file.name,
            providerFileUri: file.uri, providerExpiresAt: expiresAt,
            reconciledAt: new Date(now()).toISOString()
          });
          results.push({ attemptId: attempt.id, status: "reconciled" });
        } catch {
          results.push({ attemptId: attempt.id, status: "retry_pending" });
        }
      }
      return Object.freeze({
        scanned: attempts.length,
        reconciled: results.filter(item => item.status === "reconciled").length,
        quarantined: results.filter(item => item.status.endsWith("_quarantined") || item.status === "ambiguous_multiple_matches").length,
        unresolved: results.filter(item => item.status !== "reconciled").length,
        retryPending: results.filter(item => item.status === "retry_pending").length,
        results: Object.freeze(results)
      });
    }
  });
}
