import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { ensureCloudSubscriptionSyncSchema, enqueueCloudSubscriptionSync } from "./cloud-subscription-sync.mjs";

const now = () => new Date().toISOString();
const json = value => JSON.stringify(value ?? {});
const parse = value => { try { return value ? JSON.parse(value) : {}; } catch { return {}; } };
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function addBillingPeriod(startValue,interval){
  const start=new Date(startValue);
  if(!Number.isFinite(start.getTime()))throw fail("Subscription billing period start is invalid.","BILLING_PERIOD_INVALID",500);
  const year=start.getUTCFullYear(),month=start.getUTCMonth(),day=start.getUTCDate();
  if(interval==="year")return new Date(Date.UTC(year+1,month,Math.min(day,new Date(Date.UTC(year+1,month+1,0)).getUTCDate()),start.getUTCHours(),start.getUTCMinutes(),start.getUTCSeconds(),start.getUTCMilliseconds())).toISOString();
  if(interval!=="month")throw fail("Unsupported recurring subscription interval.","BILLING_PERIOD_INVALID",500);
  const targetMonth=month+1,targetYear=year+Math.floor(targetMonth/12),normalizedMonth=targetMonth%12;
  const lastDay=new Date(Date.UTC(targetYear,normalizedMonth+1,0)).getUTCDate();
  return new Date(Date.UTC(targetYear,normalizedMonth,Math.min(day,lastDay),start.getUTCHours(),start.getUTCMinutes(),start.getUTCSeconds(),start.getUTCMilliseconds())).toISOString();
}

