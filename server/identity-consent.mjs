const allowedScopes=new Set(["likeness","voice","face-animation","lip-sync","identity-transfer"]);
const fail=(message,code="IDENTITY_PERMISSION_REQUIRED")=>{throw Object.assign(new Error(message),{code});};

export function assertIdentityUseAllowed(profile,scope,at=new Date()){
  if(!profile||typeof profile!=="object")fail("Identity profile was not found in this project.");
  if(!allowedScopes.has(scope))fail("The requested identity-use scope is not supported.","IDENTITY_SCOPE_INVALID");
  const consent=profile.consent;
  if(consent?.kind==="fictional")return {profileId:String(profile.id||""),scope,basis:"fictional"};
  if(consent?.kind!=="authorized")fail("This identity has no documented authorization. Remote identity-based generation is blocked.");
  const scopes=Array.isArray(consent.scopes)?consent.scopes:[];
  if(!scopes.includes(scope))fail("Recorded permission does not cover the requested identity use: "+scope+".");
  const evidence=String(consent.evidenceReference||"").trim();
  if(!evidence||evidence.length>500)fail("A consent evidence reference is required before this identity can be used.");
  const expires=String(consent.expiresAt||"").trim();
  const expiryDate=new Date(expires+"T00:00:00Z");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(expires)||!Number.isFinite(expiryDate.getTime())||expiryDate.toISOString().slice(0,10)!==expires)fail("A valid consent expiry date is required.");
  if(Date.parse(expires+"T23:59:59Z")<at.getTime())fail("Recorded identity permission has expired.","IDENTITY_PERMISSION_EXPIRED");
  return {profileId:String(profile.id||""),scope,basis:"documented-authorization",evidenceReference:evidence,expiresAt:expires};
}
