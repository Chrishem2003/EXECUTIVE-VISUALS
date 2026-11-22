const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId=(value,label)=>{if(typeof value!=="string"||!UUID.test(value))throw Object.assign(new Error(label+" must be a UUID."),{code:"PROJECT_CREDIT_POOL_ARGUMENT_INVALID",status:400});return value;};
const integer=(value,label,{min=0,max=1000000000}={})=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw Object.assign(new Error(label+" must be a whole number from "+min+" to "+max+"."),{code:"PROJECT_CREDIT_POOL_ARGUMENT_INVALID",status:400});return value;};

export function createProjectCreditPoolApi({url=process.env.SUPABASE_URL,serviceRoleKey,fetchImpl=globalThis.fetch,timeoutMs=12000}={}){
 if(!url||!serviceRoleKey||typeof fetchImpl!=="function")throw new Error("Project credit pool API requires Supabase credentials and fetch.");
 const parsed=new URL(url);
 if(parsed.protocol!=="https:"||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error("Project credit pool API requires a valid HTTPS Supabase origin.");
 const base=parsed.origin;
 async function rpc(name,args){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const headers={apikey:serviceRoleKey,"accept-profile":"executive_visuals","content-profile":"executive_visuals",accept:"application/json","content-type":"application/json"};
   if(!String(serviceRoleKey).startsWith("sb_secret_"))headers.authorization="Bearer "+serviceRoleKey;
   const response=await fetchImpl(base+"/rest/v1/rpc/"+name,{method:"POST",headers,body:JSON.stringify(args),signal:controller.signal});
   const raw=await response.text();let data=null;
   if(raw){try{data=JSON.parse(raw);}catch{throw Object.assign(new Error("Project credit pool service returned invalid database data."),{code:"PROJECT_CREDIT_POOL_RESPONSE_INVALID",status:502});}}
   if(!response.ok){
    const message=typeof data?.message==="string"&&data.message.length<=300?data.message:"Project credit pool operation failed.";
    const businessCode=/^[A-Z][A-Z0-9_]{1,100}$/.test(message)?message:
     (typeof data?.code==="string"&&/^[A-Z][A-Z0-9_]{1,100}$/.test(data.code)?data.code:"PROJECT_CREDIT_POOL_DATABASE_ERROR");
    throw Object.assign(new Error(message),{code:businessCode,status:response.status});
   }
   return data;
  }catch(error){
   if(error?.name==="AbortError")throw Object.assign(new Error("Project credit pool request timed out."),{code:"PROJECT_CREDIT_POOL_TIMEOUT",status:504});
   throw error;
  }finally{clearTimeout(timer);}
 }
 return Object.freeze({
  async configure({ownerId,projectId,monthlySpendLimitCredits=0}={}){
   return rpc("configure_project_credit_pool",{p_owner_id:validId(ownerId,"Owner ID"),p_project_id:validId(projectId,"Project ID"),p_monthly_spend_limit_credits:integer(monthlySpendLimitCredits,"Monthly project limit")});
  },
  async fund({ownerId,projectId,credits,idempotencyKey}={}){
   if(typeof idempotencyKey!=="string"||idempotencyKey.length<8||idempotencyKey.length>160)throw Object.assign(new Error("A valid idempotency key is required."),{code:"PROJECT_CREDIT_POOL_ARGUMENT_INVALID",status:400});
   return rpc("fund_project_credit_pool",{p_owner_id:validId(ownerId,"Owner ID"),p_project_id:validId(projectId,"Project ID"),p_credits:integer(credits,"Credit transfer",{min:1,max:100000000}),p_idempotency_key:idempotencyKey});
  },
  async setMemberPolicy({ownerId,projectId,memberId,monthlyLimitCredits=0,status="active"}={}){
   if(!["active","paused"].includes(status))throw Object.assign(new Error("Member status must be active or paused."),{code:"PROJECT_CREDIT_POOL_ARGUMENT_INVALID",status:400});
   return rpc("configure_project_credit_pool_member_policy",{p_owner_id:validId(ownerId,"Owner ID"),p_project_id:validId(projectId,"Project ID"),p_member_id:validId(memberId,"Member ID"),p_monthly_limit_credits:integer(monthlyLimitCredits,"Member monthly limit"),p_status:status});
  },
  async listMemberUsage({ownerId,projectId}={}){
   return rpc("list_project_credit_pool_member_usage",{p_owner_id:validId(ownerId,"Owner ID"),p_project_id:validId(projectId,"Project ID")});
  },
  async listMembers({ownerId,projectId}={}){
   return rpc("list_project_members",{p_owner_id:validId(ownerId,"Owner ID"),p_project_id:validId(projectId,"Project ID")});
  },
  async addMember({ownerId,projectId,email,role="viewer"}={}){
   const normalizedEmail=typeof email==="string"?email.trim().toLowerCase():"";
   if(normalizedEmail.length<3||normalizedEmail.length>320||!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(normalizedEmail)||!["editor","reviewer","viewer"].includes(role)){
    throw Object.assign(new Error("Enter a registered account email and choose editor, reviewer or viewer."),{code:"PROJECT_CREDIT_POOL_ARGUMENT_INVALID",status:400});
   }
   return rpc("add_project_member",{p_owner_id:validId(ownerId,"Owner ID"),p_project_id:validId(projectId,"Project ID"),p_email:normalizedEmail,p_role:role});
  },
  async removeMember({ownerId,projectId,memberId}={}){
   return rpc("remove_project_member",{p_owner_id:validId(ownerId,"Owner ID"),p_project_id:validId(projectId,"Project ID"),p_member_id:validId(memberId,"Member ID")});
  }
 });
}
