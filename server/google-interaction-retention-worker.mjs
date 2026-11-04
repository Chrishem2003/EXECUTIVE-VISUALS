/**
 * Retention worker for stored Gemini Interactions. The caller supplies the
 * application retention cutoff; this module never assumes a Google tier.
 * Rows are marked deleting before the remote call so retries can safely
 * complete after a timeout or a lost database response.
 */
export function createGoogleInteractionRetentionWorker({
  interactions,
  client
} = {}) {
  if (!interactions || typeof interactions.listExpired !== "function" ||
      typeof interactions.updateInteraction !== "function" ||
      typeof interactions.markInteractionDeleted !== "function") {
    throw new TypeError("Google interaction retention worker requires the durable repository.");
  }
  if (!client || typeof client.deleteInteraction !== "function") {
    throw new TypeError("Google interaction retention worker requires the server-side Interactions client.");
  }

  return Object.freeze({
    async run({ before = new Date().toISOString(), limit = 100 } = {}) {
      const expired = await interactions.listExpired({ before, limit });
      const results = [];
      for (const record of expired) {
        const scope = {
          interactionId: record.interactionId,
          ownerId: record.ownerId,
          projectId: record.projectId || null,
          jobId: record.jobId
        };
        try {
          if (record.state !== "deleting") {
            await interactions.updateInteraction({ ...scope, state: "deleting" });
          }
          await client.deleteInteraction(record.interactionId, {
            ownerId: record.ownerId,
            projectId: record.projectId || null,
            jobId: record.jobId
          });
          await interactions.markInteractionDeleted(scope);
          results.push({ interactionId: record.interactionId, status: "deleted" });
        } catch {
          results.push({ interactionId: record.interactionId, status: "retry_pending" });
        }
      }
      return Object.freeze({
        scanned: expired.length,
        deleted: results.filter(item => item.status === "deleted").length,
        retryPending: results.filter(item => item.status === "retry_pending").length,
        results: Object.freeze(results)
      });
    }
  });
}
