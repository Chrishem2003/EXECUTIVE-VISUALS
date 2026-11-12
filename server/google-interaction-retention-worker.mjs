const TERMINAL = new Set(["succeeded", "failed", "canceled", "incomplete"]);
const ACTIVE = new Set(["running", "waiting"]);

function contextFor(record) {
  return {
    ownerId: record.ownerId,
    projectId: record.projectId || null,
    jobId: record.jobId
  };
}

/**
 * Retention worker for stored Gemini Interactions. Active background work is
 * cancelled and confirmed terminal before deletion because the provider does
 * not permit deleting an interaction while it is running or awaiting action.
 * The durable row is marked deleting only after terminal state is confirmed.
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
  if (!client || typeof client.deleteInteraction !== "function" ||
      typeof client.getInteraction !== "function" ||
      typeof client.cancelInteraction !== "function") {
    throw new TypeError("Google interaction retention worker requires get, cancel and delete lifecycle methods.");
  }

  async function resolveTerminalStatus(record, context) {
    if (TERMINAL.has(record.state)) return record.state;

    let remote;
    try {
      remote = await client.getInteraction(record.interactionId, context);
    } catch (error) {
      // A prior delete may have succeeded while its database acknowledgement was
      // lost. The delete endpoint is idempotently reconciled as 404 by the client.
      if (error?.status === 404) return "provider_missing";
      throw error;
    }

    let status = remote?.status;
    if (ACTIVE.has(status)) {
      // Cancellation responses may precede the provider's persisted terminal
      // state. Always re-read before deletion; GET is the deletion gate.
      await client.cancelInteraction(record.interactionId, context);
      remote = await client.getInteraction(record.interactionId, context);
      status = remote?.status;
    }

    if (TERMINAL.has(status)) return status;
    if (ACTIVE.has(status)) {
      await interactions.updateInteraction({
        interactionId: record.interactionId,
        ...context,
        state: status
      });
      return null;
    }
    return null;
  }

  return Object.freeze({
    async run({ before = new Date().toISOString(), limit = 100 } = {}) {
      const expired = await interactions.listExpired({ before, limit });
      const results = [];
      for (const record of expired) {
        const context = contextFor(record);
        const scope = { interactionId: record.interactionId, ...context };
        try {
          const terminalStatus = await resolveTerminalStatus(record, context);
          if (!terminalStatus) {
            results.push({ interactionId: record.interactionId, status: "retry_pending" });
            continue;
          }
          if (terminalStatus !== "provider_missing" && record.state !== terminalStatus) {
            await interactions.updateInteraction({ ...scope, state: terminalStatus });
          }
          await interactions.updateInteraction({ ...scope, state: "deleting" });
          await client.deleteInteraction(record.interactionId, context);
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
