/**
 * Reconciles expired temporary Gemini Files resources without deleting source
 * assets. EXPIRED is a retryable tombstone; DELETED is terminal. A lost
 * provider-delete response is safe because a subsequent 404 is treated as
 * already deleted and the database state is finalized.
 */
export function createGoogleGeminiFilesRetentionWorker({ repository, gateway } = {}) {
  if (!repository || typeof repository.listExpiredProviderFiles !== "function" ||
      typeof repository.updateProviderFileState !== "function") {
    throw new TypeError("Gemini Files retention requires the durable provider-file repository.");
  }
  if (!gateway || typeof gateway.deleteProviderFile !== "function") {
    throw new TypeError("Gemini Files retention requires the server-side Files gateway.");
  }

  return Object.freeze({
    async run({ before = new Date().toISOString(), limit = 100 } = {}) {
      const expired = await repository.listExpiredProviderFiles({ before, limit });
      const results = [];
      for (const record of expired) {
        const scope = { recordId: record.id, name: record.name };
        try {
          if (record.state !== "EXPIRED") {
            await repository.updateProviderFileState({ ...scope, state: "EXPIRED" });
          }
          const deleted = await gateway.deleteProviderFile(record.name);
          if (deleted !== true) throw new Error("Gemini Files gateway did not confirm deletion.");
          await repository.updateProviderFileState({ ...scope, state: "DELETED" });
          results.push({ recordId: record.id, status: "deleted" });
        } catch (error) {
          if (error?.status === 404) {
            try {
              await repository.updateProviderFileState({ ...scope, state: "DELETED" });
              results.push({ recordId: record.id, status: "already_deleted" });
              continue;
            } catch {}
          }
          results.push({ recordId: record.id, status: "retry_pending" });
        }
      }
      return Object.freeze({
        scanned: expired.length,
        deleted: results.filter(item => item.status === "deleted" || item.status === "already_deleted").length,
        retryPending: results.filter(item => item.status === "retry_pending").length,
        results: Object.freeze(results)
      });
    }
  });
}
