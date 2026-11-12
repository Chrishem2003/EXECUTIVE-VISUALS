/**
 * Coalesce concurrent Supabase refresh-token rotations for the same opaque
 * browser session. Supabase refresh tokens are single-use; without this
 * process-local fence, parallel API requests can invalidate one another.
 * The latest persisted row is re-read after a failed rotation to tolerate a
 * successful refresh performed by another app process.
 */
export function createSupabaseSessionRefreshCoordinator({store,refreshSession,getUser}={}){
 if(!store||typeof store.get!=="function"||typeof store.rotate!=="function")throw new TypeError("A Supabase session store is required.");
 if(typeof refreshSession!=="function"||typeof getUser!=="function")throw new TypeError("Supabase refresh and user verification functions are required.");
 const inFlight=new Map();
 async function refresh({token,config}={}){
  if(typeof token!=="string"||!token)return null;
  const existing=inFlight.get(token);if(existing)return existing;
  const operation=(async()=>{
   const current=store.get(token);if(!current)return null;
   const rotated=await refreshSession({...config,refreshToken:current.refreshToken});
   if(!rotated||rotated.user?.id!==current.userId){
    const latest=store.get(token);
    if(!latest||latest.refreshToken===current.refreshToken)return null;
    const user=await getUser({...config,accessToken:latest.accessToken});
    return user?.id===latest.userId?{stored:latest,user}:null;
   }
   if(!store.rotate(token,rotated)){
    const latest=store.get(token);if(!latest)return null;
    const user=await getUser({...config,accessToken:latest.accessToken});
    return user?.id===latest.userId?{stored:latest,user}:null;
   }
   const latest=store.get(token);if(!latest)return null;
   return{stored:latest,user:rotated.user};
  })();
  inFlight.set(token,operation);
  try{return await operation;}
  finally{if(inFlight.get(token)===operation)inFlight.delete(token);}
 }
 return Object.freeze({refresh});
}
