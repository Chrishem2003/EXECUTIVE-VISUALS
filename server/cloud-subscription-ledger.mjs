const SCHEMA = "executive_visuals";
const activateRpc = "activate_generation_subscription";
const grantRpc = "grant_subscription_period_credits";
const statusRpc = "sync_generation_subscription_status";

function baseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Cloud subscription ledger URL must be absolute."); }
  const local = ["localhost","127.0.0.1","::1","[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol!=="https:" && !(local && url.protocol==="http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("Cloud subscription ledger URL must use HTTPS without embedded credentials, query or fragment.");
  }
  return url.origin;
}
function validDate(value) { return typeof value==="string" && Number.isFinite(Date.parse(value)); }

export function createCloudSubscriptionLedger({
  url=process.env.SUPABASE_URL,
  serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl=globalThis.fetch,
  timeoutMs=15000
}={}) {
  if(!url||!serviceRoleKey||typeof fetchImpl!=="function") throw new Error("Cloud subscription ledger requires server-side Supabase credentials and fetch.");
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000) throw new Error("Cloud subscription ledger timeout is invalid.");
  const origin=baseUrl(url);
  async function rpc(name,body) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(origin+"/rest/v1/rpc/"+name,{
        method:"POST",
        headers:{apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"content-type":"application/json",
          "accept-profile":SCHEMA,"content-profile":SCHEMA,accept:"application/json"},
        body:JSON.stringify(body),signal:controller.signal
      });
      const raw=await response.text();
      let rows=null;
      if(raw){try{rows=JSON.parse(raw);}catch{throw new Error("Cloud subscription ledger returned invalid JSON.");}}
      if(!response.ok){
        const error=new Error(typeof rows?.message==="string"?rows.message.replaceAll(serviceRoleKey,"[redacted]").slice(0,300):"Cloud subscription ledger request failed.");
        error.code="CLOUD_SUBSCRIPTION_LEDGER_FAILED"; error.status=response.status; throw error;
      }
      if(!Array.isArray(rows)||rows.length!==1||typeof rows[0]!=="object") throw new Error("Cloud subscription ledger returned an invalid receipt.");
      return rows[0];
    } catch(error) {
      if(error?.name==="AbortError"){const timeout=new Error("Cloud subscription ledger timed out; retry with the same provider subscription identity.");timeout.code="CLOUD_SUBSCRIPTION_LEDGER_TIMEOUT";throw timeout;}
      throw error;
    } finally {clearTimeout(timer);}
  }
  return Object.freeze({
    async activateSubscription({
      ownerId,planCode,provider,providerCustomerId=null,providerSubscriptionId=null,
      periodStart,periodEnd,status="active",metadata={}
    }={}) {
      if(typeof ownerId!=="string"||!ownerId.trim()||typeof planCode!=="string"||!/^[a-z][a-z0-9_-]{1,40}$/.test(planCode)||
        !["manual","flutterwave","dodo"].includes(provider)||!validDate(periodStart)||!validDate(periodEnd)||
        Date.parse(periodEnd)<=Date.parse(periodStart)||!["trialing","active","past_due"].includes(status)||
        (provider!=="manual"&&(typeof providerSubscriptionId!=="string"||!providerSubscriptionId.trim()))||
        (providerCustomerId!==null&&(typeof providerCustomerId!=="string"||providerCustomerId.length>200))||
        (providerSubscriptionId!==null&&(typeof providerSubscriptionId!=="string"||providerSubscriptionId.length>200))||
        !metadata||typeof metadata!=="object"||Array.isArray(metadata)) {
        throw new Error("Cloud subscription activation requires a valid owner, plan, provider and bounded billing period.");
      }
      const row=await rpc(activateRpc,{
        p_owner_id:ownerId,p_plan_code:planCode,p_provider:provider,p_provider_customer_id:providerCustomerId,
        p_provider_subscription_id:providerSubscriptionId,p_period_start:periodStart,p_period_end:periodEnd,
        p_status:status,p_metadata:metadata
      });
      if(typeof row.subscription_id!=="string"||typeof row.replayed!=="boolean") throw new Error("Cloud subscription activation returned an invalid receipt.");
      return Object.freeze({subscriptionId:row.subscription_id,replayed:row.replayed});
    },
    async syncSubscriptionStatus({
      provider,providerSubscriptionId,status,planCode=null,cancelAtPeriodEnd=false,
      graceUntil=null,metadata={}
    }={}) {
      if(!["dodo","flutterwave"].includes(provider)||typeof providerSubscriptionId!=="string"||
        !providerSubscriptionId.trim()||providerSubscriptionId.length>200||
        !["trialing","active","past_due","paused","cancelled","expired"].includes(status)||
        (planCode!==null&&(typeof planCode!=="string"||!/^[a-z][a-z0-9_-]{1,40}$/.test(planCode)))||
        typeof cancelAtPeriodEnd!=="boolean"||
        (graceUntil!==null&&(!validDate(graceUntil)||status!=="past_due"))||!metadata||typeof metadata!=="object"||Array.isArray(metadata)) {
        throw new Error("Cloud subscription status update requires a valid provider identity and lifecycle state.");
      }
      const row=await rpc(statusRpc,{
        p_provider:provider,p_provider_subscription_id:providerSubscriptionId,p_status:status,
        p_plan_code:planCode,p_cancel_at_period_end:cancelAtPeriodEnd,
        p_grace_until:graceUntil,p_metadata:metadata
      });
      if(typeof row.subscription_id!=="string"||typeof row.replayed!=="boolean") {
        throw new Error("Cloud subscription status update returned an invalid receipt.");
      }
      return Object.freeze({subscriptionId:row.subscription_id,replayed:row.replayed,status:row.status});
    },
    async grantPeriodCredits({subscriptionId,periodStart}={}) {
      if(typeof subscriptionId!=="string"||!subscriptionId.trim()||!validDate(periodStart)) throw new Error("A subscription ID and valid billing period start are required.");
      const row=await rpc(grantRpc,{p_subscription_id:subscriptionId,p_period_start:periodStart});
      if(typeof row.ledger_id!=="string"||!Number.isSafeInteger(Number(row.balance))||typeof row.replayed!=="boolean") {
        throw new Error("Cloud subscription credit grant returned an invalid receipt.");
      }
      return Object.freeze({ledgerId:row.ledger_id,balance:Number(row.balance),replayed:row.replayed});
    }
  });
}
