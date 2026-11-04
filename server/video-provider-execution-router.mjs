const fail = (message, code = "VIDEO_ADAPTER_CONFIGURATION_INVALID") =>
  Object.assign(new Error(message), { code });

function adapterKey(provider, model) {
  if (typeof provider !== "string" || !provider.trim() || provider.length > 100 ||
      typeof model !== "string" || !model.trim() || model.length > 160) {
    throw fail("Provider and model identities must be non-empty and bounded.");
  }
  return provider + ":" + model;
}

/**
 * Immutable exact-match adapter registry for a shared leased video worker.
 * It performs no provider calls and never selects by fuzzy model name.
 */
export function createVideoProviderExecutionRouter({ adapters = [] } = {}) {
  if (!Array.isArray(adapters) || adapters.length < 1 || adapters.length > 100) {
    throw fail("Execution router requires between 1 and 100 provider adapters.");
  }
  const registry = new Map();
  for (const adapter of adapters) {
    if (!adapter || typeof adapter !== "object" || Array.isArray(adapter) ||
        typeof adapter.submit !== "function" || typeof adapter.getStatus !== "function" ||
        (adapter.prepareInput !== undefined && typeof adapter.prepareInput !== "function")) {
      throw fail("Every provider adapter must implement submit and getStatus; prepareInput is optional.");
    }
    const key = adapterKey(adapter.provider, adapter.model);
    if (registry.has(key)) throw fail("Duplicate provider/model adapter registration: " + key);
    registry.set(key, adapter);
  }

  return Object.freeze({
    async resolveAdapter({ provider, model, job } = {}) {
      const key = adapterKey(provider, model);
      if (!job?.id || job.job_type !== "video.generate" ||
          job.input?.provider !== provider || job.input?.model !== model) {
        throw fail("Leased job provider/model identity does not match its input.", "VIDEO_ADAPTER_JOB_SCOPE_MISMATCH");
      }
      const adapter = registry.get(key);
      if (!adapter) throw fail("No execution adapter is registered for " + key + ".", "VIDEO_ADAPTER_UNAVAILABLE");
      return adapter;
    },
    listSupported() {
      return Object.freeze([...registry.keys()].sort());
    }
  });
}
