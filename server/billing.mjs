import { randomUUID } from "node:crypto";
import { estimateRunwayImageCredits } from "./runway-image-pricing.mjs";
import { estimateRunwayVideoCredits } from "./runway-video-pricing.mjs";

const isoNow = () => new Date().toISOString();
const safeJson = value => JSON.stringify(value ?? {});
const parseJson = value => { try { return value ? JSON.parse(value) : {}; } catch { return {}; } };

function fail(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function ensureBillingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_accounts (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS billing_accounts_email_idx ON billing_accounts(email);
    CREATE TABLE IF NOT EXISTS billing_plans (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      amount_minor INTEGER,
      currency TEXT NOT NULL DEFAULT 'USD',
      interval TEXT NOT NULL DEFAULT 'month' CHECK(interval IN ('month','year','one_time')),
      credits_per_period INTEGER NOT NULL DEFAULT 0 CHECK(credits_per_period >= 0),
      limits_json TEXT NOT NULL DEFAULT '{}',
      features_json TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES billing_accounts(user_id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES billing_plans(id),
      status TEXT NOT NULL CHECK(status IN ('trialing','active','past_due','cancelled','expired','paused')),
      provider TEXT NOT NULL DEFAULT 'manual',
      provider_customer_id TEXT,
      provider_subscription_id TEXT,
      current_period_start TEXT NOT NULL,
      current_period_end TEXT NOT NULL,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(cancel_at_period_end IN (0,1)),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS billing_subscriptions_user_idx ON billing_subscriptions(user_id,status,current_period_end DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS billing_subscriptions_provider_idx ON billing_subscriptions(provider,provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS billing_credit_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES billing_accounts(user_id) ON DELETE CASCADE,
      amount INTEGER NOT NULL CHECK(amount <> 0),
      event_type TEXT NOT NULL CHECK(event_type IN ('admin_grant','admin_adjustment','subscription_grant','generation_spend','generation_refund','purchase','expiry','migration')),
      description TEXT NOT NULL DEFAULT '',
      reference_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      expires_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS billing_ledger_user_idx ON billing_credit_ledger(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS billing_credit_settlements (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES billing_accounts(user_id) ON DELETE CASCADE,
      spend_ledger_id TEXT NOT NULL UNIQUE REFERENCES billing_credit_ledger(id),
      settlement_key TEXT NOT NULL UNIQUE,
      estimated_credits INTEGER NOT NULL CHECK(estimated_credits > 0),
      actual_credits INTEGER NOT NULL CHECK(actual_credits >= 0),
      adjustment_ledger_id TEXT REFERENCES billing_credit_ledger(id),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS billing_settlements_user_created_idx ON billing_credit_settlements(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS billing_daily_refills (
      user_id TEXT NOT NULL REFERENCES billing_accounts(user_id) ON DELETE CASCADE,
      refill_day TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY(user_id,refill_day)
    );
    CREATE TABLE IF NOT EXISTS billing_provider_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(provider,event_id)
    );
    CREATE TABLE IF NOT EXISTS billing_model_prices (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      capability TEXT NOT NULL,
      unit TEXT NOT NULL,
      price_micros INTEGER NOT NULL CHECK(price_micros >= 0),
      currency TEXT NOT NULL DEFAULT 'USD',
      source_url TEXT NOT NULL DEFAULT '',
      verified_at TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(provider,model,capability,unit)
    );
  `);
  const existing = db.prepare("SELECT id FROM billing_plans WHERE code='free'").get();
  if (!existing) {
    db.prepare("INSERT INTO billing_plans(id,code,name,description,amount_minor,currency,interval,credits_per_period,limits_json,features_json,active) VALUES(?,?,?,?,?,?,?,?,?,?,1)")
      .run(randomUUID(), "free", "Free", "Explore the workspace and use non-billable local editing tools.", 0, "USD", "month", 0,
        safeJson({ seats: 1, concurrentJobs: 1, storageBytes: 268435456, modelAllowlist: [] }),
        safeJson(["Creative planning", "Project workspace", "Local editing and export where runtime permits"]));
  }
}

export function touchBillingAccount(db, user, { env = process.env } = {}) {
  if (!user?.id || !user?.email) throw fail("Authenticated user identity is required.", "BILLING_USER_REQUIRED", 401);
  db.prepare(`INSERT INTO billing_accounts(user_id,email,status) VALUES(?,?,'active')
    ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(String(user.id), String(user.email).trim().toLowerCase());
  const active = db.prepare(`SELECT id FROM billing_subscriptions WHERE user_id=? AND status IN ('active','trialing','past_due') AND current_period_end>? ORDER BY current_period_end DESC LIMIT 1`)
    .get(String(user.id), isoNow());
  if (!active) {
    const free = db.prepare("SELECT id FROM billing_plans WHERE code='free' AND active=1").get();
    if (free) {
      const start = isoNow(), end = new Date(Date.now() + 3650 * 86400000).toISOString();
      db.prepare("INSERT INTO billing_subscriptions(id,user_id,plan_id,status,provider,current_period_start,current_period_end) VALUES(?,?,?,'active','system',?,?)")
        .run(randomUUID(), String(user.id), free.id, start, end);
    }
  }
  if (billingEnforcementEnabled(env)) applyDailyFreeCredits(db,String(user.id),{env});
  return db.prepare("SELECT status FROM billing_accounts WHERE user_id=?").get(String(user.id));
}

export function getBillingBalance(db, userId, at = isoNow()) {
  const row = db.prepare("SELECT COALESCE(SUM(amount),0) AS balance FROM billing_credit_ledger WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)").get(userId, at);
  return Number(row?.balance || 0);
}

export const BILLING_CREDIT_COSTS = Object.freeze({
  "text.generate": 1,
  "text.summarize": 1,
  "text.translate": 1,
  "voice.generate": 2,
  "voice.transcribe": 1,
  "image.generate": 3,
  "video.generate": 15
});

export function billingEnforcementEnabled(env=process.env) {
  return env.BILLING_ENFORCEMENT_ENABLED === "true" || env.CREDITS_ENABLED === "true";
}

export function billingDailyFreeCredits(env=process.env) {
  const raw=env.CREDITS_DAILY_FREE;
  if(raw===undefined||raw==="")return 20;
  if(!/^[0-9]+$/.test(String(raw))||Number(raw)>10000)throw fail("CREDITS_DAILY_FREE must be a whole number from 0 to 10000.","BILLING_CREDIT_CONFIG_INVALID",500);
  return Number(raw);
}

function applyDailyFreeCreditsInTransaction(db,userId,{now=Date.now(),env=process.env}={}) {
  if(!billingEnforcementEnabled(env))return {granted:0,balance:getBillingBalance(db,userId,new Date(now).toISOString())};
  const timestamp=new Date(now).toISOString();
  const day=timestamp.slice(0,10);
  const inserted=db.prepare("INSERT OR IGNORE INTO billing_daily_refills(user_id,refill_day) VALUES(?,?)").run(userId,day);
  if(inserted.changes!==1)return {granted:0,balance:getBillingBalance(db,userId,timestamp)};
  const target=billingDailyFreeCredits(env);
  const balance=getBillingBalance(db,userId,timestamp);
  const amount=Math.max(0,target-balance);
  if(amount>0){
    const nextDay=new Date(Date.parse(day+"T00:00:00.000Z")+86400000).toISOString();
    db.prepare(`INSERT INTO billing_credit_ledger
      (id,user_id,amount,event_type,description,reference_id,idempotency_key,expires_at,metadata_json)
      VALUES(?,?,?,'migration','Daily free credits',?,?,?,?)`)
      .run(randomUUID(),userId,amount,day,"daily-free:"+userId+":"+day,nextDay,safeJson({source:"daily_free",dailyAllowance:target}));
  }
  return {granted:amount,balance:balance+amount};
}

export function applyDailyFreeCredits(db,userId,{now=Date.now(),env=process.env}={}) {
  if(!billingEnforcementEnabled(env))return {granted:0,balance:getBillingBalance(db,userId,new Date(now).toISOString())};
  const day=new Date(now).toISOString().slice(0,10);
  const existing=db.prepare("SELECT 1 AS found FROM billing_daily_refills WHERE user_id=? AND refill_day=?").get(userId,day);
  if(existing)return {granted:0,balance:getBillingBalance(db,userId,new Date(now).toISOString())};
  db.exec("BEGIN IMMEDIATE");
  try{
    const result=applyDailyFreeCreditsInTransaction(db,userId,{now,env});
    db.exec("COMMIT");
    return result;
  }catch(error){db.exec("ROLLBACK");throw error;}
}

/**
 * Resolve a conservative customer-credit preflight from a verified provider
 * price record. Dynamic pricing is opt-in: the platform owner must configure
 * the USD value of one credit and a markup in basis points. If either is
 * absent, the established flat capability schedule remains in force.
 */
export function resolveBillingCreditCost(db, {
  capability, provider, model, unit, quantity = 1, runwayPricing = null, runwayRouterEstimateCredits = null, env = process.env
} = {}) {
  const fallback = Object.prototype.hasOwnProperty.call(BILLING_CREDIT_COSTS, capability)
    ? BILLING_CREDIT_COSTS[capability] : 1;
  const providerName = String(provider || "").trim().toLowerCase();
  const modelName = String(model || "").trim();
  const unitName = String(unit || "").trim();
  const count = Number(quantity);
  const creditValueConfigured = env.BILLING_CREDIT_VALUE_MICROS !== undefined && env.BILLING_CREDIT_VALUE_MICROS !== "";
  const creditValueMicros = Number(env.BILLING_CREDIT_VALUE_MICROS);
  const markupBps = env.BILLING_COST_MARKUP_BPS === undefined || env.BILLING_COST_MARKUP_BPS === ""
    ? 5000 : Number(env.BILLING_COST_MARKUP_BPS);
  if (creditValueConfigured && (!Number.isSafeInteger(creditValueMicros) || creditValueMicros <= 0)) {
    throw fail("BILLING_CREDIT_VALUE_MICROS must be a positive integer.", "BILLING_COST_CONFIG_INVALID", 500);
  }
  if (env.BILLING_COST_MARKUP_BPS !== undefined && env.BILLING_COST_MARKUP_BPS !== "" &&
      (!Number.isSafeInteger(markupBps) || markupBps < 0 || markupBps > 50000)) {
    throw fail("BILLING_COST_MARKUP_BPS must be an integer from 0 to 50000.", "BILLING_COST_CONFIG_INVALID", 500);
  }
  if (providerName === "runway" && runwayRouterEstimateCredits !== null && runwayRouterEstimateCredits !== undefined && creditValueConfigured) {
    const estimatedCredits = Number(runwayRouterEstimateCredits);
    if (!Number.isSafeInteger(estimatedCredits) || estimatedCredits <= 0 || estimatedCredits > 100000000) {
      throw fail("Runway Model Router preflight estimate must be a positive integer credit amount.", "BILLING_RUNWAY_PRICING_INVALID", 503);
    }
    const rawCostMicros = estimatedCredits * 10000;
    if (!Number.isSafeInteger(rawCostMicros)) throw fail("Runway Model Router estimate exceeds the supported billing range.", "BILLING_COST_ESTIMATE_INVALID", 500);
    const markedCostMicros = Math.ceil(rawCostMicros * (10000 + markupBps) / 10000);
    if (!Number.isSafeInteger(markedCostMicros) || markedCostMicros <= 0) throw fail("Marked-up Runway Model Router estimate exceeds the supported billing range.", "BILLING_COST_ESTIMATE_INVALID", 500);
    const credits = Math.max(1, Math.ceil(markedCostMicros / creditValueMicros));
    if (!Number.isSafeInteger(credits) || credits > 100000000) throw fail("Runway Model Router estimate exceeds the supported credit range.", "BILLING_COST_ESTIMATE_INVALID", 500);
    return {
      credits, source: "runway_model_router_preflight_estimate", provider: providerName,
      model: modelName, capability, unit: unitName, quantity: Number(quantity) || 1,
      providerCostCredits: estimatedCredits, providerCostUsd: estimatedCredits * 0.01,
      rawCostMicros, markedCostMicros, currency: "USD", creditValueMicros, markupBps,
      pricingSource: "Runway Model Router dry-run response", evidenceType: "provider_preflight_estimate",
      billable: false, settlementEligible: false
    };
  }
  if (providerName === "runway" && runwayPricing && creditValueConfigured) {
    let estimate;
    try {
      const pricingDate = new Date().toISOString().slice(0, 10);
      if (capability === "image.generate") {
        estimate = estimateRunwayImageCredits({ ...runwayPricing, model: modelName, pricingDate });
      } else if (capability === "video.generate") {
        estimate = estimateRunwayVideoCredits({ ...runwayPricing, model: modelName, pricingDate });
      } else {
        throw fail("Runway published-price reservation is not configured for this capability.", "BILLING_RUNWAY_PRICING_UNSUPPORTED", 503);
      }
    } catch (error) {
      if (error?.status) throw error;
      throw fail(error?.message || "Runway published-price estimate failed.", error?.code || "BILLING_RUNWAY_PRICING_INVALID", 503);
    }
    const rawCostMicros = Math.round(Number(estimate.estimatedUsd) * 1000000);
    if (!Number.isSafeInteger(rawCostMicros) || rawCostMicros <= 0) {
      throw fail("Runway published-price estimate is outside the supported billing range.", "BILLING_COST_ESTIMATE_INVALID", 500);
    }
    const markedCostMicros = Math.ceil(rawCostMicros * (10000 + markupBps) / 10000);
    if (!Number.isSafeInteger(markedCostMicros) || markedCostMicros <= 0) {
      throw fail("Marked-up Runway estimate exceeds the supported billing range.", "BILLING_COST_ESTIMATE_INVALID", 500);
    }
    const credits = Math.max(1, Math.ceil(markedCostMicros / creditValueMicros));
    if (!Number.isSafeInteger(credits) || credits > 100000000) {
      throw fail("Runway estimate exceeds the supported credit range.", "BILLING_COST_ESTIMATE_INVALID", 500);
    }
    return {
      credits, source: "runway_published_price_estimate", provider: providerName,
      model: modelName, capability, unit: unitName, quantity: Number(quantity) || 1,
      providerCostCredits: estimate.estimatedCredits, providerCostUsd: estimate.estimatedUsd,
      rawCostMicros, markedCostMicros, currency: "USD", creditValueMicros, markupBps,
      pricingSource: estimate.source, pricingDate: estimate.pricingDate,
      pricingFormula: estimate.formula, evidenceType: estimate.evidenceType,
      billable: false, settlementEligible: false
    };
  }

  if (!creditValueConfigured || !providerName || !modelName || !unitName ||
      !Number.isSafeInteger(count) || count <= 0) {
    return { credits: fallback, source: "flat_capability_fallback", provider: providerName || null,
      model: modelName || null, unit: unitName || null, quantity: Number.isSafeInteger(count) && count > 0 ? count : 1 };
  }
  const row = db.prepare(`SELECT price_micros,currency,source_url,verified_at FROM billing_model_prices
    WHERE provider=? AND model=? AND capability=? AND unit=? AND active=1
    LIMIT 1`).get(providerName, modelName, capability, unitName);
  if (!row) {
    return { credits: fallback, source: "flat_capability_fallback", provider: providerName,
      model: modelName, unit: unitName, quantity: count };
  }
  if (!row.verified_at || !row.source_url || String(row.currency).toUpperCase() !== "USD" ||
      !Number.isSafeInteger(Number(row.price_micros)) || Number(row.price_micros) <= 0) {
    return { credits: fallback, source: "flat_capability_fallback", provider: providerName,
      model: modelName, unit: unitName, quantity: count };
  }
  const maxAgeDays = env.BILLING_MODEL_PRICE_MAX_AGE_DAYS === undefined || env.BILLING_MODEL_PRICE_MAX_AGE_DAYS === ""
    ? 30 : Number(env.BILLING_MODEL_PRICE_MAX_AGE_DAYS);
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 365) {
    throw fail("BILLING_MODEL_PRICE_MAX_AGE_DAYS must be an integer from 1 to 365.", "BILLING_COST_CONFIG_INVALID", 500);
  }
  const verifiedAtMs = Date.parse(row.verified_at);
  if (!Number.isFinite(verifiedAtMs) || verifiedAtMs > Date.now() + 5 * 60 * 1000 ||
      Date.now() - verifiedAtMs > maxAgeDays * 86400000) {
    throw fail("The configured provider price is stale or future-dated. Refresh its verified source before enabling generation.", "BILLING_MODEL_PRICE_STALE", 503);
  }
  const rawCost = Number(row.price_micros) * count;
  if (!Number.isSafeInteger(rawCost) || rawCost <= 0) {
    throw fail("Provider cost estimate exceeds the supported billing range.", "BILLING_COST_ESTIMATE_INVALID", 500);
  }
  const markedCost = Math.ceil(rawCost * (10000 + markupBps) / 10000);
  if (!Number.isSafeInteger(markedCost) || markedCost <= 0) {
    throw fail("Marked-up provider cost exceeds the supported billing range.", "BILLING_COST_ESTIMATE_INVALID", 500);
  }
  const credits = Math.max(1, Math.ceil(markedCost / creditValueMicros));
  if (!Number.isSafeInteger(credits) || credits > 100000000) {
    throw fail("Provider cost estimate exceeds the supported credit range.", "BILLING_COST_ESTIMATE_INVALID", 500);
  }
  return { credits, source: "verified_model_price", provider: providerName, model: modelName,
    capability, unit: unitName, quantity: count, priceMicrosPerUnit: Number(row.price_micros),
    rawCostMicros: rawCost, markedCostMicros: markedCost, currency: "USD",
    creditValueMicros, markupBps, sourceUrl: row.source_url, verifiedAt: row.verified_at };
}

export function spendBillingCredits(db,{
  userId,capability,referenceId=null,idempotencyKey,now=Date.now(),env=process.env,costContext=null
}={}) {
  if(!billingEnforcementEnabled(env))return {enabled:false,charged:0,balance:getBillingBalance(db,userId)};
  const costEstimate=resolveBillingCreditCost(db,{capability,...(costContext||{}),env});
  const cost=costEstimate.credits;
  const key=String(idempotencyKey||"").trim();
  if(!userId||key.length<8||key.length>200)throw fail("Credit spend requires a user and idempotency key.","BILLING_IDEMPOTENCY_REQUIRED",400);
  // Commit the daily allowance independently so an insufficient paid request
  // cannot roll back a user's free credits.
  applyDailyFreeCredits(db,userId,{now,env});
  db.exec("BEGIN IMMEDIATE");
  try{
    const account=db.prepare("SELECT status FROM billing_accounts WHERE user_id=?").get(userId);
    if(!account)throw fail("Billing account was not found.","BILLING_TARGET_NOT_FOUND",404);
    if(account.status!=="active")throw fail("This account is suspended and cannot use paid generation.","BILLING_ACCOUNT_SUSPENDED",403);
    const existing=db.prepare("SELECT id,user_id,amount FROM billing_credit_ledger WHERE idempotency_key=?").get(key);
    if(existing&&existing.user_id!==userId)throw fail("This idempotency key belongs to another account.","BILLING_IDEMPOTENCY_CONFLICT",409);
    if(existing){db.exec("COMMIT");return {enabled:true,charged:Math.max(0,-Number(existing.amount)),replayed:true,balance:getBillingBalance(db,userId,new Date(now).toISOString())};}
    const at=new Date(now).toISOString();
    const balance=getBillingBalance(db,userId,at);
    if(balance<cost)throw fail("Not enough credits for this operation. You have "+balance+" and it requires "+cost+". Free credits refill daily.","BILLING_INSUFFICIENT_CREDITS",402);
    const id=randomUUID();
    db.prepare(`INSERT INTO billing_credit_ledger
      (id,user_id,amount,event_type,description,reference_id,idempotency_key,metadata_json)
      VALUES(?,?,?,'generation_spend',?,?,?,?)`)
      .run(id,userId,-cost,String(capability||"remote generation").slice(0,180),referenceId?String(referenceId).slice(0,240):null,key,safeJson({capability,cost,costEstimate}));
    db.exec("COMMIT");
    return {enabled:true,charged:cost,replayed:false,balance:getBillingBalance(db,userId,at),ledgerId:id,costEstimate};
  }catch(error){db.exec("ROLLBACK");throw error;}
}

export function refundBillingCredits(db,{userId,spendIdempotencyKey,reason="Provider request failed",now=Date.now()}={}) {
  const key=String(spendIdempotencyKey||"").trim();
  if(!userId||key.length<8)throw fail("Credit refund requires the original spend reference.","BILLING_REFUND_INVALID");
  db.exec("BEGIN IMMEDIATE");
  try{
    const spend=db.prepare("SELECT id,amount,reference_id FROM billing_credit_ledger WHERE user_id=? AND idempotency_key=? AND event_type='generation_spend'").get(userId,key);
    if(!spend){db.exec("COMMIT");return {refunded:0,balance:getBillingBalance(db,userId,new Date(now).toISOString())};}
    const refundKey="generation-refund:"+spend.id;
    const existing=db.prepare("SELECT id FROM billing_credit_ledger WHERE idempotency_key=?").get(refundKey);
    if(existing){db.exec("COMMIT");return {refunded:0,replayed:true,balance:getBillingBalance(db,userId,new Date(now).toISOString())};}
    const amount=Math.abs(Number(spend.amount));
    const id=randomUUID();
    db.prepare(`INSERT INTO billing_credit_ledger
      (id,user_id,amount,event_type,description,reference_id,idempotency_key,metadata_json)
      VALUES(?,?,?,'generation_refund',?,?,?,?)`)
      .run(id,userId,amount,String(reason).slice(0,240),spend.reference_id,refundKey,safeJson({originalSpendId:spend.id}));
    db.exec("COMMIT");
    return {refunded:amount,replayed:false,balance:getBillingBalance(db,userId,new Date(now).toISOString())};
  }catch(error){db.exec("ROLLBACK");throw error;}
}


/**
 * Reconcile a completed provider operation against the original customer
 * credit spend. The original spend is never edited: a single immutable
 * settlement row and, when needed, one compensating ledger entry are written
 * in the same transaction. Actual usage must carry provider evidence.
 */
export function settleBillingSpend(db, {
  userId, spendIdempotencyKey, settlementKey, actualCredits,
  evidence = {}, now = Date.now()
} = {}) {
  const spendKey=String(spendIdempotencyKey||"").trim();
  const settleKey=String(settlementKey||"").trim();
  const actual=Number(actualCredits);
  const provider=String(evidence?.provider||"").trim().toLowerCase();
  const evidenceType=String(evidence?.evidenceType||"").trim();
  const evidenceId=String(evidence?.evidenceId||"").trim();
  const allowedEvidence=new Set([
    "provider_task_receipt","provider_invoice","provider_usage_reconciliation",
    "provider_cancelled_no_charge"
  ]);
  if(!userId||spendKey.length<8||spendKey.length>200||
     settleKey.length<8||settleKey.length>200||
     !Number.isSafeInteger(actual)||actual<0||actual>100000000||
     !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(provider)||
     !allowedEvidence.has(evidenceType)||!evidenceId||evidenceId.length>240) {
    throw fail("Credit settlement requires a valid spend, idempotency key, actual credits and provider evidence.","BILLING_SETTLEMENT_INVALID",400);
  }
  const evidenceJson=safeJson({
    provider,evidenceType,evidenceId,
    providerTaskId:evidence.providerTaskId?String(evidence.providerTaskId).slice(0,240):null,
    invoiceReference:evidence.invoiceReference?String(evidence.invoiceReference).slice(0,240):null
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    const spend=db.prepare(`SELECT id,user_id,amount,event_type,reference_id
      FROM billing_credit_ledger WHERE user_id=? AND idempotency_key=?`).get(userId,spendKey);
    if(!spend||spend.event_type!=="generation_spend"||Number(spend.amount)>=0) {
      throw fail("The original generation spend was not found for this account.","BILLING_SETTLEMENT_SPEND_NOT_FOUND",404);
    }
    const estimated=Math.abs(Number(spend.amount));
    const existing=db.prepare(`SELECT id,user_id,spend_ledger_id,settlement_key,
      estimated_credits,actual_credits,adjustment_ledger_id
      FROM billing_credit_settlements WHERE spend_ledger_id=? OR settlement_key=?`)
      .get(spend.id,settleKey);
    if(existing) {
      if(existing.user_id!==userId||existing.spend_ledger_id!==spend.id||
         existing.settlement_key!==settleKey||Number(existing.actual_credits)!==actual) {
        throw fail("This credit spend or settlement key was already reconciled with different evidence or actual usage.","BILLING_SETTLEMENT_CONFLICT",409);
      }
      db.exec("COMMIT");
      return {
        settled:true,replayed:true,estimatedCredits:Number(existing.estimated_credits),
        actualCredits:Number(existing.actual_credits),
        adjustmentCredits:estimated-actual,
        balance:getBillingBalance(db,userId,new Date(now).toISOString()),
        settlementId:existing.id,adjustmentLedgerId:existing.adjustment_ledger_id||null
      };
    }
    const delta=estimated-actual;
    const settlementId=randomUUID();
    let adjustmentLedgerId=null;
    if(delta!==0) {
      adjustmentLedgerId=randomUUID();
      const eventType=delta>0?"generation_refund":"generation_spend";
      const description=delta>0?"Provider usage settlement refund":"Provider usage settlement additional charge";
      db.prepare(`INSERT INTO billing_credit_ledger
        (id,user_id,amount,event_type,description,reference_id,idempotency_key,metadata_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(adjustmentLedgerId,userId,delta,eventType,description,
          spend.reference_id,"billing-settlement:"+settleKey,
          safeJson({originalSpendId:spend.id,estimatedCredits:estimated,actualCredits:actual,evidence:JSON.parse(evidenceJson)}),
          new Date(now).toISOString());
    }
    db.prepare(`INSERT INTO billing_credit_settlements
      (id,user_id,spend_ledger_id,settlement_key,estimated_credits,actual_credits,adjustment_ledger_id,metadata_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(settlementId,userId,spend.id,settleKey,estimated,actual,adjustmentLedgerId,evidenceJson,new Date(now).toISOString());
    db.exec("COMMIT");
    return {
      settled:true,replayed:false,estimatedCredits:estimated,actualCredits:actual,
      adjustmentCredits:delta,balance:getBillingBalance(db,userId,new Date(now).toISOString()),
      settlementId,adjustmentLedgerId
    };
  } catch(error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listBillingPlans(db, { activeOnly = true } = {}) {
  const rows = db.prepare("SELECT * FROM billing_plans " + (activeOnly ? "WHERE active=1 " : "") + "ORDER BY amount_minor ASC,name ASC").all();
  return rows.map(row => ({
    id: row.id, code: row.code, name: row.name, description: row.description,
    amountMinor: row.amount_minor === null ? null : Number(row.amount_minor), currency: row.currency,
    interval: row.interval, creditsPerPeriod: Number(row.credits_per_period),
    limits: parseJson(row.limits_json), features: parseJson(row.features_json), active: !!row.active
  }));
}

export function assertBillingStorageQuota({ limitBytes, usedBytes = 0, incomingBytes = 0 } = {}) {
  if (limitBytes === null || limitBytes === undefined) return { allowed: true, unlimited: true };
  const limit=Number(limitBytes),used=Number(usedBytes),incoming=Number(incomingBytes);
  if (!Number.isSafeInteger(limit)||limit<0||!Number.isSafeInteger(used)||used<0||!Number.isSafeInteger(incoming)||incoming<0) {
    throw fail("Storage quota values must be non-negative safe integers.", "BILLING_STORAGE_QUOTA_CONFIG_INVALID", 500);
  }
  if (used+incoming>limit) {
    throw Object.assign(fail("This upload would exceed the storage allowance for the current plan.", "BILLING_STORAGE_QUOTA_EXCEEDED", 413), {
      limitBytes:limit,usedBytes:used,incomingBytes:incoming,remainingBytes:Math.max(0,limit-used)
    });
  }
  return { allowed:true,limitBytes:limit,usedBytes:used,incomingBytes:incoming,remainingBytes:limit-used-incoming };
}

export function assertConcurrentJobCapacity(db, { userId, limit, excludeJobId = null } = {}) {
  const maximum=Number(limit);
  if (!userId||!Number.isSafeInteger(maximum)||maximum<1||maximum>1000) {
    throw fail("The concurrent job allowance is not configured correctly.", "BILLING_CONCURRENCY_CONFIG_INVALID", 500);
  }
  const current=Number(db.prepare(`SELECT COUNT(*) AS count FROM jobs
    WHERE owner_id=? AND status IN ('queued','running','reviewing') AND (? IS NULL OR id<>?)`)
    .get(String(userId),excludeJobId,excludeJobId).count||0);
  if(current>=maximum){
    throw Object.assign(fail("Your plan's concurrent job limit has been reached. Wait for an existing job to finish or upgrade your plan.", "BILLING_CONCURRENT_JOB_LIMIT", 429), {
      limit:maximum,used:current
    });
  }
  return { allowed:true,limit:maximum,used:current };
}

export function getBillingOverview(db, userId) {
  const at = isoNow();
  const subscription = db.prepare(`SELECT s.*,p.code AS plan_code,p.name AS plan_name,p.description AS plan_description,
    p.amount_minor,p.currency,p.interval,p.credits_per_period,p.limits_json,p.features_json
    FROM billing_subscriptions s JOIN billing_plans p ON p.id=s.plan_id
    WHERE s.user_id=? AND s.status IN ('active','trialing','past_due') AND s.current_period_end>?
    ORDER BY s.current_period_end DESC LIMIT 1`).get(userId, at);
  const account = db.prepare("SELECT status FROM billing_accounts WHERE user_id=?").get(userId);
  const usage = db.prepare(`SELECT COUNT(*) AS operations,COALESCE(SUM(estimated_cost_micros),0) AS estimated_cost_micros
    FROM model_usage_events WHERE owner_id=? AND created_at>=?`).get(userId, new Date(Date.now()-30*86400000).toISOString());
  const ledger = db.prepare("SELECT id,amount,event_type,description,reference_id,expires_at,created_at FROM billing_credit_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 30").all(userId);
  const plan = subscription ? {
    id: subscription.plan_id, code: subscription.plan_code, name: subscription.plan_name,
    description: subscription.plan_description, amountMinor: subscription.amount_minor === null ? null : Number(subscription.amount_minor),
    currency: subscription.currency, interval: subscription.interval, creditsPerPeriod: Number(subscription.credits_per_period),
    limits: parseJson(subscription.limits_json), features: parseJson(subscription.features_json)
  } : null;
  return {
    accountStatus: account?.status || "active",
    balance: getBillingBalance(db, userId, at),
    plan,
    subscription: subscription ? { id: subscription.id, status: subscription.status, provider: subscription.provider,
      currentPeriodStart: subscription.current_period_start, currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: !!subscription.cancel_at_period_end } : null,
    usage30d: { operations: Number(usage.operations || 0), estimatedCostMicros: Number(usage.estimated_cost_micros || 0) },
    ledger: ledger.map(row => ({ id: row.id, amount: Number(row.amount), type: row.event_type, description: row.description,
      referenceId: row.reference_id, expiresAt: row.expires_at, createdAt: row.created_at }))
  };
}

export function getAdminOverview(db) {
  const users = db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,SUM(CASE WHEN status='suspended' THEN 1 ELSE 0 END) AS suspended FROM billing_accounts").get();
  const subscriptions = db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status IN ('active','trialing') AND current_period_end>? THEN 1 ELSE 0 END) AS active,SUM(CASE WHEN status='past_due' AND current_period_end>? THEN 1 ELSE 0 END) AS past_due FROM billing_subscriptions").get(isoNow(),isoNow());
  const jobs = db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status IN ('queued','running','reviewing') THEN 1 ELSE 0 END) AS in_flight FROM jobs").get();
  const since = new Date(Date.now()-30*86400000).toISOString();
  const usage = db.prepare("SELECT COUNT(*) AS operations,COALESCE(SUM(estimated_cost_micros),0) AS estimated_cost_micros FROM model_usage_events WHERE created_at>=?").get(since);
  const receipts = new Map();
  const addReceipt = (currency, amount) => {
    const code=String(currency||"").toUpperCase(),value=Number(amount);
    if(!/^[A-Z]{3}$/.test(code)||!Number.isSafeInteger(value)||value<=0)return;
    receipts.set(code,(receipts.get(code)||0)+value);
  };
  const hasPaymentOrders = !!db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='billing_payment_orders'").get();
  if(hasPaymentOrders){
    const topups = db.prepare("SELECT expected_amount_minor,currency FROM billing_payment_orders WHERE status='paid' AND verified_at>=?").all(since);
    for(const row of topups)addReceipt(row.currency,row.expected_amount_minor);
  }
  const eventColumns = new Set(db.prepare("PRAGMA table_info(billing_provider_events)").all().map(row=>row.name));
  const dodoEvents = eventColumns.has("payload_json")
    ? db.prepare("SELECT event_id,payload_json FROM billing_provider_events WHERE provider='dodo' AND processed_at IS NOT NULL AND created_at>=? AND event_type IN ('subscription.active','subscription.renewed')").all(since)
    : [];
  const seenPayments = new Set();
  for(const row of dodoEvents){
    const data=parseJson(row.payload_json)?.data||{};
    const paymentId=String(data.payment_id||"");
    if(!paymentId||seenPayments.has(paymentId))continue;
    seenPayments.add(paymentId);
    addReceipt(data.currency,data.recurring_pre_tax_amount);
  }
  const mrr = new Map();
  const activePlans = db.prepare(`SELECT p.amount_minor,p.currency,p.interval FROM billing_subscriptions s
    JOIN billing_plans p ON p.id=s.plan_id
    WHERE s.status IN ('active','trialing') AND s.current_period_end>? AND p.active=1
      AND p.amount_minor>0 AND p.interval IN ('month','year')`).all(isoNow());
  for(const row of activePlans){
    const currency=String(row.currency||"").toUpperCase();
    const amount=Number(row.amount_minor);
    if(!/^[A-Z]{3}$/.test(currency)||!Number.isSafeInteger(amount)||amount<=0)continue;
    const monthly=row.interval==="year"?Math.ceil(amount/12):amount;
    mrr.set(currency,(mrr.get(currency)||0)+monthly);
  }
  const oneTimeCreditTopupsEnabled=process.env.BILLING_CHECKOUT_ENABLED==="true"&&billingEnforcementEnabled()&&
    !!(process.env.FLW_SECRET_KEY&&process.env.FLW_WEBHOOK_SECRET&&process.env.PUBLIC_APP_URL);
  const recurringSubscriptionsEnabled=process.env.DODO_SUBSCRIPTIONS_ENABLED==="true"&&
    process.env.DODO_MERCHANT_APPROVED==="true"&&billingEnforcementEnabled()&&
    !!(process.env.DODO_PAYMENTS_API_KEY&&process.env.DODO_PAYMENTS_WEBHOOK_KEY&&process.env.PUBLIC_APP_URL)&&
    Object.entries(process.env).some(([key,value])=>key.startsWith("DODO_PRODUCT_ID_")&&/^pdt_[A-Za-z0-9_-]{6,120}$/.test(String(value||"")));
  const refundTableExists=!!db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='billing_refund_events'").get();
  const pendingRefundReconciliation=refundTableExists?Number(db.prepare("SELECT COUNT(*) AS count FROM billing_refund_events WHERE reconciliation_required=1").get().count||0):0;
  return {
    users: { total: Number(users.total||0), active: Number(users.active||0), suspended: Number(users.suspended||0) },
    subscriptions: { total: Number(subscriptions.total||0), active: Number(subscriptions.active||0), pastDue: Number(subscriptions.past_due||0) },
    jobs: { total: Number(jobs.total||0), inFlight: Number(jobs.in_flight||0) },
    usage30d: { operations: Number(usage.operations||0), estimatedCostMicros: Number(usage.estimated_cost_micros||0) },
    verifiedGrossReceipts30d: [...receipts.entries()].map(([currency,amountMinor])=>({currency,amountMinor})).sort((a,b)=>a.currency.localeCompare(b.currency)),
    committedMrrByCurrency: [...mrr.entries()].map(([currency,amountMinor])=>({currency,amountMinor})).sort((a,b)=>a.currency.localeCompare(b.currency)),
    pendingRefundReconciliation,
    billingProviderConfigured: !!(process.env.FLW_SECRET_KEY || process.env.DODO_PAYMENTS_API_KEY),
    paymentCollectionEnabled: oneTimeCreditTopupsEnabled||recurringSubscriptionsEnabled,
    oneTimeCreditTopupsEnabled,
    recurringSubscriptionsEnabled
  };
}

export function listAdminUsers(db, { query = "", limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  const term = String(query || "").trim().toLowerCase();
  const rows = term
    ? db.prepare(`SELECT a.user_id,a.email,a.status,a.created_at,a.last_seen_at,
        (SELECT p.name FROM billing_subscriptions s JOIN billing_plans p ON p.id=s.plan_id WHERE s.user_id=a.user_id AND s.status IN ('active','trialing','past_due') ORDER BY s.current_period_end DESC LIMIT 1) AS plan_name,
        (SELECT COALESCE(SUM(l.amount),0) FROM billing_credit_ledger l WHERE l.user_id=a.user_id AND (l.expires_at IS NULL OR l.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) AS credit_balance
        FROM billing_accounts a WHERE lower(a.email) LIKE ? ORDER BY a.last_seen_at DESC LIMIT ?`).all("%"+term+"%", safeLimit)
    : db.prepare(`SELECT a.user_id,a.email,a.status,a.created_at,a.last_seen_at,
        (SELECT p.name FROM billing_subscriptions s JOIN billing_plans p ON p.id=s.plan_id WHERE s.user_id=a.user_id AND s.status IN ('active','trialing','past_due') ORDER BY s.current_period_end DESC LIMIT 1) AS plan_name,
        (SELECT COALESCE(SUM(l.amount),0) FROM billing_credit_ledger l WHERE l.user_id=a.user_id AND (l.expires_at IS NULL OR l.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) AS credit_balance
        FROM billing_accounts a ORDER BY a.last_seen_at DESC LIMIT ?`).all(safeLimit);
  return rows.map(row => ({ id: row.user_id, email: row.email, status: row.status, createdAt: row.created_at, lastSeenAt: row.last_seen_at, planName: row.plan_name || "No active plan", creditBalance: Number(row.credit_balance || 0) }));
}

export function saveBillingPlan(db, input) {
  const code = String(input.code || "").trim().toLowerCase();
  const name = String(input.name || "").trim();
  const description = String(input.description || "").trim();
  const currency = String(input.currency || "USD").trim().toUpperCase();
  const interval = String(input.interval || "month");
  const amount = input.amountMinor === null || input.amountMinor === undefined || input.amountMinor === "" ? null : Number(input.amountMinor);
  const credits = Number(input.creditsPerPeriod ?? 0);
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(code) || !name || name.length > 80 || description.length > 500) throw fail("Provide a valid plan code, name and description.", "BILLING_PLAN_INVALID");
  if (!/^[A-Z]{3}$/.test(currency) || !["month","year","one_time"].includes(interval)) throw fail("Currency or billing interval is invalid.", "BILLING_PLAN_INVALID");
  if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) throw fail("Price must be a non-negative integer in the smallest currency unit.", "BILLING_PLAN_INVALID");
  if (!Number.isSafeInteger(credits) || credits < 0 || credits > 100000000) throw fail("Credit allowance is invalid.", "BILLING_PLAN_INVALID");
  const rawLimits = input.limits && typeof input.limits === "object" && !Array.isArray(input.limits) ? input.limits : {};
  const seats = Number(rawLimits.seats ?? 1), concurrentJobs = Number(rawLimits.concurrentJobs ?? 1), storageBytes = Number(rawLimits.storageBytes ?? 0);
  const modelAllowlist = Array.isArray(rawLimits.modelAllowlist) ? [...new Set(rawLimits.modelAllowlist.filter(x => typeof x === "string").map(x => x.trim()).filter(Boolean))].slice(0,100) : [];
  if (![seats,concurrentJobs,storageBytes].every(Number.isSafeInteger) || seats < 1 || seats > 1000 || concurrentJobs < 1 || concurrentJobs > 1000 || storageBytes < 0) throw fail("Plan quotas are invalid.", "BILLING_PLAN_INVALID");
  const limits = { seats, concurrentJobs, storageBytes, modelAllowlist };
  const features = Array.isArray(input.features) ? input.features.filter(x => typeof x === "string").map(x => x.slice(0,120)).slice(0,40) : [];
  const active = input.active === false ? 0 : 1;
  const existing = db.prepare("SELECT id FROM billing_plans WHERE code=?").get(code);
  const id = existing?.id || randomUUID();
  db.prepare(`INSERT INTO billing_plans(id,code,name,description,amount_minor,currency,interval,credits_per_period,limits_json,features_json,active,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET name=excluded.name,description=excluded.description,amount_minor=excluded.amount_minor,currency=excluded.currency,
    interval=excluded.interval,credits_per_period=excluded.credits_per_period,limits_json=excluded.limits_json,features_json=excluded.features_json,
    active=excluded.active,updated_at=excluded.updated_at`)
    .run(id,code,name,description,amount,currency,interval,credits,safeJson(limits),safeJson(features),active);
  return listBillingPlans(db, { activeOnly: false }).find(plan => plan.code === code);
}

export function assignManualSubscription(db, { userId, planId, periodDays = 30, status = "active", actorId }) {
  const user = db.prepare("SELECT user_id FROM billing_accounts WHERE user_id=?").get(userId);
  const plan = db.prepare("SELECT * FROM billing_plans WHERE id=? AND active=1").get(planId);
  if (!user || !plan) throw fail("User or active plan was not found.", "BILLING_TARGET_NOT_FOUND", 404);
  if (!["trialing","active","past_due","paused","cancelled","expired"].includes(status)) throw fail("Subscription status is invalid.", "BILLING_STATUS_INVALID");
  if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > 3660) throw fail("Subscription period must be between 1 and 3660 days.", "BILLING_PERIOD_INVALID");
  const start = isoNow(), end = new Date(Date.now()+periodDays*86400000).toISOString(), id = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE billing_subscriptions SET status='cancelled',updated_at=? WHERE user_id=? AND status IN ('active','trialing','past_due')").run(start,userId);
    db.prepare("INSERT INTO billing_subscriptions(id,user_id,plan_id,status,provider,current_period_start,current_period_end,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
      .run(id,userId,planId,status,"manual",start,end,safeJson({assignedBy:actorId}));
    if (Number(plan.credits_per_period) > 0 && ["active","trialing"].includes(status)) {
      db.prepare("INSERT OR IGNORE INTO billing_credit_ledger(id,user_id,amount,event_type,description,reference_id,idempotency_key,expires_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(randomUUID(),userId,Number(plan.credits_per_period),"subscription_grant","Subscription allowance · "+plan.name,id,"subscription:"+id+":"+start,end,safeJson({planCode:plan.code}));
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { id, userId, planId, status, currentPeriodStart: start, currentPeriodEnd: end };
}

export function adjustBillingCredits(db, { userId, amount, description, actorId, idempotencyKey }) {
  const value = Number(amount);
  if (!Number.isSafeInteger(value) || value === 0 || Math.abs(value) > 100000000) throw fail("Credit adjustment must be a non-zero whole number.", "BILLING_CREDIT_INVALID");
  const user = db.prepare("SELECT user_id FROM billing_accounts WHERE user_id=?").get(userId);
  if (!user) throw fail("User was not found.", "BILLING_TARGET_NOT_FOUND", 404);
  const key = String(idempotencyKey || "").trim();
  if (key.length < 8 || key.length > 200) throw fail("A unique idempotency key is required.", "BILLING_IDEMPOTENCY_REQUIRED");
  const existing = db.prepare("SELECT id,user_id,amount FROM billing_credit_ledger WHERE idempotency_key=?").get(key);
  if (existing && existing.user_id !== userId) throw fail("This idempotency key was already used for another account.", "BILLING_IDEMPOTENCY_CONFLICT", 409);
  if (existing) return { id: existing.id, amount: Number(existing.amount), replayed: true, balance: getBillingBalance(db,userId) };
  db.exec("BEGIN IMMEDIATE");
  try {
    const balance = getBillingBalance(db,userId);
    if (balance + value < 0) throw fail("This adjustment would make the user's credit balance negative.", "BILLING_INSUFFICIENT_CREDITS", 409);
    const id = randomUUID();
    db.prepare("INSERT INTO billing_credit_ledger(id,user_id,amount,event_type,description,idempotency_key,metadata_json) VALUES(?,?,?,?,?,?,?)")
      .run(id,userId,value,value>0?"admin_grant":"admin_adjustment",String(description||"Administrator adjustment").slice(0,240),key,safeJson({actorId}));
    db.exec("COMMIT");
    return { id, amount: value, replayed: false, balance: getBillingBalance(db,userId) };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function setBillingAccountStatus(db, { userId, status }) {
  if (!["active","suspended"].includes(status)) throw fail("Account status is invalid.", "BILLING_STATUS_INVALID");
  const result = db.prepare("UPDATE billing_accounts SET status=? WHERE user_id=?").run(status,userId);
  if (!result.changes) throw fail("User was not found.", "BILLING_TARGET_NOT_FOUND", 404);
  return { userId, status };
}

export function listBillingLedger(db, userId, limit = 100) {
  return db.prepare("SELECT id,amount,event_type,description,reference_id,expires_at,created_at FROM billing_credit_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT ?")
    .all(userId,Math.max(1,Math.min(200,Number(limit)||100))).map(row => ({ id:row.id,amount:Number(row.amount),type:row.event_type,description:row.description,referenceId:row.reference_id,expiresAt:row.expires_at,createdAt:row.created_at }));
}

export function canUsePaidModels(db, userId) {
  const at=isoNow();
  const row = db.prepare(`SELECT p.limits_json FROM billing_subscriptions s JOIN billing_plans p ON p.id=s.plan_id
    WHERE s.user_id=? AND (s.status IN ('active','trialing') OR
      (s.status='past_due' AND json_extract(s.metadata_json,'$.pastDueEndsAt')>?))
      AND s.current_period_end>? ORDER BY s.current_period_end DESC LIMIT 1`).get(userId,at,at);
  if (!row) return false;
  const limits = parseJson(row.limits_json);
  return Array.isArray(limits.modelAllowlist) && limits.modelAllowlist.length > 0;
}

export function listBillingModelPrices(db) {
  return db.prepare("SELECT * FROM billing_model_prices ORDER BY provider,model,capability").all().map(row => ({
    id:row.id,provider:row.provider,model:row.model,capability:row.capability,unit:row.unit,
    priceMicros:Number(row.price_micros),currency:row.currency,sourceUrl:row.source_url,
    verifiedAt:row.verified_at,active:!!row.active
  }));
}

export function saveBillingModelPrice(db, input) {
  const provider=String(input.provider||"").trim().toLowerCase(),model=String(input.model||"").trim();
  const capability=String(input.capability||"").trim(),unit=String(input.unit||"").trim();
  const price=Number(input.priceMicros),currency=String(input.currency||"USD").trim().toUpperCase();
  const sourceUrl=String(input.sourceUrl||"").trim(),verifiedAt=String(input.verifiedAt||"").trim()||null;
  if(!provider||provider.length>80||!model||model.length>160||!capability||capability.length>80||!unit||unit.length>40||
    !Number.isSafeInteger(price)||price<0||!/^[A-Z]{3}$/.test(currency)||
    sourceUrl && (!/^https:\/\//i.test(sourceUrl)||sourceUrl.length>1000)||
    verifiedAt && Number.isNaN(Date.parse(verifiedAt))) throw fail("Model pricing record is invalid.", "BILLING_MODEL_PRICE_INVALID");
  const id=randomUUID();
  db.prepare(`INSERT INTO billing_model_prices(id,provider,model,capability,unit,price_micros,currency,source_url,verified_at,active,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(provider,model,capability,unit) DO UPDATE SET price_micros=excluded.price_micros,currency=excluded.currency,
    source_url=excluded.source_url,verified_at=excluded.verified_at,active=1,updated_at=excluded.updated_at`)
    .run(id,provider,model,capability,unit,price,currency,sourceUrl,verifiedAt);
  return listBillingModelPrices(db).find(row=>row.provider===provider&&row.model===model&&row.capability===capability&&row.unit===unit);
}
