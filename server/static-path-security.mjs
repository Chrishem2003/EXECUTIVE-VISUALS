export function isBlockedDotPath(pathname) {
  let decoded = String(pathname || "");
  try {
    // Decode repeatedly to catch paths encoded by more than one intermediary.
    for (let depth = 0; depth < 3; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return true;
  }
  if (decoded.includes("\\u0000")) return true;
  const normalized = decoded.replace(/\\\\/g, "/");
  return normalized.split("/").some(segment => segment.startsWith(".") && segment.length > 0);
}