function currencyExponent(currency) {
  const code = String(currency || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  if (["UGX", "RWF", "TZS", "JPY", "KRW", "XAF", "XOF", "XPF", "BIF", "DJF", "GNF", "KMF", "PYG", "VND", "VUV"].includes(code)) return 0;
  if (["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"].includes(code)) return 3;
  return 2;
}

export function ensureBillingWebhookSchema(db) {
  ensureCloudSubscriptionSyncSchema(db);
  const columns = new Set(db.prepare("PRAGMA table_info(billing_provider_events)").all().map(row => row.name));
  if (!columns.has("payload_json")) db.exec("ALTER TABLE billing_provider_events ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'");
  if (!columns.has("attempts")) db.exec("ALTER TABLE billing_provider_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("last_error")) db.exec("ALTER TABLE billing_provider_events ADD COLUMN last_error TEXT");
  if (!columns.has("lease_owner")) db.exec("ALTER TABLE billing_provider_events ADD COLUMN lease_owner TEXT");
  if (!columns.has("lease_expires_at")) db.exec("ALTER TABLE billing_provider_events ADD COLUMN lease_expires_at TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_payment_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES billing_accounts(user_id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES billing_plans(id),
      provider TEXT NOT NULL CHECK(provider IN ('flutterwave')),
      tx_ref TEXT NOT NULL UNIQUE,
      expected_amount_minor INTEGER NOT NULL CHECK(expected_amount_minor > 0),
      currency TEXT NOT NULL,
      credits INTEGER NOT NULL CHECK(credits > 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','expired')),
      provider_transaction_id TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS billing_payment_provider_tx_idx
      ON billing_payment_orders(provider,provider_transaction_id)
      WHERE provider_transaction_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS billing_payment_pending_idx
      ON billing_payment_orders(provider,status,created_at);
    CREATE TABLE IF NOT EXISTS billing_flutterwave_subscription_checkouts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES billing_accounts(user_id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES billing_plans(id),
      provider_payment_plan_id INTEGER NOT NULL,
      tx_ref TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','failed','cancelled')),
      provider_customer_id TEXT,
      provider_subscription_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS billing_flw_subscription_owner_idx
      ON billing_flutterwave_subscription_checkouts(user_id,status,created_at DESC);

    CREATE TABLE IF NOT EXISTS billing_refund_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      refund_id TEXT NOT NULL,
      payment_id TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      currency TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(provider,refund_id)
    );
    CREATE INDEX IF NOT EXISTS billing_refund_payment_idx
      ON billing_refund_events(provider,payment_id,created_at);
  `);
  const refundColumns=new Set(db.prepare("PRAGMA table_info(billing_refund_events)").all().map(row=>row.name));
  if(!refundColumns.has("user_id"))db.exec("ALTER TABLE billing_refund_events ADD COLUMN user_id TEXT");
  if(!refundColumns.has("reconciliation_required"))db.exec("ALTER TABLE billing_refund_events ADD COLUMN reconciliation_required INTEGER NOT NULL DEFAULT 0");
  if(!refundColumns.has("reconciliation_note"))db.exec("ALTER TABLE billing_refund_events ADD COLUMN reconciliation_note TEXT");
  if(!refundColumns.has("reconciled_at"))db.exec("ALTER TABLE billing_refund_events ADD COLUMN reconciled_at TEXT");
  if(!refundColumns.has("reconciled_by"))db.exec("ALTER TABLE billing_refund_events ADD COLUMN reconciled_by TEXT");
}

export function createBillingPurchaseOrder(db, { userId, planId, provider = "flutterwave" } = {}) {
  if (provider !== "flutterwave") throw fail("This checkout order adapter currently supports Flutterwave one-time payments only.", "BILLING_PROVIDER_UNSUPPORTED");
  const user = db.prepare("SELECT user_id,status FROM billing_accounts WHERE user_id=?").get(userId);
  const plan = db.prepare("SELECT * FROM billing_plans WHERE id=? AND active=1").get(planId);
  if (!user || user.status !== "active" || !plan) throw fail("Active account and plan are required.", "BILLING_TARGET_NOT_FOUND", 404);
  if (plan.interval !== "one_time" || !Number.isSafeInteger(Number(plan.amount_minor)) ||
      Number(plan.amount_minor) <= 0 || !Number.isSafeInteger(Number(plan.credits_per_period)) ||
      Number(plan.credits_per_period) <= 0 || currencyExponent(plan.currency) === null) {
    throw fail("Payment order requires an active one-time credit product with a supported currency and positive price.", "BILLING_PRODUCT_INVALID");
  }
  const id = randomUUID();
  const txRef = "ev_" + id.replaceAll("-", "");
  const timestamp = now();
  db.prepare(`INSERT INTO billing_payment_orders
    (id,user_id,plan_id,provider,tx_ref,expected_amount_minor,currency,credits,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?, 'pending',?,?)`)
    .run(id, userId, planId, provider, txRef, Number(plan.amount_minor), String(plan.currency).toUpperCase(),
      Number(plan.credits_per_period), timestamp, timestamp);
  return {
    id, userId, planId, provider, txRef,
    amountMinor: Number(plan.amount_minor), currency: String(plan.currency).toUpperCase(),
    credits: Number(plan.credits_per_period), status: "pending"
  };
}

/**
 * Flutterwave Standard API v3 webhooks use the dashboard-configured secret
 * hash in the "verif-hash" header. Transaction authenticity is then confirmed
 * independently against the v3 transaction-verification API before settlement.
 */
export function verifyFlutterwaveWebhookSignature({ rawBody, signature, secretHash } = {}) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 1024 * 1024 ||
      typeof secretHash !== "string" || secretHash.length < 24 || secretHash.length > 512 ||
      typeof signature !== "string" || signature.length > 512) return false;
  return safeEqual(signature, secretHash);
}

export function receiveFlutterwaveWebhook(db, { rawBody, signature, secretHash } = {}) {
  if (!verifyFlutterwaveWebhookSignature({ rawBody, signature, secretHash })) {
    throw fail("Flutterwave webhook signature is invalid.", "BILLING_WEBHOOK_SIGNATURE_INVALID", 401);
  }
  let payload;
  try { payload = JSON.parse(rawBody.toString("utf8")); }
  catch { throw fail("Flutterwave webhook body is not valid JSON.", "BILLING_WEBHOOK_INVALID", 400); }
  const eventType = String(payload?.event || "");
  const data = payload?.data;
  const transactionId = String(data?.id ?? "");
  const txRef = String(data?.tx_ref ?? "");
  const status = String(data?.status ?? "").toLowerCase();
  const amount = Number(data?.amount);
  const currency = String(data?.currency || "").toUpperCase();
  const cancellation=eventType==="subscription.cancelled";
  const customerEmail=String(data?.customer?.email||"").trim().toLowerCase();
  const paymentPlanId=String(data?.plan?.id??data?.payment_plan??"");
  if ((!cancellation&&![ "charge.completed", "charge.failed" ].includes(eventType)) ||
      (!cancellation&&(!/^[0-9]{1,30}$/.test(transactionId)||!/^[A-Za-z0-9_-]{1,128}$/.test(txRef)||
        !["successful","failed","pending"].includes(status)||!Number.isFinite(amount)||amount<0||currencyExponent(currency)===null)) ||
      (cancellation&&(!customerEmail.includes("@")||!/^[0-9]{1,18}$/.test(paymentPlanId)))) {
    throw fail("Flutterwave webhook event fields are invalid or unsupported.", "BILLING_WEBHOOK_INVALID", 400);
  }
  const eventId=cancellation
    ? "subscription.cancelled:"+createHash("sha256").update(customerEmail+":"+paymentPlanId).digest("hex")
    : eventType+":"+transactionId+":"+status;
  const knownOneTimeOrder=!cancellation&&!!db.prepare("SELECT 1 AS found FROM billing_payment_orders WHERE tx_ref=?").get(txRef);
  const minimalPayload=cancellation
    ? {event:eventType,data:{status:String(data.status||"deactivated"),currency,amount:Number(data.amount)||0,
        customer:{email:customerEmail},plan:{id:paymentPlanId}}}
    : {event:eventType,data:{id:transactionId,tx_ref:txRef,status,amount,currency,
        ...(!knownOneTimeOrder&& (customerEmail||data?.customer?.id)?{customer:{...(customerEmail?{email:customerEmail}:{}),...(data?.customer?.id?{id:String(data.customer.id)}:{})}}:{}),
        ...(!knownOneTimeOrder&&(data?.payment_plan||data?.plan?.id)?{payment_plan:String(data.payment_plan??data.plan.id)}:{}),
        ...(!knownOneTimeOrder&&data?.meta&&typeof data.meta==="object"?{meta:{subscription_checkout_id:String(data.meta.subscription_checkout_id||"")}}:{})}};
  // Hash the normalized fields that affect settlement, not provider-added
  // transport metadata such as timestamps or customer profile details.
  const payloadHash = createHash("sha256").update(json(minimalPayload)).digest("hex");
  const existing = db.prepare("SELECT payload_hash FROM billing_provider_events WHERE provider='flutterwave' AND event_id=?").get(eventId);
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw fail("Flutterwave reused an event identity with different content.", "BILLING_WEBHOOK_REPLAY_CONFLICT", 409);
    return { accepted: true, duplicate: true, eventId };
  }
  db.prepare(`INSERT INTO billing_provider_events
    (id,provider,event_id,event_type,payload_hash,payload_json,created_at)
    VALUES(?,?,?,?,?,?,?)`)
    .run(randomUUID(), "flutterwave", eventId, eventType, payloadHash, json(minimalPayload), now());
  return { accepted: true, duplicate: false, eventId };
}

export async function verifyFlutterwaveTransaction({ transactionId, secretKey, fetchImpl = fetch } = {}) {
  if (!/^[0-9]{1,30}$/.test(String(transactionId || "")) ||
      typeof secretKey !== "string" || secretKey.length < 12) {
    throw fail("Flutterwave transaction verification is not configured.", "BILLING_PROVIDER_CONFIG_INVALID", 503);
  }
  const response = await fetchImpl("https://api.flutterwave.com/v3/transactions/" +
    encodeURIComponent(String(transactionId)) + "/verify", {
    method: "GET",
    headers: { authorization: "Bearer " + secretKey, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw fail("Flutterwave transaction verification request failed.", "BILLING_PROVIDER_VERIFY_FAILED", 502);
  const body = await response.json();
  if (body?.status !== "success" || !body?.data) throw fail("Flutterwave did not return verified transaction data.", "BILLING_PROVIDER_VERIFY_FAILED", 502);
  return body.data;
}


export function flutterwavePaymentPlanEnvName(planCode) {
  const suffix=String(planCode||"").toUpperCase().replace(/[^A-Z0-9]+/g,"_").replace(/^_+|_+$/g,"");
  return suffix ? "FLW_PAYMENT_PLAN_ID_"+suffix : "";
}

export function flutterwaveRecurringCheckoutEnabled(env=process.env) {
  return env.FLW_SUBSCRIPTIONS_ENABLED==="true" && env.FLW_MERCHANT_APPROVED==="true" &&
    (env.BILLING_ENFORCEMENT_ENABLED==="true"||env.CREDITS_ENABLED==="true") &&
    !!(env.FLW_SECRET_KEY&&env.FLW_WEBHOOK_SECRET&&env.PUBLIC_APP_URL);
}

export async function createFlutterwaveSubscriptionCheckout(db,{
  user,planId,secretKey,publicAppUrl,env=process.env,fetchImpl=fetch
}={}) {
  if(!flutterwaveRecurringCheckoutEnabled({...env,FLW_SECRET_KEY:secretKey,FLW_WEBHOOK_SECRET:env.FLW_WEBHOOK_SECRET,PUBLIC_APP_URL:publicAppUrl})) {
    throw fail("Flutterwave recurring checkout is disabled until merchant approval, payment-plan mapping, webhook secret and billing enforcement are configured.","FLW_SUBSCRIPTIONS_DISABLED",503);
  }
  if(!user?.id||!user?.email)throw fail("Authenticated customer identity is required.","BILLING_USER_REQUIRED",401);
  const account=db.prepare("SELECT status FROM billing_accounts WHERE user_id=?").get(String(user.id));
  const plan=db.prepare("SELECT * FROM billing_plans WHERE id=? AND active=1").get(planId);
  if(!account||account.status!=="active"||!plan)throw fail("Active account and recurring plan are required.","BILLING_TARGET_NOT_FOUND",404);
  if(!["month","year"].includes(plan.interval)||!Number.isSafeInteger(Number(plan.amount_minor))||
    Number(plan.amount_minor)<=0||!Number.isSafeInteger(Number(plan.credits_per_period))||
    Number(plan.credits_per_period)<=0||currencyExponent(plan.currency)===null) {
    throw fail("Flutterwave recurring checkout requires a priced monthly or yearly plan with positive credits.","BILLING_PRODUCT_INVALID");
  }
  const envName=flutterwavePaymentPlanEnvName(plan.code);
  const paymentPlanId=String(env[envName]||"");
  if(!/^\d{1,18}$/.test(paymentPlanId)||!Number.isSafeInteger(Number(paymentPlanId))||Number(paymentPlanId)<=0)throw fail("The Flutterwave payment-plan ID for this plan is not configured or is outside the safe numeric range.","FLW_PAYMENT_PLAN_NOT_CONFIGURED",503);
  let base;
  try{base=new URL(publicAppUrl);}catch{throw fail("A valid public application URL is required.","BILLING_REDIRECT_URL_INVALID",503);}
  const local=["localhost","127.0.0.1"].includes(base.hostname);
  if(base.protocol!=="https:"&&!(local&&env.NODE_ENV!=="production"))throw fail("Payment return URLs must use HTTPS.","BILLING_REDIRECT_URL_INVALID",503);
  if(base.username||base.password||base.search||base.hash)throw fail("Public application URL must not contain credentials, query parameters or fragments.","BILLING_REDIRECT_URL_INVALID",503);
  const id=randomUUID(),txRef="ev_"+id.replaceAll("-","");
  const timestamp=now();
  db.prepare(`INSERT INTO billing_flutterwave_subscription_checkouts
    (id,user_id,plan_id,provider_payment_plan_id,tx_ref,status,created_at,updated_at)
    VALUES(?,?,?,?,?,'pending',?,?)`).run(id,String(user.id),plan.id,Number(paymentPlanId),txRef,timestamp,timestamp);
  const exponent=currencyExponent(plan.currency);
  const amount=Number(plan.amount_minor)/(10**exponent);
  let response;
  try{
    response=await fetchImpl("https://api.flutterwave.com/v3/payments",{
      method:"POST",headers:{authorization:"Bearer "+secretKey,"content-type":"application/json",accept:"application/json"},
      body:JSON.stringify({tx_ref:txRef,amount,currency:String(plan.currency).toUpperCase(),
        redirect_url:(()=>{const result=new URL("/billing/return",base);result.searchParams.set("provider","flutterwave_subscription");result.searchParams.set("order_id",id);return result.toString();})(),
        customer:{email:String(user.email).trim().toLowerCase()},
        customizations:{title:"Executive Visuals",description:"Recurring "+plan.name+" subscription"},
        payment_plan:Number(paymentPlanId),payment_options:"card",
        meta:{subscription_checkout_id:id,plan_code:plan.code}}),
      redirect:"error",signal:AbortSignal.timeout(15000)
    });
  }catch{
    db.prepare("UPDATE billing_flutterwave_subscription_checkouts SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(),id);
    throw fail("Flutterwave recurring checkout could not be created.","BILLING_CHECKOUT_CREATE_FAILED",502);
  }
  if(!response.ok){
    db.prepare("UPDATE billing_flutterwave_subscription_checkouts SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(),id);
    throw fail("Flutterwave rejected the recurring checkout request.","BILLING_CHECKOUT_CREATE_FAILED",502);
  }
  let body;try{body=await response.json();}catch{
    db.prepare("UPDATE billing_flutterwave_subscription_checkouts SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(),id);
    throw fail("Flutterwave returned an invalid checkout response.","BILLING_PROVIDER_RESPONSE_INVALID",502);
  }
  let link;try{link=new URL(body?.data?.link);}catch{
    db.prepare("UPDATE billing_flutterwave_subscription_checkouts SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(),id);
    throw fail("Flutterwave did not return a valid hosted checkout URL.","BILLING_PROVIDER_RESPONSE_INVALID",502);
  }
  if(body?.status!=="success"||link.protocol!=="https:"||
    !(link.hostname==="flutterwave.com"||link.hostname.endsWith(".flutterwave.com"))){
    db.prepare("UPDATE billing_flutterwave_subscription_checkouts SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(),id);
    throw fail("Flutterwave returned an untrusted checkout destination.","BILLING_PROVIDER_RESPONSE_INVALID",502);
  }
  return {orderId:id,txRef,checkoutUrl:link.toString(),amountMinor:Number(plan.amount_minor),
    currency:String(plan.currency).toUpperCase(),credits:Number(plan.credits_per_period),interval:plan.interval,paymentMethod:"card"};
}

export function getFlutterwaveSubscriptionCheckoutStatus(db,{orderId,userId}={}) {
  const row=db.prepare(`SELECT c.id,c.status,c.tx_ref,c.created_at,p.name AS plan_name,p.interval
    FROM billing_flutterwave_subscription_checkouts c JOIN billing_plans p ON p.id=c.plan_id
    WHERE c.id=? AND c.user_id=? LIMIT 1`).get(orderId,userId);
  if(!row)throw fail("Flutterwave subscription checkout not found.","BILLING_ORDER_NOT_FOUND",404);
  return {orderId:row.id,status:row.status,txRef:row.tx_ref,createdAt:row.created_at,
    planName:row.plan_name,interval:row.interval};
}

export async function cancelFlutterwaveSubscription(db,{user,secretKey=process.env.FLW_SECRET_KEY,fetchImpl=fetch}={}){
  if(!user?.id||typeof secretKey!=="string"||secretKey.length<12)throw fail("Authenticated customer and Flutterwave credentials are required.","BILLING_PROVIDER_CONFIG_INVALID",503);
  const localMatches=db.prepare(`SELECT s.*,a.email,p.code AS plan_code
    FROM billing_subscriptions s JOIN billing_accounts a ON a.user_id=s.user_id
    JOIN billing_plans p ON p.id=s.plan_id
    WHERE s.user_id=? AND s.provider='flutterwave' AND s.status IN ('active','past_due')
    ORDER BY s.current_period_end DESC`).all(String(user.id));
  if(localMatches.length===0)throw fail("No cancellable Flutterwave subscription was found for this account.","BILLING_SUBSCRIPTION_NOT_FOUND",404);
  if(localMatches.length!==1)throw fail("More than one active Flutterwave subscription exists for this account. Contact support so the correct provider subscription can be selected safely.","BILLING_SUBSCRIPTION_AMBIGUOUS",409);
  const local=localMatches[0];
  const metadata=parse(local.metadata_json);
  const paymentPlanId=String(metadata.paymentPlanId||"");
  const initialTransactionId=String(metadata.initialTransactionId||"");
  if(!/^[0-9]{1,18}$/.test(paymentPlanId)||!/^[0-9]{1,30}$/.test(initialTransactionId))
    throw fail("This subscription is missing the verified provider references needed for safe cancellation.","BILLING_SUBSCRIPTION_REFERENCE_MISSING",409);
  const query=new URLSearchParams({email:String(local.email).trim().toLowerCase(),plan:paymentPlanId,transaction_id:initialTransactionId,status:"active",page:"1"});
  const headers={authorization:"Bearer "+secretKey,accept:"application/json"};
  let listResponse;
  try{listResponse=await fetchImpl("https://api.flutterwave.com/v3/subscriptions?"+query.toString(),{method:"GET",headers,redirect:"error",signal:AbortSignal.timeout(15000)});}
  catch{throw fail("Flutterwave subscription lookup failed. No local subscription state was changed.","BILLING_PROVIDER_LOOKUP_FAILED",502);}
  if(!listResponse.ok)throw fail("Flutterwave subscription lookup was rejected. No local subscription state was changed.","BILLING_PROVIDER_LOOKUP_FAILED",502);
  let listBody;try{listBody=await listResponse.json();}catch{throw fail("Flutterwave returned an invalid subscription lookup response.","BILLING_PROVIDER_RESPONSE_INVALID",502);}
  const matches=Array.isArray(listBody?.data)?listBody.data.filter(item=>
    String(item?.plan?.id??item?.plan_id??item?.plan??"")===paymentPlanId&&
    (item?.transaction_id==null&&item?.initial_transaction_id==null||String(item?.transaction_id??item?.initial_transaction_id)===initialTransactionId)&&
    String(item?.customer?.email??item?.email??"").trim().toLowerCase()===String(local.email).trim().toLowerCase()):[];
  if(listBody?.status!=="success"||matches.length!==1||!/^[0-9]{1,18}$/.test(String(matches[0]?.id||"")))
    throw fail("Flutterwave did not return exactly one subscription matching this account, plan and initial payment. Contact support before retrying.","BILLING_SUBSCRIPTION_MATCH_AMBIGUOUS",409);
  const providerId=String(matches[0].id);
  let cancelResponse;
  try{cancelResponse=await fetchImpl("https://api.flutterwave.com/v3/subscriptions/"+encodeURIComponent(providerId)+"/cancel",{method:"PUT",headers,redirect:"error",signal:AbortSignal.timeout(15000)});}
  catch{throw fail("Flutterwave cancellation request could not be completed. Check subscription status before retrying.","BILLING_PROVIDER_CANCEL_FAILED",502);}
  if(!cancelResponse.ok)throw fail("Flutterwave rejected the cancellation request. The local subscription remains unchanged.","BILLING_PROVIDER_CANCEL_FAILED",502);
  let cancelBody;try{cancelBody=await cancelResponse.json();}catch{throw fail("Flutterwave returned an invalid cancellation response.","BILLING_PROVIDER_RESPONSE_INVALID",502);}
  if(cancelBody?.status!=="success")throw fail("Flutterwave did not confirm the cancellation request.","BILLING_PROVIDER_CANCEL_FAILED",502);
  db.prepare("UPDATE billing_subscriptions SET metadata_json=?,updated_at=? WHERE id=? AND user_id=?")
    .run(json({...metadata,cancellationRequestedAt:now(),providerCancellationId:providerId}),now(),local.id,String(user.id));
  return {requested:true,provider:"flutterwave",subscriptionId:local.id,status:"awaiting_webhook",message:"Cancellation was requested from Flutterwave. Access and subscription state will update after the provider cancellation webhook is verified."};
}

export async function createFlutterwaveCheckout(db, {
  user,
  planId,
  secretKey,
  publicAppUrl,
  fetchImpl = fetch
} = {}) {
  if (!user?.id || !user?.email) throw fail("Authenticated customer identity is required.", "BILLING_USER_REQUIRED", 401);
  if (typeof secretKey !== "string" || secretKey.length < 12) {
    throw fail("Flutterwave checkout is not configured.", "BILLING_PROVIDER_CONFIG_INVALID", 503);
  }
  let baseUrl;
  try { baseUrl = new URL(publicAppUrl); } catch {
    throw fail("A valid public application URL is required for payment redirects.", "BILLING_REDIRECT_URL_INVALID", 503);
  }
  const local = ["localhost", "127.0.0.1"].includes(baseUrl.hostname);
  if (baseUrl.protocol !== "https:" && !(local && process.env.NODE_ENV !== "production")) {
    throw fail("Payment return URLs must use HTTPS.", "BILLING_REDIRECT_URL_INVALID", 503);
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw fail("Payment return URL must not contain credentials, query parameters or fragments.", "BILLING_REDIRECT_URL_INVALID", 503);
  }
  const order = createBillingPurchaseOrder(db, { userId: user.id, planId, provider: "flutterwave" });
  const exponent = currencyExponent(order.currency);
  const amount = order.amountMinor / (10 ** exponent);
  const returnUrl = new URL("/billing/return", baseUrl).toString();
  const paymentOptions = order.currency === "UGX" ? "card, mobilemoneyuganda" : "card";
  let response;
  try {
    response = await fetchImpl("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        authorization: "Bearer " + secretKey,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        tx_ref: order.txRef,
        amount,
        currency: order.currency,
        redirect_url: returnUrl,
        customer: { email: String(user.email).trim().toLowerCase() },
        customizations: { title: "Executive Visuals", description: "Credit purchase" },
        payment_options: paymentOptions,
        meta: { payment_order_id: order.id }
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    db.prepare("UPDATE billing_payment_orders SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(), order.id);
    throw fail("Flutterwave checkout could not be created. No credits were granted.", "BILLING_CHECKOUT_CREATE_FAILED", 502);
  }
  if (!response.ok) {
    db.prepare("UPDATE billing_payment_orders SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(), order.id);
    throw fail("Flutterwave rejected the checkout request. No credits were granted.", "BILLING_CHECKOUT_CREATE_FAILED", 502);
  }
  let body;
  try { body = await response.json(); } catch {
    db.prepare("UPDATE billing_payment_orders SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(), order.id);
    throw fail("Flutterwave returned an invalid checkout response.", "BILLING_PROVIDER_RESPONSE_INVALID", 502);
  }
  let checkoutUrl;
  try { checkoutUrl = new URL(body?.data?.link); } catch {
    db.prepare("UPDATE billing_payment_orders SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(), order.id);
    throw fail("Flutterwave did not return a valid hosted checkout URL.", "BILLING_PROVIDER_RESPONSE_INVALID", 502);
  }
  if (body?.status !== "success" || checkoutUrl.protocol !== "https:" ||
      !(checkoutUrl.hostname === "flutterwave.com" || checkoutUrl.hostname.endsWith(".flutterwave.com"))) {
    db.prepare("UPDATE billing_payment_orders SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(), order.id);
    throw fail("Flutterwave returned an untrusted checkout destination.", "BILLING_PROVIDER_RESPONSE_INVALID", 502);
  }
  return { orderId: order.id, txRef: order.txRef, checkoutUrl: checkoutUrl.toString(),
    amountMinor: order.amountMinor, currency: order.currency, credits: order.credits };
}

/**
 * Process one persisted webhook. Grant credits only after server-to-server
 * transaction verification and exact tx_ref/currency/amount matching.
 */
export async function processNextFlutterwaveWebhook(db, {
  secretKey,
  verifyTransaction = args => verifyFlutterwaveTransaction({ ...args, secretKey })
} = {}) {
  const leaseOwner=randomUUID();
  let event=null;
  db.exec("BEGIN IMMEDIATE");
  try{
    const current=now();
    event=db.prepare(`SELECT * FROM billing_provider_events
      WHERE provider='flutterwave' AND processed_at IS NULL AND attempts<10
        AND (lease_expires_at IS NULL OR lease_expires_at<=?)
      ORDER BY created_at ASC LIMIT 1`).get(current)||null;
    if(!event){db.exec("COMMIT");return {processed:false};}
    const claimed=db.prepare(`UPDATE billing_provider_events SET lease_owner=?,lease_expires_at=?
      WHERE id=? AND processed_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at<=?)`)
      .run(leaseOwner,new Date(Date.now()+120000).toISOString(),event.id,current);
    if(claimed.changes!==1){db.exec("COMMIT");return {processed:false};}
    db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error;}
  const markProcessed=(timestamp=now())=>{
    const result=db.prepare(`UPDATE billing_provider_events SET processed_at=?,last_error=NULL,lease_owner=NULL,lease_expires_at=NULL
      WHERE id=? AND lease_owner=? AND processed_at IS NULL`).run(timestamp,event.id,leaseOwner);
    if(result.changes!==1)throw fail("Flutterwave webhook processing lease was lost.","BILLING_WEBHOOK_LEASE_LOST",409);
  };
  const payload = parse(event.payload_json);
  const data = payload.data || {};
  try {
    if(payload.event==="subscription.cancelled"){
      const email=String(data.customer?.email||"").toLowerCase();
      const paymentPlanId=String(data.plan?.id||"");
      const localMatches=db.prepare(`SELECT s.*,p.code AS plan_code,a.email
        FROM billing_subscriptions s JOIN billing_plans p ON p.id=s.plan_id
        JOIN billing_accounts a ON a.user_id=s.user_id
        WHERE s.provider='flutterwave' AND lower(a.email)=? AND s.status IN ('active','past_due','trialing')
        AND json_extract(s.metadata_json,'$.paymentPlanId')=? ORDER BY s.current_period_end DESC`)
        .all(email,paymentPlanId);
      if(localMatches.length!==1){markProcessed();return {processed:true,unmatched:true,ambiguous:localMatches.length>1,eventId:event.event_id};}
      const local=localMatches[0];
      const metadata=parse(local.metadata_json);
      db.exec("BEGIN IMMEDIATE");
      try{
        db.prepare("UPDATE billing_subscriptions SET status='cancelled',cancel_at_period_end=0,metadata_json=?,updated_at=? WHERE id=?")
          .run(json({...metadata,providerCancellationEvent:event.event_id}),now(),local.id);
        enqueueCloudSubscriptionSync(db,{provider:"flutterwave",action:"status",providerEventId:event.event_id,
          ownerId:local.user_id,planCode:local.plan_code,providerCustomerId:local.provider_customer_id||null,
          providerSubscriptionId:local.provider_subscription_id,periodStart:local.current_period_start,
          periodEnd:local.current_period_end,status:"active",
          metadata:{targetStatus:"cancelled",cancelAtPeriodEnd:false,graceUntil:null}});
        markProcessed();db.exec("COMMIT");
      }catch(error){db.exec("ROLLBACK");throw error;}
      return {processed:true,cancelled:true,eventId:event.event_id};
    }
    const order = db.prepare("SELECT * FROM billing_payment_orders WHERE tx_ref=? AND provider='flutterwave'").get(data.tx_ref);
    if (!order) {
      const recurring=db.prepare("SELECT c.*,p.code AS plan_code,p.name AS plan_name,p.amount_minor,p.currency,p.interval,p.credits_per_period,p.active AS plan_active,a.email AS account_email FROM billing_flutterwave_subscription_checkouts c JOIN billing_plans p ON p.id=c.plan_id JOIN billing_accounts a ON a.user_id=c.user_id WHERE c.tx_ref=? LIMIT 1").get(data.tx_ref);
      if(!recurring){
        if(payload.event==="charge.failed"){markProcessed();return {processed:true,paid:false,retryableCheckout:true,eventId:event.event_id};}
        if(payload.event!=="charge.completed"||data.status!=="successful")throw fail("Flutterwave renewal is not in a successful state.","BILLING_PAYMENT_PENDING",409);
        const verified=await verifyTransaction({transactionId:String(data.id)});
        const verifiedCustomerId=String(verified?.customer?.id||"");
        const email=String(data.customer?.email||verified?.customer?.email||"").trim().toLowerCase();
        const paymentPlanId=String(data.payment_plan||verified?.payment_plan||"");
        let local=null;
        if(paymentPlanId&&email){
          local=db.prepare(`SELECT s.*,p.code AS plan_code,p.amount_minor,p.currency,p.interval,p.credits_per_period
            FROM billing_subscriptions s JOIN billing_plans p ON p.id=s.plan_id
            JOIN billing_accounts a ON a.user_id=s.user_id
            WHERE s.provider='flutterwave' AND lower(a.email)=? AND s.status IN ('active','past_due')
              AND json_extract(s.metadata_json,'$.paymentPlanId')=?
            ORDER BY s.current_period_end DESC LIMIT 1`).get(email,paymentPlanId);
        }else if(verifiedCustomerId&&email){
          const matches=db.prepare(`SELECT s.*,p.code AS plan_code,p.amount_minor,p.currency,p.interval,p.credits_per_period
            FROM billing_subscriptions s JOIN billing_plans p ON p.id=s.plan_id
            JOIN billing_accounts a ON a.user_id=s.user_id
            WHERE s.provider='flutterwave' AND lower(a.email)=? AND s.provider_customer_id=?
              AND s.status IN ('active','past_due') ORDER BY s.current_period_end DESC LIMIT 2`).all(email,verifiedCustomerId);
          if(matches.length===1)local=matches[0];
        }
        if(!local)throw fail("Flutterwave renewal could not be matched to one active subscription.","FLW_RENEWAL_UNMATCHED",409);
        const exponent=currencyExponent(local.currency);
        const paidMinor=Math.round(Number(verified?.amount)*(10**exponent));
        if(String(verified?.id)!==String(data.id)||String(verified?.tx_ref)!==String(data.tx_ref)||
          String(verified?.status).toLowerCase()!=="successful"||
          String(verified?.currency).toUpperCase()!==String(local.currency).toUpperCase()||
          !Number.isSafeInteger(paidMinor)||paidMinor<Number(local.amount_minor)||
          (verifiedCustomerId&&local.provider_customer_id&&verifiedCustomerId!==String(local.provider_customer_id))){
          throw fail("Verified Flutterwave renewal does not match the existing subscription.","BILLING_PAYMENT_MISMATCH",409);
        }
        const timestamp=now(),periodStart=Date.parse(local.current_period_end)>Date.now()?local.current_period_end:timestamp;
        const periodEnd=addBillingPeriod(periodStart,local.interval);
        const metadata=parse(local.metadata_json);
        db.exec("BEGIN IMMEDIATE");
        try{
          db.prepare("UPDATE billing_subscriptions SET status='active',current_period_start=?,current_period_end=?,metadata_json=?,updated_at=? WHERE id=?")
            .run(periodStart,periodEnd,json({...metadata,lastRenewalTransactionId:String(verified.id),lastRenewalEventId:event.event_id}),timestamp,local.id);
          db.prepare(`INSERT OR IGNORE INTO billing_credit_ledger
            (id,user_id,amount,event_type,description,reference_id,idempotency_key,expires_at,metadata_json)
            VALUES(?,?,?,'subscription_grant',?,?,?,?,?)`)
            .run(randomUUID(),local.user_id,Number(local.credits_per_period),"Flutterwave subscription renewal credits",
              local.id,"flutterwave-subscription-renewal:"+local.provider_subscription_id+":"+String(verified.id),
              periodEnd,json({provider:"flutterwave",paymentId:String(verified.id),paymentPlanId:paymentPlanId||metadata.paymentPlanId}));
          enqueueCloudSubscriptionSync(db,{provider:"flutterwave",providerEventId:event.event_id,ownerId:local.user_id,
            planCode:local.plan_code,providerCustomerId:local.provider_customer_id||verifiedCustomerId||null,
            providerSubscriptionId:local.provider_subscription_id,periodStart,periodEnd,status:"active",
            metadata:{paymentId:String(verified.id),paymentPlanId:paymentPlanId||metadata.paymentPlanId,currency:local.currency}});
          markProcessed(timestamp);db.exec("COMMIT");
        }catch(error){db.exec("ROLLBACK");throw error;}
        return {processed:true,paid:true,renewed:true,eventId:event.event_id,subscriptionId:local.id};
      }
      if(recurring.status==="active"){markProcessed();return {processed:true,duplicate:true,eventId:event.event_id};}
      if(recurring.status!=="pending"||!recurring.plan_active)throw fail("Recurring checkout is no longer eligible for settlement.","BILLING_ORDER_NOT_PENDING",409);
      if(payload.event==="charge.failed"||data.status==="failed"){markProcessed();return {processed:true,paid:false,retryableCheckout:true,eventId:event.event_id};}
      if(payload.event!=="charge.completed"||data.status!=="successful")throw fail("Flutterwave recurring payment is not yet successful.","BILLING_PAYMENT_PENDING",409);
      const verified=await verifyTransaction({transactionId:String(data.id)});
      const exponent=currencyExponent(recurring.currency);
      const paidMinor=Math.round(Number(verified?.amount)*(10**exponent));
      if(String(verified?.id)!==String(data.id)||String(verified?.tx_ref)!==recurring.tx_ref||
        String(verified?.status).toLowerCase()!=="successful"||String(verified?.currency).toUpperCase()!==String(recurring.currency).toUpperCase()||
        !Number.isSafeInteger(paidMinor)||paidMinor<Number(recurring.amount_minor)){
        throw fail("Verified Flutterwave recurring payment does not match the configured plan.","BILLING_PAYMENT_MISMATCH",409);
      }
      const timestamp=now(),periodStart=timestamp;
      const periodEnd=addBillingPeriod(periodStart,recurring.interval);
      const providerCustomerId=String(verified?.customer?.id||"")||null;
      const providerSubscriptionId=String(verified?.subscription_id||"")||("flw-plan:"+recurring.provider_payment_plan_id+":"+recurring.user_id+":"+recurring.id);
      const localSubscriptionId=randomUUID();
      db.exec("BEGIN IMMEDIATE");
      try{
        db.prepare(`INSERT INTO billing_subscriptions
          (id,user_id,plan_id,status,provider,provider_customer_id,provider_subscription_id,current_period_start,current_period_end,metadata_json)
          VALUES(?,?,?,'active','flutterwave',?,?,?,?,?)`)
          .run(localSubscriptionId,recurring.user_id,recurring.plan_id,providerCustomerId,providerSubscriptionId,
            periodStart,periodEnd,json({paymentPlanId:String(recurring.provider_payment_plan_id),checkoutId:recurring.id,initialTransactionId:String(verified.id)}));
        db.prepare(`INSERT OR IGNORE INTO billing_credit_ledger
          (id,user_id,amount,event_type,description,reference_id,idempotency_key,expires_at,metadata_json)
          VALUES(?,?,?,'subscription_grant',?,?,?,?,?)`)
          .run(randomUUID(),recurring.user_id,Number(recurring.credits_per_period),"Flutterwave subscription credits",
            localSubscriptionId,"flutterwave-subscription-period:"+providerSubscriptionId+":"+periodStart,periodEnd,
            json({provider:"flutterwave",paymentId:String(verified.id),paymentPlanId:String(recurring.provider_payment_plan_id)}));
        db.prepare("UPDATE billing_flutterwave_subscription_checkouts SET status='active',provider_customer_id=?,provider_subscription_id=?,updated_at=? WHERE id=?")
          .run(providerCustomerId,providerSubscriptionId,timestamp,recurring.id);
        enqueueCloudSubscriptionSync(db,{provider:"flutterwave",providerEventId:event.event_id,ownerId:recurring.user_id,
          planCode:recurring.plan_code,providerCustomerId,providerSubscriptionId,periodStart,periodEnd,status:"active",
          metadata:{paymentId:String(verified.id),paymentPlanId:String(recurring.provider_payment_plan_id),currency:recurring.currency}});
        markProcessed(timestamp);db.exec("COMMIT");
      }catch(error){db.exec("ROLLBACK");throw error;}
      return {processed:true,paid:true,subscription:true,eventId:event.event_id,subscriptionId:localSubscriptionId};
    }
    if (order.status === "paid") {
      markProcessed();
      return { processed: true, duplicate: true, eventId: event.event_id };
    }
    if (order.status !== "pending") {
      throw fail("Billing order is no longer eligible for payment settlement.", "BILLING_ORDER_NOT_PENDING", 409);
    }
    if (payload.event === "charge.failed" || data.status === "failed") {
      // A failed attempt does not close the hosted checkout: Flutterwave can
      // emit another transaction for the same tx_ref when the customer retries.
      markProcessed();
      return { processed: true, paid: false, retryableCheckout: true, eventId: event.event_id };
    }
    if (payload.event !== "charge.completed" || data.status !== "successful") {
      throw fail("Flutterwave payment is not in a terminal successful state yet.", "BILLING_PAYMENT_PENDING", 409);
    }
    const verified = await verifyTransaction({ transactionId: String(data.id) });
    const exponent = currencyExponent(order.currency);
    const paidMinor = Math.round(Number(verified?.amount) * (10 ** exponent));
    if (String(verified?.id) !== String(data.id) ||
        String(verified?.tx_ref) !== order.tx_ref ||
        String(verified?.status).toLowerCase() !== "successful" ||
        String(verified?.currency).toUpperCase() !== order.currency ||
        !Number.isSafeInteger(paidMinor) || paidMinor < Number(order.expected_amount_minor)) {
      throw fail("Verified Flutterwave transaction does not match the pending order.", "BILLING_PAYMENT_MISMATCH", 409);
    }
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const latest = db.prepare("SELECT * FROM billing_payment_orders WHERE id=?").get(order.id);
      if (latest.status !== "paid") {
        db.prepare("INSERT OR IGNORE INTO billing_credit_ledger(id,user_id,amount,event_type,description,reference_id,idempotency_key,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
          .run(randomUUID(), latest.user_id, Number(latest.credits), "purchase", "Credit purchase", latest.id,
            "flutterwave-purchase:" + latest.id, json({ provider: "flutterwave", transactionId: String(verified.id), txRef: latest.tx_ref }));
        db.prepare("UPDATE billing_payment_orders SET status='paid',provider_transaction_id=?,verified_at=?,updated_at=? WHERE id=?")
          .run(String(verified.id), timestamp, timestamp, latest.id);
      }
      markProcessed(timestamp);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { processed: true, paid: true, eventId: event.event_id, paymentOrderId: order.id };
  } catch (error) {
    db.prepare(`UPDATE billing_provider_events SET attempts=attempts+1,last_error=?,lease_owner=NULL,lease_expires_at=NULL
      WHERE id=? AND lease_owner=?`)
      .run(String(error?.code || "PROCESSING_FAILED").slice(0, 120), event.id, leaseOwner);
    return { processed: false, retryable: true, eventId: event.event_id, errorCode: error?.code || "PROCESSING_FAILED" };
  }
}
