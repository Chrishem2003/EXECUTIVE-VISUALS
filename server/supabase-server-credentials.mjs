/**
 * Resolve the server-only Supabase API key.
 *
 * Prefer the modern sb_secret key while retaining the legacy service_role
 * JWT during migration. Resolved credentials must never reach browser code.
 */
export function resolveSupabaseServerKey(env={}) {
  const modern=typeof env.SUPABASE_SECRET_KEY==="string"?env.SUPABASE_SECRET_KEY.trim():"";
  const legacy=typeof env.SUPABASE_SERVICE_ROLE_KEY==="string"?env.SUPABASE_SERVICE_ROLE_KEY.trim():"";
  return modern||legacy||null;
}

/**
 * Supabase's modern secret keys are opaque API keys, not JWTs. They must be
 * sent in apikey only; legacy service-role JWTs retain Bearer compatibility.
 */
export function supabaseServerAuthHeaders(key) {
  if(typeof key!=="string"||!key.trim()) throw new TypeError("A server-side Supabase key is required.");
  return {
    apikey:key,
    ...(key.startsWith("sb_secret_")?{}:{authorization:"Bearer "+key})
  };
}
