import process from "node:process";

// Isolate native media tools into a process group on POSIX so cancellation
// also reaches helper processes they may spawn. Windows retains direct-child
// signaling because detached process-group semantics differ there.
export function nativeProcessSpawnOptions(options = {}) {
  return process.platform === "win32"
    ? options
    : { ...options, detached: true };
}

export function signalNativeProcessTree(child, signal) {
  if (!child || !Number.isInteger(child.pid)) return false;
  if (process.platform === "win32") return child.kill(signal);
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
