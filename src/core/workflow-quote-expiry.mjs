/** A quote is approvable only while its server-issued expiry is a valid future timestamp. */
export function isWorkflowQuoteExpired(expiresAt, now = Date.now()) {
  if (!Number.isFinite(now)) return true;
  const expiry = Date.parse(String(expiresAt || ""));
  return !Number.isFinite(expiry) || expiry <= now;
}
