export const PROHIBITED_SHARED_SUPABASE_PROJECT_REFS = Object.freeze([
  "bokxljngydmqrmktofwm",
  "tymqdhwomggtnsjskxuk",
]);
const PROJECT_REF = /^[a-z0-9]{20}$/;

function fail(code,message){
  throw Object.assign(new Error(message),{code});
}

export function assertIsolatedSupabaseProject({projectRef,supabaseUrl}={}){
  const ref=String(projectRef||"").trim();
  if(!PROJECT_REF.test(ref))fail("EXECUTIVE_VISUALS_STAGING_PROJECT_REF_INVALID","An explicit 20-character isolated Executive Visuals staging Supabase project ref is required.");
  if(PROHIBITED_SHARED_SUPABASE_PROJECT_REFS.includes(ref))
    fail("SHARED_SUPABASE_PROJECT_PROHIBITED","Shared NEMA/platform Supabase projects are prohibited for Executive Visuals staging.");
  let url;
  try{url=new URL(String(supabaseUrl||""));}catch{fail("SUPABASE_STAGING_URL_INVALID","The isolated staging Supabase URL is invalid.");}
  if(url.protocol!=="https:"||url.hostname!==ref+".supabase.co"||url.username||url.password||url.search||url.hash)
    fail("SUPABASE_STAGING_URL_PROJECT_MISMATCH","The Supabase URL must match the explicitly designated isolated staging project ref.");
  return Object.freeze({projectRef:ref,origin:url.origin});
}

export function assertIsolatedSupabaseDatabaseUrl({projectRef,databaseUrl}={}){
  const ref=String(projectRef||"").trim();
  if(!PROJECT_REF.test(ref)||PROHIBITED_SHARED_SUPABASE_PROJECT_REFS.includes(ref))
    fail("SHARED_SUPABASE_PROJECT_PROHIBITED","A verified isolated Supabase project ref is required for staging database access.");
  let url;
  try{url=new URL(String(databaseUrl||""));}catch{fail("SUPABASE_STAGING_DB_URL_INVALID","The staging PostgreSQL connection URL is invalid.");}
  const username=decodeURIComponent(url.username);
  const direct=url.hostname==="db."+ref+".supabase.co";
  const pooler=url.hostname.endsWith(".pooler.supabase.com")&&username.endsWith("."+ref);
  if(!["postgres:","postgresql:"].includes(url.protocol)||(!direct&&!pooler)||!url.password||url.searchParams.get("sslmode")==="disable")
    fail("SUPABASE_STAGING_DB_URL_PROJECT_MISMATCH","The PostgreSQL connection must use the same isolated staging project and TLS.");
  if(!url.searchParams.has("sslmode"))url.searchParams.set("sslmode","require");
  return url.toString();
}
