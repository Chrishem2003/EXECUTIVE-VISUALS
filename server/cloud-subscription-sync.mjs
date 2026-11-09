import { randomUUID } from "node:crypto";
import { createCloudSubscriptionLedger } from "./cloud-subscription-ledger.mjs";

const now=()=>new Date().toISOString();
const fail=(message,code)=>Object.assign(new Error(message),{code});
const parse=value=>{try{return value?JSON.parse(value):{};}catch{return {};}};

export function ensureCloudSubscriptionSyncSchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_subscription_sync_outbox(
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK(provider IN ('dodo','flutterwave')),
      provider_event_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      plan_code TEXT NOT NULL,
      provider_customer_id TEXT,
      provider_subscription_id TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','trialing','past_due')),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      UNIQUE(provider,provider_event_id)
    );
    CREATE INDEX IF NOT EXISTS cloud_subscription_sync_pending_idx
      ON cloud_subscription_sync_outbox(processed_at,lease_expires_at,created_at);
  `);
}

export function enqueueCloudSubscriptionSync(db,{
  provider,providerEventId,ownerId,planCode,providerCustomerId=null,
  providerSubscriptionId,periodStart,periodEnd,status="active",metadata={}
}={}){
  if(!["dodo","flutterwave"].includes(provider)||!providerEventId||!ownerId||
    !/^[a-z][a-z0-9_-]{1,40}$/.test(String(planCode||""))||!providerSubscriptionId||
    !Number.isFinite(Date.parse(periodStart))||!Number.isFinite(Date.parse(periodEnd))||
    Date.parse(periodEnd)<=Date.parse(periodStart)||!["active","trialing","past_due"].includes(status)){
    throw fail("Cloud subscription sync event is incomplete or invalid.","CLOUD_SUBSCRIPTION_SYNC_INVALID");
  }
  const id=randomUUID();
  db.prepare(`INSERT OR IGNORE INTO cloud_subscription_sync_outbox
    (id,provider,provider_event_id,owner_id,plan_code,provider_customer_id,
     provider_subscription_id,period_start,period_end,status,metadata_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,provider,String(providerEventId),String(ownerId),String(planCode),
      providerCustomerId?String(providerCustomerId):null,String(providerSubscriptionId),
      new Date(periodStart).toISOString(),new Date(periodEnd).toISOString(),status,
      JSON.stringify(metadata||{}),now());
  return db.prepare("SELECT id FROM cloud_subscription_sync_outbox WHERE provider=? AND provider_event_id=?")
    .get(provider,String(providerEventId));
}

/**
 * Mirrors already-verified local provider subscription events into Supabase.
 * Activation and period-credit grant are separate idempotent RPCs; if the
 * process crashes between them, retry safely replays activation then grant.
 */
export async function processNextCloudSubscriptionSync(db,{
  env=process.env,ledger=null,fetchImpl=fetch,leaseMs=120000
}={}){
  const leaseOwner=randomUUID();
  db.exec("BEGIN IMMEDIATE");
  let event;
  try{
    const current=now();
    event=db.prepare(`SELECT * FROM cloud_subscription_sync_outbox
      WHERE processed_at IS NULL AND attempts<1000
        AND (lease_expires_at IS NULL OR lease_expires_at<=?)
      ORDER BY created_at ASC LIMIT 1`).get(current);
    if(!event){db.exec("COMMIT");return {processed:false};}
    const claimed=db.prepare(`UPDATE cloud_subscription_sync_outbox
      SET lease_owner=?,lease_expires_at=? WHERE id=? AND processed_at IS NULL
      AND (lease_expires_at IS NULL OR lease_expires_at<=?)`)
      .run(leaseOwner,new Date(Date.now()+leaseMs).toISOString(),event.id,current);
    if(claimed.changes!==1){db.exec("COMMIT");return {processed:false};}
    db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error;}
  try{
    const client=ledger||createCloudSubscriptionLedger({
      url:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl
    });
    const metadata=parse(event.metadata_json);
    const activated=await client.activateSubscription({
      ownerId:event.owner_id,planCode:event.plan_code,provider:event.provider,
      providerCustomerId:event.provider_customer_id,
      providerSubscriptionId:event.provider_subscription_id,
      periodStart:event.period_start,periodEnd:event.period_end,status:event.status,
      metadata:{...metadata,providerEventId:event.provider_event_id,source:"verified_provider_webhook"}
    });
    const granted=await client.grantPeriodCredits({
      subscriptionId:activated.subscriptionId,periodStart:event.period_start
    });
    const done=db.prepare(`UPDATE cloud_subscription_sync_outbox
      SET processed_at=?,last_error=NULL,lease_owner=NULL,lease_expires_at=NULL
      WHERE id=? AND lease_owner=? AND processed_at IS NULL`)
      .run(now(),event.id,leaseOwner);
    if(done.changes!==1)throw fail("Cloud subscription sync lease was lost.","CLOUD_SUBSCRIPTION_SYNC_LEASE_LOST");
    return {processed:true,subscriptionId:activated.subscriptionId,ledgerId:granted.ledgerId,
      balance:granted.balance,replayed:activated.replayed||granted.replayed};
  }catch(error){
    db.prepare(`UPDATE cloud_subscription_sync_outbox
      SET attempts=attempts+1,last_error=?,lease_owner=NULL,lease_expires_at=NULL
      WHERE id=? AND lease_owner=? AND processed_at IS NULL`)
      .run(String(error?.code||"CLOUD_SUBSCRIPTION_SYNC_FAILED").slice(0,120),event.id,leaseOwner);
    return {processed:false,retryable:true,eventId:event.provider_event_id,
      errorCode:error?.code||"CLOUD_SUBSCRIPTION_SYNC_FAILED"};
  }
}
