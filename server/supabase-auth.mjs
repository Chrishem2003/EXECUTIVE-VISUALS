export function extractBearerToken(header) {
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  if (!match || match[1].length > 16384) return "";
  return match[1];
}

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30000;

export async function verifySupabaseUser({
  supabaseUrl,
  publishableKey,
  accessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch
}) {
  if (typeof supabaseUrl !== "string" || !supabaseUrl.trim()) return null;
  if (typeof publishableKey !== "string" || !publishableKey.trim()) return null;
  if (typeof accessToken !== "string" || !accessToken.trim() || accessToken.length > 16384) return null;

  let endpoint;
  try {
    const base = new URL(supabaseUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname.toLowerCase());
    if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) return null;
    endpoint = new URL("/auth/v1/user", base).toString();
  } catch {
    return null;
  }

  const requestedTimeout = Number(timeoutMs);
  const boundedTimeout = Number.isFinite(requestedTimeout)
    ? Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(requestedTimeout)))
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundedTimeout);

  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        apikey: publishableKey,
        authorization: "Bearer " + accessToken
      },
      signal: controller.signal
    });
    if (!response?.ok) return null;
    const user = await response.json();
    if (!user || typeof user.id !== "string" || !user.id.trim()) return null;
    return {
      id: user.id,
      email: typeof user.email === "string" ? user.email : ""
    };
  } catch {
    // Identity-provider errors and timeouts must fail closed as unauthenticated.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
