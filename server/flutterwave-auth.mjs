const TOKEN_URL="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token";

/** OAuth2 client-credentials token cache for Flutterwave v4. */
export function createFlutterwaveAccessTokenProvider({
  clientId=process.env.FLW_CLIENT_ID,
  clientSecret=process.env.FLW_CLIENT_SECRET,
  fetchImpl=globalThis.fetch,
  now=()=>Date.now()
}={}){
  let token="";
  let expiresAt=0;
  let inFlight=null;
  return async function getAccessToken(){
    if(token&&expiresAt-now()>60_000)return token;
    if(inFlight)return inFlight;
    if(!clientId||!clientSecret)throw Object.assign(new Error("Flutterwave v4 OAuth client credentials are not configured."),{code:"PAYMENT_PROVIDER_NOT_CONFIGURED",status:503});
    inFlight=(async()=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      try{
        const response=await fetchImpl(TOKEN_URL,{
          method:"POST",redirect:"error",
          headers:{"content-type":"application/x-www-form-urlencoded"},
          body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:"client_credentials"}),
          signal:controller.signal
        });
        const raw=await response.text();
        let payload=null;try{payload=raw?JSON.parse(raw):null;}catch{}
        if(!response.ok||typeof payload?.access_token!=="string"||!Number.isFinite(Number(payload.expires_in))){
          throw Object.assign(new Error("Flutterwave OAuth token request failed."),{code:"FLUTTERWAVE_AUTH_FAILED",status:502});
        }
        token=payload.access_token;
        expiresAt=now()+Math.max(60,Number(payload.expires_in))*1000;
        return token;
      }catch(err){
        if(err?.name==="AbortError")throw Object.assign(new Error("Flutterwave OAuth token request timed out."),{code:"FLUTTERWAVE_AUTH_TIMEOUT",status:504});
        throw err;
      }finally{clearTimeout(timer);inFlight=null;}
    })();
    return inFlight;
  };
}
