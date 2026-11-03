export function isBlockedDotPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(pathname || ""));
  } catch {
    return true;
  }
  if (decoded.includes("\\0")) return true;
  const normalized = decoded.replace(/\\/g, "/");
  return normalized.split("/").some(segment => segment.startsWith(".") && segment.length > 0);
}
