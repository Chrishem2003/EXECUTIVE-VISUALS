/**
 * Resolve the server-only Supabase API key.
 *
 * Supabase's modern sb_secret key replaces the legacy service_role key.
 * Keep the legacy name as a backwards-compatible fallback for existing
 * deployments; never expose the resolved value to browser responses.
 */
export function resolveSupabaseServerKey(env={}) {
  const modern=typeof env.SUPABASE_SECRET_KEY==="string"?env.SUPABASE_SECRET_KEY.trim():"";
  const legacy=typeof env.SUPABASE_SERVICE_ROLE_KEY==="string"?env.SUPABASE_SERVICE_ROLE_KEY.trim():"";
  return modern||legacy||null;
}
