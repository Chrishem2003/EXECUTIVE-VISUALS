import { randomUUID, createHash } from "node:crypto";
import {
  verifyFlutterwaveWebhook, verifyFlutterwaveV3Webhook, hashWebhookPayload,
  parseRefundStatus, getCurrencyDecimals, minorToMajor
} from "./payment-intelligence.mjs";
import { createFlutterwaveAccessTokenProvider } from "./flutterwave-auth.mjs";
import { normalizeGenAiUsage, parseProviderInvoiceCsv } from "./ai-cost-metering.mjs";
import { normalizeWorkloadTelemetry } from "./ai-workload-telemetry.mjs";
import { normalizeResourceUsage, normalizeModelPerformance, normalizeShadowRoutingRequest } from "./ai-resource-economics.mjs";
import { estimateWorkloadEconomics, compareWorkloadCandidates } from "./ai-workload-economics.mjs";
import { analyzeWorkloadCostVariance } from "./workload-cost-variance.mjs";
import { detectDuplicateInvoices, reconcileInvoiceTotals, reconcileProviderInvoiceLines, reconcilePaymentSettlement } from "./financial-reconciliation.mjs";
import { assessFinancialCloseReadiness } from "./financial-close-readiness.mjs";
import { canonicalFinancialAuditJson, createFinancialAuditEvent, verifyFinancialAuditChain, FINANCIAL_AUDIT_EVENT_TYPES } from "./financial-audit-ledger.mjs";
import { exportFinancialAuditBundle } from "./financial-audit-export.mjs";
import { calculateFinancialScenarioIntelligence } from "./financial-scenario-intelligence.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_PAGE=100;
const response=(status,body)=>({status,body});
const error=(status,code,message)=>response(status,{error:{code,message}});
const hashText=value=>createHash("sha256").update(String(value)).digest("hex");

function majorToMinor(value,currency){
  const decimals=getCurrencyDecimals(currency);
  const text=String(value);
  if(!/^\d+(?:\.\d+)?$/.test(text))throw Object.assign(new Error("Provider amount is invalid."),{code:"PROVIDER_AMOUNT_INVALID"});
  const [whole,fraction=""]=text.split(".");
  if(fraction.length>decimals && /[^0]/.test(fraction.slice(decimals)))throw Object.assign(new Error("Provider amount precision does not match currency."),{code:"PROVIDER_AMOUNT_PRECISION_INVALID"});
  const factor=10n**BigInt(decimals);
  return Number(BigInt(whole)*factor+BigInt((fraction+"0".repeat(decimals)).slice(0,decimals)||"0"));
}

export function createFinancialIntelligenceApi({
  supabaseUrl=process.env.SUPABASE_URL,
  serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
  flutterwaveClientId=process.env.FLW_CLIENT_ID,
  flutterwaveClientSecret=process.env.FLW_CLIENT_SECRET,
  webhookSecretHash=process.env.FLW_SECRET_HASH,
  webhookVersion=process.env.FLW_WEBHOOK_VERSION||"v4",
  flutterwaveBaseUrl=process.env.FLW_API_BASE_URL||"https://developersandbox-api.flutterwave.com",
  billingEnabled=process.env.BILLING_API_ENABLED==="true",
  refundsEnabled=process.env.FLW_REFUNDS_ENABLED==="true",
  allowLive=process.env.FLW_ALLOW_LIVE==="true",
  paymentGracePeriodHours=Number(process.env.PAYMENT_GRACE_PERIOD_HOURS||72),
  financialSystemActorId=process.env.FINANCIAL_SYSTEM_ACTOR_ID,
  financialAuditSigningPrivateKey=process.env.FINANCIAL_AUDIT_SIGNING_PRIVATE_KEY||null,
  resourceCostMeteringEnabled=process.env.RESOURCE_COST_METERING_ENABLED==="true",
  resourceCostCurrency=process.env.RESOURCE_COST_CURRENCY||null,
  fetchImpl=globalThis.fetch
}={}){
  if(!supabaseUrl||!serviceRoleKey)throw new Error("Financial API requires server-side Supabase credentials.");
  if(typeof fetchImpl!=="function")throw new Error("Financial API requires fetch.");
  const parsedBase=new URL(flutterwaveBaseUrl);
  if(parsedBase.protocol!=="https:"&&!["localhost","127.0.0.1","::1"].includes(parsedBase.hostname))throw new Error("Flutterwave API must use HTTPS.");
  const isSandbox=parsedBase.hostname==="developersandbox-api.flutterwave.com";
  const isLive=parsedBase.hostname==="f4bexperience.flutterwave.com";
  if(!isSandbox&&!isLive)throw new Error("Flutterwave v4 API base URL must be the documented sandbox or production host.");
  if(isLive&&!allowLive)throw new Error("Live Flutterwave API requires explicit FLW_ALLOW_LIVE=true.");
  const getAccessToken=createFlutterwaveAccessTokenProvider({clientId:flutterwaveClientId,clientSecret:flutterwaveClientSecret,fetchImpl});
  const base=new URL(supabaseUrl).origin;

  async function dbRequest(path,{method="GET",body=null,prefer="return=representation",allowConflict=false}={}){
    const headers={
      apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,
      "accept-profile":"executive_visuals","content-profile":"executive_visuals",
      accept:"application/json",prefer
    };
    if(body!==null)headers["content-type"]="application/json";
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{
      const result=await fetchImpl(base+"/rest/v1/"+path,{
        method,headers,...(body===null?{}:{body:JSON.stringify(body)}),
        signal:controller.signal,redirect:"error"
      });
      const raw=await result.text();
      let data=null;
      if(raw){try{data=JSON.parse(raw);}catch{throw new Error("Financial database returned invalid JSON.");}}
      if(!result.ok){
        if(allowConflict&&result.status===409)return {data:null,status:409};
        const failure=new Error("Financial database request failed (HTTP "+result.status+").");
        failure.status=result.status;failure.code="FINANCIAL_DATABASE_ERROR";throw failure;
      }
      return {data,status:result.status};
    }catch(err){
      if(err?.name==="AbortError")throw Object.assign(new Error("Financial database request timed out."),{code:"FINANCIAL_DATABASE_TIMEOUT",status:504});
      throw err;
    }finally{clearTimeout(timer);}
  }

  async function rpc(name,body){
    const result=await dbRequest("rpc/"+name,{method:"POST",body,prefer:"return=representation"});
    return result.data;
  }

  async function providerRequest(path,{method="GET",body=null,idempotencyKey=null}={}){
    const accessToken=await getAccessToken();
    const traceId=randomUUID();
    const headers={authorization:"Bearer "+accessToken,"content-type":"application/json","x-trace-id":traceId};
    if(idempotencyKey)headers["x-idempotency-key"]=idempotencyKey;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{
      const result=await fetchImpl(new URL(path,flutterwaveBaseUrl),{
        method,headers,...(body===null?{}:{body:JSON.stringify(body)}),
        signal:controller.signal,redirect:"error"
      });
      const raw=await result.text();
      let payload=null;try{payload=raw?JSON.parse(raw):null;}catch{throw Object.assign(new Error("Flutterwave returned invalid JSON."),{code:"PROVIDER_INVALID_RESPONSE",status:502});}
      if(!result.ok)throw Object.assign(new Error("Flutterwave request failed (HTTP "+result.status+")."),{code:"PROVIDER_REQUEST_FAILED",status:502,providerStatus:result.status});
      return payload;
    }catch(err){
      if(err?.name==="AbortError")throw Object.assign(new Error("Flutterwave request timed out; the provider result is uncertain. Reconciliation must reuse the same idempotency key."),{code:"PROVIDER_RESULT_UNCERTAIN",status:202});
      throw err;
    }finally{clearTimeout(timer);}
  }

  async function verifyAndFinalizeRefund(providerRefundId){
    const rows=await dbRequest(
      "payment_refunds?select=id,owner_id,payment_transaction_id,provider_refund_id,amount_minor,currency,status&provider=eq.flutterwave&provider_refund_id=eq."+encodeURIComponent(providerRefundId)+"&limit=1"
    );
    const refund=Array.isArray(rows.data)?rows.data[0]:null;
    if(!refund)return {matched:false};
    const payments=await dbRequest(
      "payment_transactions?select=id,provider_transaction_id,amount_minor,currency&id=eq."+encodeURIComponent(refund.payment_transaction_id)+"&owner_id=eq."+encodeURIComponent(refund.owner_id)+"&limit=1"
    );
    const payment=Array.isArray(payments.data)?payments.data[0]:null;
    if(!payment||!payment.provider_transaction_id)throw Object.assign(new Error("Refund is not linked to a verified provider charge."),{code:"REFUND_CHARGE_LINK_MISSING"});
    const providerPayload=await providerRequest("/refunds/"+encodeURIComponent(providerRefundId));
    const providerRefund=providerPayload?.data||providerPayload;
    if(String(providerRefund?.id||"")!==String(providerRefundId))throw Object.assign(new Error("Flutterwave refund verification returned a mismatched ID."),{code:"REFUND_PROVIDER_ID_MISMATCH"});
    if(String(providerRefund?.charge_id||"")!==String(payment.provider_transaction_id))throw Object.assign(new Error("Flutterwave refund verification returned a mismatched charge."),{code:"REFUND_CHARGE_MISMATCH"});
    const amountValue=providerRefund.amount_refunded??providerRefund.amount;
    const verifiedMinor=majorToMinor(amountValue,refund.currency);
    if(verifiedMinor!==Number(refund.amount_minor))throw Object.assign(new Error("Flutterwave refund amount does not match the reserved amount."),{code:"REFUND_AMOUNT_MISMATCH"});
    const status=parseRefundStatus(providerRefund.status);
    if(status==="processing")return {matched:true,status:"processing",refundId:refund.id};
    const finalized=await rpc("finalize_payment_refund",{
      p_refund_id:refund.id,p_provider_refund_id:String(providerRefundId),
      p_status:status,p_provider_payload:providerRefund
    });
    return {matched:true,status,refundId:refund.id,settlement:finalized};
  }

  async function verifyAndFinalizePayment(providerChargeId){
    if(!providerChargeId)throw Object.assign(new Error("Provider charge ID is required."),{code:"PAYMENT_PROVIDER_ID_MISSING"});
    const providerPayload=await providerRequest("/charges/"+encodeURIComponent(providerChargeId));
    const charge=providerPayload?.data||providerPayload;
    if(String(charge?.id||"")!==String(providerChargeId))throw Object.assign(new Error("Flutterwave returned a mismatched charge ID."),{code:"PAYMENT_PROVIDER_ID_MISMATCH"});
    const reference=String(charge?.reference||"");
    if(!reference)throw Object.assign(new Error("Verified provider charge has no merchant reference."),{code:"PAYMENT_REFERENCE_MISSING"});
    const rows=await dbRequest("payment_transactions?select=id,owner_id,provider_transaction_id,tx_ref,amount_minor,currency,status,metadata,description&provider=eq.flutterwave&tx_ref=eq."+encodeURIComponent(reference)+"&limit=1");
    const payment=Array.isArray(rows.data)?rows.data[0]:null;
    if(!payment)return {matched:false,status:"unmatched"};
    if(payment.provider_transaction_id&&payment.provider_transaction_id!==providerChargeId)throw Object.assign(new Error("Charge is already linked to a different provider transaction."),{code:"PAYMENT_PROVIDER_ID_MISMATCH"});
    if(String(charge.currency||"").toUpperCase()!==payment.currency)throw Object.assign(new Error("Provider charge currency does not match checkout."),{code:"PAYMENT_CURRENCY_MISMATCH"});
    if(majorToMinor(charge.amount,payment.currency)!==Number(payment.amount_minor))throw Object.assign(new Error("Provider charge amount does not match checkout."),{code:"PAYMENT_AMOUNT_MISMATCH"});
    const providerStatus=String(charge.status||"").toLowerCase();
    if(providerStatus==="pending")return {matched:true,status:"pending",paymentId:payment.id};
    if(providerStatus==="failed"||providerStatus==="voided"){
      await dbRequest("payment_transactions?id=eq."+encodeURIComponent(payment.id)+"&status=eq.pending",{
        method:"PATCH",body:{status:"failed",provider_transaction_id:providerChargeId,metadata:{...payment.metadata,provider_verification:charge},updated_at:new Date().toISOString()},prefer:"return=minimal"
      });
      const recovery=await rpc("record_payment_failure",{
        p_payment_id:payment.id,
        p_failure_code:String(charge.failure_code||charge.processor_response_code||"PAYMENT_FAILED").slice(0,100),
        p_failure_message:String(charge.failure_message||charge.processor_response||"Flutterwave confirmed that the payment failed.").slice(0,500),
        p_grace_hours:Number.isInteger(paymentGracePeriodHours)?Math.max(0,Math.min(720,paymentGracePeriodHours)):72
      });
      const initialSubscription=payment.metadata?.payment_purpose==="subscription_purchase"
        ?await rpc("expire_failed_subscription_purchase",{p_payment_id:payment.id}):null;
      return {matched:true,status:"failed",paymentId:payment.id,recovery,initialSubscription};
    }
    if(providerStatus!=="succeeded")return {matched:true,status:"pending",paymentId:payment.id};
    if(payment.metadata?.payment_purpose==="subscription_purchase"){
      const purchase=await rpc("finalize_subscription_purchase",{
        p_payment_id:payment.id,
        p_provider_transaction_id:String(providerChargeId),
        p_provider_payload:charge,
        p_verified_at:new Date().toISOString()
      });
      return {matched:true,status:"successful",paymentId:payment.id,subscriptionActivated:true,purchase};
    }
    if(payment.metadata?.payment_purpose==="subscription_renewal"){
      const renewal=await rpc("finalize_subscription_renewal",{
        p_payment_id:payment.id,
        p_provider_transaction_id:String(providerChargeId),
        p_provider_payload:charge,
        p_verified_at:new Date().toISOString()
      });
      return {matched:true,status:"successful",paymentId:payment.id,subscriptionRenewed:true,renewal};
    }
    const settlement=await rpc("finalize_payment_purchase",{
      p_payment_id:payment.id,p_provider_transaction_id:String(providerChargeId),
      p_provider_payload:charge,p_verified_at:new Date().toISOString()
    });
    return {matched:true,status:"successful",paymentId:payment.id,settlement};
  }

  async function handleWebhook({rawBody,signatureV4,signatureV3}={}){
    if(!Buffer.isBuffer(rawBody)||rawBody.length===0||rawBody.length>1024*1024)return response(400,{error:{code:"WEBHOOK_BODY_INVALID",message:"Webhook body is empty or too large."}});
    const verified=webhookVersion==="v3"
      ?verifyFlutterwaveV3Webhook(signatureV3,webhookSecretHash)
      :webhookVersion==="v4"
        ?verifyFlutterwaveWebhook(rawBody,signatureV4,webhookSecretHash)
        :false;
    if(!verified)return response(401,{error:{code:"WEBHOOK_SIGNATURE_INVALID",message:"Webhook signature could not be verified."}});
    let payload;
    try{payload=JSON.parse(rawBody.toString("utf8"));}catch{return response(400,{error:{code:"WEBHOOK_JSON_INVALID",message:"Webhook body must be valid JSON."}});}
    const event=String(payload?.event||payload?.type||"unknown").slice(0,160);
    const data=payload?.data||{};
    const providerEventId=String(data?.id||payload?.id||"unknown").slice(0,180);
    const status=String(data?.status||"unknown").slice(0,80);
    const payloadHash=hashWebhookPayload(rawBody);
    const eventKey=hashText(event+":"+providerEventId+":"+status+":"+payloadHash);
    const existing=await dbRequest("payment_webhook_events?select=id,processing_status&provider=eq.flutterwave&event_key=eq."+eventKey+"&limit=1");
    const priorEvent=Array.isArray(existing.data)?existing.data[0]:null;
    if(priorEvent&&["processed","ignored","needs_review"].includes(priorEvent.processing_status))
      return response(200,{received:true,duplicate:true});
    if(priorEvent){
      // Retry a previously received/failed event. Finalization RPCs are idempotent,
      // so provider retries can safely recover from transient DB/provider failures.
      await dbRequest("payment_webhook_events?id=eq."+encodeURIComponent(priorEvent.id),{
        method:"PATCH",body:{processing_status:"processing",error_message:null},prefer:"return=minimal"
      });
    }else{
      const inserted=await dbRequest("payment_webhook_events",{
        method:"POST",body:{
          provider:"flutterwave",event_key:eventKey,event_type:event,
          payload_hash:payloadHash,signature_verified:true,
          processing_status:"received",payload
        },prefer:"return=minimal",allowConflict:true
      });
      if(inserted.status===409)return response(200,{received:true,duplicate:true});
    }
    try{
      if(/^(charge\.|payment\.)/i.test(event)) {
        const chargeId=String(data?.id||"");
        if(!chargeId)return response(200,{received:true,ignored:true});
        const result=await verifyAndFinalizePayment(chargeId);
        await dbRequest("payment_webhook_events?provider=eq.flutterwave&event_key=eq."+eventKey,{
          method:"PATCH",body:{processing_status:result.matched?"processed":"ignored",processed_at:new Date().toISOString()},prefer:"return=minimal"
        });
        return response(200,{received:true,result});
      }
      if(/^subscription\./i.test(event)) {
        // Flutterwave's cancellation example does not guarantee a stable local
        // subscription ID. Preserve the signed callback for reconciliation;
        // never revoke access based on an ambiguous email/plan-only payload.
        await dbRequest("payment_webhook_events?provider=eq.flutterwave&event_key=eq."+eventKey,{
          method:"PATCH",body:{
            processing_status:"needs_review",
            error_message:"Verified subscription lifecycle event requires provider-to-customer reconciliation.",
            processed_at:new Date().toISOString()
          },prefer:"return=minimal"
        });
        return response(200,{received:true,needsReview:true,message:"Verified subscription event queued for administrator reconciliation."});
      }
      if(!/refund/i.test(event)) {
        await dbRequest("payment_webhook_events?provider=eq.flutterwave&event_key=eq."+eventKey,{
          method:"PATCH",body:{processing_status:"ignored",processed_at:new Date().toISOString()},prefer:"return=minimal"
        });
        return response(200,{received:true,ignored:true});
      }
      const refundId=String(data?.id||"");
      if(!refundId)return response(200,{received:true,ignored:true});
      const result=await verifyAndFinalizeRefund(refundId);
      await dbRequest("payment_webhook_events?provider=eq.flutterwave&event_key=eq."+eventKey,{
        method:"PATCH",body:{processing_status:"processed",processed_at:new Date().toISOString()},prefer:"return=minimal"
      });
      return response(200,{received:true,result});
    }catch(err){
      await dbRequest("payment_webhook_events?provider=eq.flutterwave&event_key=eq."+eventKey,{
        method:"PATCH",body:{processing_status:"failed",error_message:String(err.message||"Processing failed").slice(0,500)},prefer:"return=minimal"
      }).catch(()=>{});
      return response(500,{error:{code:err.code||"WEBHOOK_PROCESSING_FAILED",message:"Verified webhook could not be reconciled; provider retry is required."}});
    }
  }

  async function reconcilePendingRefunds({limit=100}={}){
    const boundedLimit=Math.max(1,Math.min(100,Number(limit)||100));
    const pending=await dbRequest("payment_refunds?select=id,owner_id,payment_transaction_id,provider_refund_id,status,amount_minor,currency,reason,idempotency_key&status=in.(requested,processing)&order=requested_at.asc&limit="+boundedLimit);
    const results=[];
    for(const refund of Array.isArray(pending.data)?pending.data:[]){
      try{
        let providerRefundId=refund.provider_refund_id;
        if(!providerRefundId&&refund.status==="requested"){
          const paymentResult=await dbRequest("payment_transactions?select=id,provider_transaction_id,amount_minor,currency,status&id=eq."+encodeURIComponent(refund.payment_transaction_id)+"&owner_id=eq."+encodeURIComponent(refund.owner_id)+"&limit=1");
          const payment=Array.isArray(paymentResult.data)?paymentResult.data[0]:null;
          if(!payment||payment.status!=="successful"||!payment.provider_transaction_id){
            results.push({refundId:refund.id,status:"awaiting_verified_charge"});continue;
          }
          const created=await providerRequest("/refunds",{
            method:"POST",idempotencyKey:refund.idempotency_key,
            body:{amount:minorToMajor(Number(refund.amount_minor),refund.currency),reason:refund.reason,charge_id:payment.provider_transaction_id}
          });
          providerRefundId=String(created?.data?.id||"");
          if(!providerRefundId)throw new Error("Flutterwave did not return a refund ID during reconciliation.");
          await dbRequest("payment_refunds?id=eq."+encodeURIComponent(refund.id),{
            method:"PATCH",body:{provider_refund_id:providerRefundId,status:"processing",provider_payload:created.data,updated_at:new Date().toISOString()},prefer:"return=minimal"
          });
        }
        if(!providerRefundId){results.push({refundId:refund.id,status:"awaiting_provider_reference"});continue;}
        results.push({refundId:refund.id,...await verifyAndFinalizeRefund(providerRefundId)});
      }catch(err){
        results.push({refundId:refund.id,status:"verification_error",code:err.code||"REFUND_VERIFY_FAILED"});
      }
    }
    return {checked:results.length,results};
  }

  async function requireAdmin(ownerId){
    const result=await dbRequest("platform_admins?select=role&user_id=eq."+encodeURIComponent(ownerId)+"&limit=1");
    const role=Array.isArray(result.data)?result.data[0]?.role:null;
    return ["owner","platform_admin","billing_admin"].includes(role);
  }

  async function handle({method,path,ownerId,body={},query={},idempotencyKey=""}={}){
    const customerSuccessRoute=String(path||"").startsWith("/api/customer-success/")||String(path||"").startsWith("/api/admin/customer-success/");
    if(!billingEnabled&&!customerSuccessRoute)return error(503,"BILLING_DISABLED","Financial intelligence APIs are disabled until staging verification is complete.");
    if(!UUID.test(String(ownerId||"")))return error(401,"AUTH_REQUIRED","A verified Supabase account is required.");
    try{
      if(path==="/api/customer-success/me"&&method==="GET"){
        const result=await rpc("customer_success_summary",{p_owner_id:ownerId});
        return response(200,{success:result||{milestones:[],progress:[],points:0,completedCount:0,totalCount:0}});
      }
      if(path==="/api/customer-success/events"&&method==="POST"){
        const eventType=String(body.eventType||"");
        const eventKey=String(body.eventKey||"");
        const allowed=["session_started","workspace_opened","project_created","render_completed","asset_uploaded","workflow_completed","tutorial_completed","billing_viewed"];
        if(!allowed.includes(eventType)||eventKey.length<8||eventKey.length>120||!/^[A-Za-z0-9:_-]+$/.test(eventKey))
          return error(400,"CUSTOMER_SUCCESS_EVENT_INVALID","Provide a supported product event and a valid idempotency key.");
        const result=await rpc("record_customer_success_event",{p_owner_id:ownerId,p_event_type:eventType,p_event_key:eventKey});
        return response(202,{event:result});
      }
      if(path==="/api/billing/plans"&&method==="GET"){
        const result=await dbRequest("subscription_plans?select=plan_code,name,description,billing_interval,amount_minor,currency,included_credits,entitlements,version&status=eq.active&is_public=eq.true&order=amount_minor.asc");
        return response(200,{plans:Array.isArray(result.data)?result.data:[]});
      }
      if(path==="/api/billing/subscription"&&method==="GET"){
        const result=await dbRequest("customer_subscriptions?select=id,provider,plan_code,plan_version,status,billing_interval,amount_minor,currency,included_credits,entitlements_snapshot,current_period_start,current_period_end,grace_until,cancel_at_period_end,cancelled_at,scheduled_plan_code,scheduled_plan_version,scheduled_billing_interval,scheduled_amount_minor,scheduled_currency,scheduled_plan_at,created_at&owner_id=eq."+encodeURIComponent(ownerId)+"&status=in.(pending,trialing,active,past_due)&order=created_at.desc&limit=1");
        const subscription=Array.isArray(result.data)?result.data[0]||null:null;
        return response(200,{subscription});
      }
      if(path==="/api/billing/referrals"&&method==="GET"){
        const result=await rpc("customer_referral_summary",{p_owner_id:ownerId});
        return response(200,{referrals:result||{code:null,referrals:[],rewardsEarned:0,offer:null}});
      }
      if(path==="/api/billing/referrals/attribute"&&method==="POST"){
        const referralCode=String(body.referralCode||"").trim().toUpperCase();
        if(!/^[A-Z0-9]{8,12}$/.test(referralCode))
          return error(400,"REFERRAL_CODE_INVALID","Enter a valid 8–12 character creator referral code.");
        const result=await rpc("attribute_customer_referral_code",{
          p_referred_owner_id:ownerId,p_referral_code:referralCode
        });
        return response(200,{attribution:result});
      }
      if(path==="/api/billing/loyalty"&&method==="GET"){
        const result=await rpc("customer_loyalty_summary",{p_owner_id:ownerId});
        return response(200,{loyalty:result||{rewards:[],events:[],creditBalance:0}});
      }
      if(path==="/api/billing/subscription/manage"&&method==="POST"){
        const subscriptionId=String(body.subscriptionId||"");
        const action=String(body.action||"");
        const planCode=String(body.planCode||"").trim().toLowerCase();
        const allowed=["cancel_at_period_end","cancel_immediately","resume","schedule_plan_change","cancel_plan_change"];
        if(!UUID.test(subscriptionId)||!allowed.includes(action)||
          (action==="schedule_plan_change"&&!/^[a-z][a-z0-9_-]{1,63}$/.test(planCode)))
          return error(400,"SUBSCRIPTION_MANAGEMENT_INPUT_INVALID","Provide a valid subscription and supported management action.");
        const result=await rpc("manage_customer_subscription",{
          p_owner_id:ownerId,p_subscription_id:subscriptionId,p_action:action,
          p_plan_code:action==="schedule_plan_change"?planCode:null,
          p_reason:"Customer self-service"
        });
        return response(200,{subscription:result,message:"Subscription settings updated. Plan changes and cancellations take effect at the stated date; no automatic charge or refund was initiated."});
      }
      if(path==="/api/billing/subscription/events"&&method==="GET"){
        const subscriptionId=String(query.subscriptionId||"");
        if(!UUID.test(subscriptionId))return error(400,"SUBSCRIPTION_ID_INVALID","A valid subscription ID is required.");
        const owned=await dbRequest("customer_subscriptions?select=id&owner_id=eq."+encodeURIComponent(ownerId)+"&id=eq."+encodeURIComponent(subscriptionId)+"&limit=1");
        if(!Array.isArray(owned.data)||!owned.data.length)return error(404,"SUBSCRIPTION_NOT_FOUND","Subscription not found.");
        const events=await dbRequest("subscription_events?select=id,event_type,source,reason,event_data,created_at&owner_id=eq."+encodeURIComponent(ownerId)+"&subscription_id=eq."+encodeURIComponent(subscriptionId)+"&order=created_at.desc&limit=100");
        return response(200,{events:Array.isArray(events.data)?events.data:[]});
      }
      if(path==="/api/admin/subscriptions/grant"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"SUBSCRIPTION_ADMIN_REQUIRED","A platform owner or billing administrator role is required.");
        const customerId=String(body.customerId||"");
        const planCode=String(body.planCode||"").trim().toLowerCase();
        const reason=String(body.reason||"").trim().slice(0,500);
        const start=new Date(body.periodStart||Date.now());
        const end=new Date(body.periodEnd||"");
        if(!UUID.test(customerId)||!/^[a-z][a-z0-9_-]{1,63}$/.test(planCode)||
          reason.length<3||!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||
          end<=start||end.getTime()-start.getTime()>366*24*60*60*1000)
          return error(400,"SUBSCRIPTION_GRANT_INVALID","Provide a customer, valid plan, reason and a period no longer than 366 days.");
        const granted=await rpc("grant_customer_subscription",{
          p_actor_id:ownerId,p_owner_id:customerId,p_plan_code:planCode,
          p_period_start:start.toISOString(),p_period_end:end.toISOString(),p_reason:reason
        });
        const subscriptionId=typeof granted==="string"?granted:granted?.grant_customer_subscription||granted?.id;
        if(!UUID.test(String(subscriptionId||"")))throw Object.assign(new Error("Subscription grant returned an invalid ID."),{code:"SUBSCRIPTION_GRANT_INVALID_RESULT"});
        return response(201,{subscription:{id:subscriptionId,status:"active",planCode},message:"Subscription entitlement granted and audited."});
      }
      if(path==="/api/billing/credits"&&method==="GET"){
        const result=await rpc("get_credit_balance",{p_owner_id:ownerId});
        const balance=Array.isArray(result)?result[0]:result;
        if(!balance||!Number.isSafeInteger(Number(balance.ledger_balance))||
          !Number.isSafeInteger(Number(balance.reserved_credits))||
          !Number.isSafeInteger(Number(balance.available_credits)))
          throw Object.assign(new Error("Credit balance service returned an invalid result."),{code:"CREDIT_BALANCE_INVALID"});
        return response(200,{credits:{
          ledgerBalance:Number(balance.ledger_balance),
          reserved:Number(balance.reserved_credits),
          available:Number(balance.available_credits)
        }});
      }
      if(path==="/api/billing/products"&&method==="GET"){
        const result=await dbRequest("billing_products?select=product_code,name,description,product_type,amount_minor,currency,credit_units&active=eq.true&order=amount_minor.asc");
        return response(200,{products:Array.isArray(result.data)?result.data:[]});
      }
      if(path==="/api/billing/subscription/checkout"&&method==="POST"){
        const planCode=String(body.planCode||"").trim().toLowerCase();
        const network=String(body.network||"").toUpperCase();
        const email=String(body.email||"").trim().toLowerCase();
        const first=String(body.firstName||"").trim().slice(0,80);
        const last=String(body.lastName||"").trim().slice(0,80);
        const rawPhone=String(body.phoneNumber||"").replace(/[\s()+-]/g,"");
        const key=String(idempotencyKey||"").trim();
        const phone=rawPhone.startsWith("256")?rawPhone.slice(3):rawPhone.startsWith("0")?rawPhone.slice(1):rawPhone;
        if(!/^[a-z][a-z0-9_-]{1,63}$/.test(planCode)||!["MTN","AIRTEL"].includes(network)||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!first||!last||!/^7\d{8}$/.test(phone)||
          key.length<8||key.length>180)
          return error(400,"SUBSCRIPTION_CHECKOUT_INPUT_INVALID","Provide a valid plan, customer details, Ugandan mobile number, MTN/Airtel network and idempotency key.");
        const txRef="EVS"+randomUUID().replaceAll("-","");
        let reservation;
        try{
          reservation=await rpc("reserve_subscription_purchase",{
            p_owner_id:ownerId,p_plan_code:planCode,p_customer_email:email,
            p_mobile_money_network:network,p_idempotency_key:key,p_tx_ref:txRef
          });
        }catch(err){
          if(err?.code==="23505")return error(409,"SUBSCRIPTION_ALREADY_EXISTS","An active or pending subscription already exists, or this idempotency key is already in use.");
          throw err;
        }
        if(!reservation?.paymentId||!reservation?.subscriptionId)
          throw Object.assign(new Error("Subscription checkout reservation returned an invalid result."),{code:"SUBSCRIPTION_RESERVATION_INVALID"});
        if(reservation.idempotentReplay)
          return response(200,{payment:{id:reservation.paymentId,subscriptionId:reservation.subscriptionId,reference:reservation.txRef,status:reservation.status},idempotentReplay:true});
        try{
          const charge=await providerRequest("/orchestration/direct-charges",{
            method:"POST",idempotencyKey:key,
            body:{
              amount:minorToMajor(Number(reservation.amountMinor),String(reservation.currency)),currency:String(reservation.currency),reference:String(reservation.txRef),
              customer:{email,name:{first,last},phone:{country_code:"256",number:phone}},
              payment_method:{type:"mobile_money",mobile_money:{country_code:"256",network,phone_number:phone}}
            }
          });
          const providerCharge=charge?.data;
          if(!providerCharge?.id)throw Object.assign(new Error("Flutterwave returned no charge ID."),{code:"PROVIDER_INVALID_RESPONSE"});
          const nextAction=providerCharge.next_action||null;
          await dbRequest("payment_transactions?id=eq."+encodeURIComponent(reservation.paymentId)+"&owner_id=eq."+encodeURIComponent(ownerId),{
            method:"PATCH",body:{
              provider_transaction_id:String(providerCharge.id),
              metadata:{payment_purpose:"subscription_purchase",subscription_id:reservation.subscriptionId,
                plan_code:planCode,idempotency_key:key,mobile_money_network:network,
                provider_charge_id:String(providerCharge.id),next_action:nextAction,
                checkout_started_at:new Date().toISOString()},
              updated_at:new Date().toISOString()
            },prefer:"return=minimal"
          });
          return response(202,{payment:{id:reservation.paymentId,subscriptionId:reservation.subscriptionId,
            reference:reservation.txRef,providerChargeId:String(providerCharge.id),
            status:String(providerCharge.status||"pending"),nextAction},
            message:"Subscription checkout initiated. The plan activates only after Flutterwave verification."});
        }catch(err){
          await dbRequest("payment_transactions?id=eq."+encodeURIComponent(reservation.paymentId)+"&owner_id=eq."+encodeURIComponent(ownerId),{
            method:"PATCH",body:{metadata:{payment_purpose:"subscription_purchase",subscription_id:reservation.subscriptionId,
              plan_code:planCode,idempotency_key:key,mobile_money_network:network,
              checkout_error_code:err.code||"PROVIDER_RESULT_UNCERTAIN",checkout_result_uncertain:true},
              updated_at:new Date().toISOString()},prefer:"return=minimal"
          }).catch(()=>{});
          return response(err.status===202?202:502,{payment:{id:reservation.paymentId,
            subscriptionId:reservation.subscriptionId,reference:reservation.txRef,status:"pending"},
            error:{code:err.code||"CHECKOUT_RESULT_UNCERTAIN",message:"Subscription payment initiation is not confirmed. Reconcile this reference before retrying."}});
        }
      }
      if(path==="/api/billing/subscription/renewal-checkout"&&method==="POST"){
        const subscriptionId=String(body.subscriptionId||"");
        const network=String(body.network||"").toUpperCase();
        const email=String(body.email||"").trim().toLowerCase();
        const first=String(body.firstName||"").trim().slice(0,80);
        const last=String(body.lastName||"").trim().slice(0,80);
        const rawPhone=String(body.phoneNumber||"").replace(/[\s()+-]/g,"");
        const key=String(idempotencyKey||"").trim();
        const phone=rawPhone.startsWith("256")?rawPhone.slice(3):rawPhone.startsWith("0")?rawPhone.slice(1):rawPhone;
        if(!UUID.test(subscriptionId)||!["MTN","AIRTEL"].includes(network)||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!first||!last||!/^7\d{8}$/.test(phone)||
          key.length<8||key.length>180)
          return error(400,"SUBSCRIPTION_RENEWAL_INPUT_INVALID","Provide a valid subscription, customer details, Ugandan mobile number, MTN/Airtel network and idempotency key.");
        const prior=await dbRequest("payment_transactions?select=id,customer_email,tx_ref,status,provider_transaction_id,metadata&owner_id=eq."+encodeURIComponent(ownerId)+"&metadata->>idempotency_key=eq."+encodeURIComponent(key)+"&limit=1");
        if(Array.isArray(prior.data)&&prior.data.length){
          const row=prior.data[0];
          if(row.metadata?.payment_purpose!=="subscription_renewal"||row.metadata?.subscription_id!==subscriptionId||row.metadata?.mobile_money_network!==network||String(row.customer_email||"").trim().toLowerCase()!==email)
            return error(409,"IDEMPOTENCY_KEY_REUSED","This idempotency key is already bound to another payment.");
          return response(200,{payment:{id:row.id,reference:row.tx_ref,status:row.status,providerChargeId:row.provider_transaction_id,nextAction:row.metadata?.next_action||null},idempotentReplay:true});
        }
        const pending=await dbRequest("payment_transactions?select=id,tx_ref&owner_id=eq."+encodeURIComponent(ownerId)+"&status=eq.pending&metadata->>payment_purpose=eq.subscription_renewal&metadata->>subscription_id=eq."+encodeURIComponent(subscriptionId)+"&limit=1");
        if(Array.isArray(pending.data)&&pending.data.length)
          return error(409,"SUBSCRIPTION_RENEWAL_ALREADY_PENDING","A renewal payment is already awaiting confirmation. Complete or reconcile it before starting another.");
        const subscriptionResult=await dbRequest("customer_subscriptions?select=id,owner_id,status,billing_interval,amount_minor,currency,current_period_end,customer_email,cancel_at_period_end,scheduled_plan_code,scheduled_billing_interval,scheduled_amount_minor,scheduled_currency&owner_id=eq."+encodeURIComponent(ownerId)+"&id=eq."+encodeURIComponent(subscriptionId)+"&limit=1");
        const subscription=Array.isArray(subscriptionResult.data)?subscriptionResult.data[0]:null;
        if(!subscription)return error(404,"SUBSCRIPTION_NOT_FOUND","Subscription not found.");
        if(!["active","past_due"].includes(subscription.status)||subscription.cancel_at_period_end||
          !["monthly","yearly"].includes(subscription.billing_interval)||
          subscription.currency!=="UGX"||!Number.isSafeInteger(Number(subscription.scheduled_amount_minor??subscription.amount_minor))||Number(subscription.scheduled_amount_minor??subscription.amount_minor)<=0)
          return error(409,"SUBSCRIPTION_NOT_RENEWABLE","Only an active or past-due UGX subscription with a configured monthly or yearly price can be renewed.");
        const txRef="EVR"+randomUUID().replaceAll("-","");
        const created=await dbRequest("payment_transactions",{
          method:"POST",body:{
            owner_id:ownerId,tx_ref:txRef,amount_minor:Number(subscription.scheduled_amount_minor??subscription.amount_minor),currency:"UGX",
            status:"pending",payment_method:"mobile_money",customer_email:email,
            description:"Subscription renewal",
            metadata:{payment_purpose:"subscription_renewal",subscription_id:subscription.id,idempotency_key:key,mobile_money_network:network,billing_interval:subscription.scheduled_billing_interval||subscription.billing_interval,scheduled_plan_code:subscription.scheduled_plan_code||null}
          },prefer:"return=representation"
        });
        const payment=Array.isArray(created.data)?created.data[0]:null;
        if(!payment?.id)throw Object.assign(new Error("Subscription renewal reservation could not be created."),{code:"SUBSCRIPTION_RENEWAL_RESERVATION_FAILED"});
        try{
          const charge=await providerRequest("/orchestration/direct-charges",{
            method:"POST",idempotencyKey:key,
            body:{
              amount:minorToMajor(Number(subscription.scheduled_amount_minor??subscription.amount_minor),"UGX"),currency:"UGX",reference:txRef,
              customer:{email,name:{first,last},phone:{country_code:"256",number:phone}},
              payment_method:{type:"mobile_money",mobile_money:{country_code:"256",network,phone_number:phone}}
            }
          });
          const providerCharge=charge?.data;
          if(!providerCharge?.id)throw Object.assign(new Error("Flutterwave returned no charge ID."),{code:"PROVIDER_INVALID_RESPONSE"});
          const nextAction=providerCharge.next_action||null;
          await dbRequest("payment_transactions?id=eq."+encodeURIComponent(payment.id),{
            method:"PATCH",body:{
              provider_transaction_id:String(providerCharge.id),
              metadata:{...payment.metadata,provider_charge_id:String(providerCharge.id),next_action:nextAction,checkout_started_at:new Date().toISOString()},
              updated_at:new Date().toISOString()
            },prefer:"return=minimal"
          });
          return response(202,{payment:{id:payment.id,reference:txRef,providerChargeId:String(providerCharge.id),status:String(providerCharge.status||"pending"),nextAction},message:"Renewal payment initiated. The subscription period is extended only after Flutterwave verification."});
        }catch(err){
          await dbRequest("payment_transactions?id=eq."+encodeURIComponent(payment.id),{
            method:"PATCH",body:{metadata:{...payment.metadata,checkout_error_code:err.code||"PROVIDER_RESULT_UNCERTAIN",checkout_result_uncertain:true},updated_at:new Date().toISOString()},prefer:"return=minimal"
          }).catch(()=>{});
          return response(err.status===202?202:502,{payment:{id:payment.id,reference:txRef,status:"pending"},error:{code:err.code||"CHECKOUT_RESULT_UNCERTAIN",message:"Renewal initiation is not confirmed. Reconcile this reference before retrying."}});
        }
      }
      if(path==="/api/billing/checkout"&&method==="POST"){
        const productCode=String(body.productCode||"").trim();
        const network=String(body.network||"").toUpperCase();
        const email=String(body.email||"").trim().toLowerCase();
        const first=String(body.firstName||"").trim().slice(0,80);
        const last=String(body.lastName||"").trim().slice(0,80);
        const rawPhone=String(body.phoneNumber||"").replace(/[\s()+-]/g,"");
        const key=String(idempotencyKey||"").trim();
        const phone=rawPhone.startsWith("256")?rawPhone.slice(3):rawPhone.startsWith("0")?rawPhone.slice(1):rawPhone;
        if(!/^[a-z0-9][a-z0-9_-]{2,59}$/.test(productCode)||!["MTN","AIRTEL"].includes(network)||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!first||!last||!/^7\d{8}$/.test(phone)||
          key.length<8||key.length>180)
          return error(400,"CHECKOUT_INPUT_INVALID","Provide a valid product, customer name and email, Ugandan mobile number, MTN/Airtel network and idempotency key.");
        const prior=await dbRequest("payment_transactions?select=id,customer_email,tx_ref,status,provider_transaction_id,metadata&owner_id=eq."+encodeURIComponent(ownerId)+"&metadata->>idempotency_key=eq."+encodeURIComponent(key)+"&limit=1");
        if(Array.isArray(prior.data)&&prior.data.length){
          const row=prior.data[0];
          if(row.metadata?.product_code!==productCode||row.metadata?.mobile_money_network!==network||String(row.customer_email||"").trim().toLowerCase()!==email)
            return error(409,"IDEMPOTENCY_KEY_REUSED","This idempotency key is already bound to a different checkout request.");
          return response(200,{payment:{id:row.id,reference:row.tx_ref,status:row.status,providerChargeId:row.provider_transaction_id,nextAction:row.metadata?.next_action||null},idempotentReplay:true});
        }
        const productResult=await dbRequest("billing_products?select=product_code,name,description,amount_minor,currency,credit_units&product_code=eq."+encodeURIComponent(productCode)+"&active=eq.true&limit=1");
        const product=Array.isArray(productResult.data)?productResult.data[0]:null;
        if(!product)return error(404,"BILLING_PRODUCT_UNAVAILABLE","This purchase option is not currently available.");
        if(product.currency!=="UGX"||!Number.isSafeInteger(Number(product.amount_minor))||Number(product.amount_minor)<=0||
          !Number.isSafeInteger(Number(product.credit_units))||Number(product.credit_units)<=0)
          return error(503,"BILLING_PRODUCT_INVALID","This purchase option is not configured safely.");
        const txRef="EV"+randomUUID().replaceAll("-","");
        const createdRows=await dbRequest("payment_transactions",{
          method:"POST",body:{
            owner_id:ownerId,tx_ref:txRef,amount_minor:Number(product.amount_minor),currency:"UGX",
            status:"pending",payment_method:"mobile_money",customer_email:email,
            description:String(product.name).slice(0,250),
            metadata:{product_code:product.product_code,credit_units:Number(product.credit_units),idempotency_key:key,mobile_money_network:network}
          },prefer:"return=representation"
        });
        const payment=Array.isArray(createdRows.data)?createdRows.data[0]:null;
        if(!payment?.id)throw Object.assign(new Error("Checkout reservation could not be created."),{code:"CHECKOUT_RESERVATION_FAILED"});
        try{
          const charge=await providerRequest("/orchestration/direct-charges",{
            method:"POST",idempotencyKey:key,
            body:{
              amount:minorToMajor(Number(product.amount_minor),"UGX"),currency:"UGX",reference:txRef,
              customer:{email,name:{first,last},phone:{country_code:"256",number:phone}},
              payment_method:{type:"mobile_money",mobile_money:{country_code:"256",network,phone_number:phone}}
            }
          });
          const providerCharge=charge?.data;
          if(!providerCharge?.id)throw Object.assign(new Error("Flutterwave returned no charge ID."),{code:"PROVIDER_INVALID_RESPONSE"});
          const nextAction=providerCharge.next_action||null;
          const metadata={...payment.metadata,provider_charge_id:String(providerCharge.id),next_action:nextAction,checkout_started_at:new Date().toISOString()};
          await dbRequest("payment_transactions?id=eq."+encodeURIComponent(payment.id),{
            method:"PATCH",body:{provider_transaction_id:String(providerCharge.id),metadata,updated_at:new Date().toISOString()},prefer:"return=minimal"
          });
          return response(202,{payment:{id:payment.id,reference:txRef,providerChargeId:String(providerCharge.id),status:String(providerCharge.status||"pending"),nextAction},message:"Payment initiated. Ask the customer to approve the prompt on their mobile-money phone. Credits are issued only after provider verification."});
        }catch(err){
          await dbRequest("payment_transactions?id=eq."+encodeURIComponent(payment.id),{
            method:"PATCH",body:{metadata:{...payment.metadata,checkout_error_code:err.code||"PROVIDER_RESULT_UNCERTAIN",checkout_result_uncertain:true},updated_at:new Date().toISOString()},prefer:"return=minimal"
          }).catch(()=>{});
          return response(err.status===202?202:502,{payment:{id:payment.id,reference:txRef,status:"pending"},error:{code:err.code||"CHECKOUT_RESULT_UNCERTAIN",message:"Payment initiation is not confirmed. Do not retry with a new reference; check this transaction's status first."}});
        }
      }
      if(path==="/api/billing/transactions"&&method==="GET"){
        const limit=Math.max(1,Math.min(SAFE_PAGE,Number(query.limit)||25));
        const offset=Math.max(0,Math.min(10000,Number(query.offset)||0));
        const result=await dbRequest("payment_transactions?select=id,tx_ref,amount_minor,currency,status,payment_method,description,paid_at,created_at&owner_id=eq."+encodeURIComponent(ownerId)+"&order=created_at.desc&limit="+limit+"&offset="+offset);
        return response(200,{transactions:Array.isArray(result.data)?result.data:[],limit,offset});
      }
      if(path==="/api/billing/invoices"&&method==="GET"){
        const limit=Math.max(1,Math.min(SAFE_PAGE,Number(query.limit)||25));
        const offset=Math.max(0,Math.min(10000,Number(query.offset)||0));
        const result=await dbRequest("billing_invoices?select=id,payment_transaction_id,invoice_number,currency,total_minor,issued_at,snapshot,pdf_object_path&owner_id=eq."+encodeURIComponent(ownerId)+"&order=issued_at.desc&limit="+limit+"&offset="+offset);
        const invoices=(Array.isArray(result.data)?result.data:[]).map(row=>({
          id:row.id,paymentTransactionId:row.payment_transaction_id,
          invoiceNumber:row.invoice_number,currency:row.currency,
          totalMinor:Number(row.total_minor),issuedAt:row.issued_at,
          snapshot:row.snapshot,pdfAvailable:Boolean(row.pdf_object_path)
        }));
        return response(200,{invoices,limit,offset});
      }
      if(path==="/api/billing/notifications"&&method==="GET"){
        const limit=Math.max(1,Math.min(50,Number(query.limit)||25));
        const result=await dbRequest("billing_notification_outbox?select=id,notification_type,payload,status,created_at,read_at&owner_id=eq."+encodeURIComponent(ownerId)+"&order=created_at.desc&limit="+limit);
        return response(200,{notifications:Array.isArray(result.data)?result.data:[],limit});
      }
      if(path==="/api/billing/notifications/read"&&method==="POST"){
        const notificationId=String(body.notificationId||"");
        if(!UUID.test(notificationId))return error(400,"NOTIFICATION_ID_INVALID","A valid notification ID is required.");
        const updated=await dbRequest("billing_notification_outbox?id=eq."+encodeURIComponent(notificationId)+"&owner_id=eq."+encodeURIComponent(ownerId)+"&read_at=is.null",{
          method:"PATCH",body:{read_at:new Date().toISOString()},prefer:"return=representation"
        });
        return response(200,{markedRead:Array.isArray(updated.data)&&updated.data.length>0});
      }
      if(path==="/api/billing/refunds"&&method==="GET"){
        const limit=Math.max(1,Math.min(SAFE_PAGE,Number(query.limit)||25));
        const offset=Math.max(0,Math.min(10000,Number(query.offset)||0));
        const result=await dbRequest("payment_refunds?select=id,payment_transaction_id,amount_minor,currency,status,reason,requested_at,completed_at&owner_id=eq."+encodeURIComponent(ownerId)+"&order=requested_at.desc&limit="+limit+"&offset="+offset);
        return response(200,{refunds:Array.isArray(result.data)?result.data:[],limit,offset});
      }
      if(path==="/api/admin/billing/provider-readiness"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A billing administrator role is required.");
        return response(200,{
          provider:"flutterwave",
          currentIntegrationApiVersion:"v4",
          recurringPaymentPlansApiVersion:"v3",
          recurringSubscriptionsAvailable:false,
          reason:"Flutterwave documents that a merchant can use only one API version at a time. The current integration uses v4; payment plans are documented on v3.",
          migrationRequired:"Do not call v3 payment-plan endpoints from this v4 integration. Select and migrate the complete merchant integration to one API version before enabling recurring subscriptions.",
          cardOnlyRecurring:true,
          oneTimeMobileMoneySeparate:true,
          liveRecurringChargesEnabled:false,
          credentialsExposed:false
        });
      }
      if(path==="/api/admin/subscriptions/reconciliation/resolve"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"SUBSCRIPTION_ADMIN_REQUIRED","A platform owner or billing administrator role is required.");
        const eventId=String(body.eventId||""),subscriptionId=String(body.subscriptionId||""),reason=String(body.reason||"").trim();
        if(!UUID.test(eventId)||!UUID.test(subscriptionId)||reason.length<3||reason.length>500)
          return error(400,"SUBSCRIPTION_RECONCILIATION_INPUT_INVALID","Provide a valid webhook event, exact subscription ID and a 3–500 character review reason.");
        const reconciliation=await rpc("reconcile_flutterwave_subscription_cancellation",{
          p_actor_id:ownerId,p_event_id:eventId,p_subscription_id:subscriptionId,p_reason:reason
        });
        if(reconciliation?.resolved!==true){
          const reason=String(reconciliation?.reason||"The provider event could not be matched uniquely to the selected subscription.");
          return response(409,{error:{code:"SUBSCRIPTION_RECONCILIATION_REQUIRES_REVIEW",message:reason},reconciliation:reconciliation||{resolved:false,reviewRequired:true}});
        }
        return response(200,{reconciliation});
      }
      if(path==="/api/admin/subscriptions/reconciliation"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"SUBSCRIPTION_ADMIN_REQUIRED","A platform owner or billing administrator role is required.");
        const limit=Math.max(1,Math.min(100,Number(query.limit)||25));
        const result=await dbRequest("payment_webhook_events?select=id,event_type,payload_hash,processing_status,payload,received_at&provider=eq.flutterwave&event_type=eq.subscription.cancelled&processing_status=eq.needs_review&order=received_at.asc&limit="+limit);
        const events=(Array.isArray(result.data)?result.data:[]).map(row=>({
          id:row.id,eventType:row.event_type,payloadHash:row.payload_hash,
          receivedAt:row.received_at,
          customerEmail:String(row.payload?.data?.customer?.email||"").slice(0,254),
          providerPlanId:row.payload?.data?.plan?.id??null,
          providerStatus:String(row.payload?.data?.status||"").slice(0,40),
          reviewRequired:true
        }));
        return response(200,{events,limit,automatedEntitlementChanges:false});
      }
      if(path==="/api/admin/billing/recovery"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"BILLING_ADMIN_REQUIRED","A billing administrator role is required.");
        const limit=Math.max(1,Math.min(100,Number(query.limit)||50));
        const [attempts,notifications]=await Promise.all([
          dbRequest("payment_attempts?select=id,owner_id,payment_transaction_id,tx_ref,amount_minor,currency,status,failure_code,failure_message,attempt_number,next_retry_at,created_at&status=in.(failed,retry_scheduled,exhausted)&order=created_at.desc&limit="+limit),
          dbRequest("billing_notification_outbox?select=id,owner_id,notification_type,status,attempt_count,available_at,last_error,created_at&status=in.(queued,failed)&order=created_at.asc&limit="+limit)
        ]);
        const rows=Array.isArray(attempts.data)?attempts.data:[];
        return response(200,{
          attempts:rows,
          notifications:Array.isArray(notifications.data)?notifications.data:[],
          summary:{openAttempts:rows.length,scheduledRetries:rows.filter(x=>x.status==="retry_scheduled").length,exhausted:rows.filter(x=>x.status==="exhausted").length},
          automaticChargesEnabled:false,
          emailDeliveryConfigured:false,
          note:"Customers must explicitly retry mobile-money checkout. Email messages remain queued until a transactional email provider is configured."
        });
      }
      if(path==="/api/admin/billing/recovery/expire-grace"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"BILLING_ADMIN_REQUIRED","A billing administrator role is required.");
        const result=await rpc("expire_due_subscriptions",{p_limit:Math.max(1,Math.min(500,Number(body.limit)||100))});
        return response(200,{...result,action:"expired_only_after_grace_deadline",providerChargesInitiated:false});
      }
      if(path==="/api/customer-success/experiments/assign"&&method==="POST"){
        const experimentKey=String(body.experimentKey||"");
        if(!/^[a-z0-9][a-z0-9_-]{2,59}$/.test(experimentKey))
          return error(400,"GROWTH_EXPERIMENT_KEY_INVALID","Provide a valid experiment key.");
        const assignment=await rpc("customer_growth_assign_experiment",{p_owner_id:ownerId,p_experiment_key:experimentKey});
        return response(200,{assignment:assignment||{assigned:false,reason:"experiment_not_active"}});
      }
      if(path==="/api/admin/customer-success/growth"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"CUSTOMER_SUCCESS_ADMIN_REQUIRED","A platform or billing administrator role is required.");
        const result=await rpc("customer_growth_admin_overview",{});
        return response(200,{growth:result||{cohorts:[],renewalWatchlist:[],cancellationReasons:[],experiments:[]}});
      }
      if(path==="/api/admin/finance/cashflow-forecast"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const forecast=await rpc("financial_cashflow_forecast_overview",{p_actor_id:ownerId});
        return response(200,{cashflowForecast:forecast||{scenarios:[],items:[],positions:[],limitations:["Cashflow forecast data is not available."]}});
      }
      if(path==="/api/admin/finance/cash-position"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const currency=String(body.currency||"").trim().toUpperCase(),available=Number(body.availableCashMinor),restricted=body.restrictedCashMinor==null?0:Number(body.restrictedCashMinor);
        const asOfDate=String(body.asOfDate||""),sourceType=String(body.sourceType||""),sourceReference=String(body.sourceReference||"").trim(),evidenceNote=String(body.evidenceNote||"").trim(),idempotencyKey=String(body.idempotencyKey||"");
        if(!/^[A-Z]{3}$/.test(currency)||!Number.isSafeInteger(available)||available<0||!Number.isSafeInteger(restricted)||restricted<0||!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)||!Number.isFinite(Date.parse(asOfDate+"T00:00:00Z"))||new Date(asOfDate+"T00:00:00Z").toISOString().slice(0,10)!==asOfDate||asOfDate>new Date().toISOString().slice(0,10)||!["bank_statement","bank_portal","cashbook","manual_attestation","other"].includes(sourceType)||sourceReference.length<3||sourceReference.length>240||evidenceNote.length<3||evidenceNote.length>1000||idempotencyKey.length<8||idempotencyKey.length>160)
          return error(400,"CASH_POSITION_INVALID","Provide a valid currency, non-negative safe-integer cash amounts, non-future date, evidence source/reference/note and idempotency key.");
        const position=await rpc("record_financial_cash_position",{p_actor_id:ownerId,p_payload:{currency,availableCashMinor:available,restrictedCashMinor:restricted,asOfDate,sourceType,sourceReference,evidenceNote,idempotencyKey}});
        return response(201,{position});
      }
      if(path==="/api/admin/finance/cashflow-items"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const direction=String(body.direction||""),currency=String(body.currency||"").trim().toUpperCase(),amount=Number(body.amountMinor),expectedDate=String(body.expectedDate||"");
        const confidence=body.confidenceBps==null?10000:Number(body.confidenceBps),status=String(body.status||"planned"),sourceType=String(body.sourceType||"other");
        const sourceReference=String(body.sourceReference||"").trim(),description=String(body.description||"").trim(),idempotencyKey=String(body.idempotencyKey||"");
        if(!["inflow","outflow"].includes(direction)||!/^[A-Z]{3}$/.test(currency)||!Number.isSafeInteger(amount)||amount<=0||!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)||!Number.isFinite(Date.parse(expectedDate+"T00:00:00Z"))||new Date(expectedDate+"T00:00:00Z").toISOString().slice(0,10)!==expectedDate||expectedDate<new Date().toISOString().slice(0,10)||expectedDate>new Date(Date.now()+366*86400000).toISOString().slice(0,10)||!Number.isInteger(confidence)||confidence<0||confidence>10000||!["planned","committed"].includes(status)||!["customer_receipt","subscription_collection","invoice","vendor_bill","payroll","infrastructure","tax","debt_service","capital_expenditure","other"].includes(sourceType)||sourceReference.length<3||sourceReference.length>240||description.length<3||description.length>500||idempotencyKey.length<8||idempotencyKey.length>160)
          return error(400,"CASHFLOW_ITEM_INVALID","Provide a valid dated inflow/outflow, positive safe-integer amount, confidence (0–10000 bps), planned/committed status, source evidence and idempotency key.");
        const item=await rpc("record_financial_cashflow_item",{p_actor_id:ownerId,p_payload:{direction,currency,amountMinor:amount,expectedDate,confidenceBps:confidence,status,sourceType,sourceReference,description,idempotencyKey}});
        return response(201,{item});
      }
      if(path==="/api/admin/finance/liquidity-guardrails"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const guardrails=await rpc("financial_liquidity_guardrails_overview",{p_actor_id:ownerId});
        return response(200,{guardrails:guardrails||{policies:[],scenarios:[],limitations:["Liquidity guardrails are not available."]}});
      }
      if(path==="/api/admin/finance/liquidity-stress"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const overview=await rpc("financial_liquidity_stress_overview",{p_actor_id:ownerId});
        return response(200,{stress:overview||{scenarios:[],runs:[],contingencyOptions:[]}});
      }
      if(path==="/api/admin/finance/liquidity-stress-scenarios"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const name=String(body.name||"").trim(),currency=String(body.currency||"").trim().toUpperCase();
        const inflowReductionBps=Number(body.inflowReductionBps),outflowIncreaseBps=Number(body.outflowIncreaseBps),immediateCashShockMinor=Number(body.immediateCashShockMinor);
        const sourceReference=String(body.sourceReference||"").trim(),rationale=String(body.rationale||"").trim(),idempotencyKey=String(body.idempotencyKey||"");
        if(name.length<3||name.length>120||!/^[A-Z]{3}$/.test(currency)||!Number.isInteger(inflowReductionBps)||inflowReductionBps<0||inflowReductionBps>10000||
          !Number.isInteger(outflowIncreaseBps)||outflowIncreaseBps<0||outflowIncreaseBps>30000||!Number.isSafeInteger(immediateCashShockMinor)||immediateCashShockMinor<0||
          sourceReference.length<3||sourceReference.length>240||rationale.length<3||rationale.length>1000||idempotencyKey.length<8||idempotencyKey.length>160)
          return error(400,"LIQUIDITY_STRESS_SCENARIO_INVALID","Provide valid scenario assumptions, a currency and supporting evidence.");
        const scenario=await rpc("record_financial_liquidity_stress_scenario",{p_actor_id:ownerId,p_payload:{name,currency,inflowReductionBps,outflowIncreaseBps,immediateCashShockMinor,sourceReference,rationale,idempotencyKey}});
        return response(201,{scenario});
      }
      if(path==="/api/admin/finance/liquidity-stress-runs"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const scenarioId=String(body.scenarioId||"");
        if(!UUID.test(scenarioId))return error(400,"LIQUIDITY_STRESS_SCENARIO_ID_INVALID","A valid saved scenario ID is required.");
        const result=await rpc("run_financial_liquidity_stress_test",{p_actor_id:ownerId,p_scenario_id:scenarioId});
        return response(201,{result});
      }
      if(path==="/api/admin/finance/liquidity-contingency-options"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const currency=String(body.currency||"").trim().toUpperCase(),title=String(body.title||"").trim(),category=String(body.category||"");
        const estimatedCapacityMinor=Number(body.estimatedCapacityMinor),leadTimeHours=Number(body.leadTimeHours),availabilityStatus=String(body.availabilityStatus||"");
        const sourceReference=String(body.sourceReference||"").trim(),rationale=String(body.rationale||"").trim(),idempotencyKey=String(body.idempotencyKey||"");
        if(!/^[A-Z]{3}$/.test(currency)||title.length<3||title.length>160||
          !["receivables_acceleration","discretionary_spend","supplier_terms","committed_facility","asset_monetization","owner_funding","other"].includes(category)||
          !Number.isSafeInteger(estimatedCapacityMinor)||estimatedCapacityMinor<0||!Number.isInteger(leadTimeHours)||leadTimeHours<0||leadTimeHours>8760||
          !["validated","conditional","unverified"].includes(availabilityStatus)||sourceReference.length<3||sourceReference.length>240||
          rationale.length<3||rationale.length>1000||idempotencyKey.length<8||idempotencyKey.length>160)
          return error(400,"LIQUIDITY_CONTINGENCY_OPTION_INVALID","Provide a valid currency, capacity, lead time, readiness status and supporting evidence.");
        const option=await rpc("record_financial_contingency_option",{p_actor_id:ownerId,p_payload:{currency,title,category,estimatedCapacityMinor,leadTimeHours,availabilityStatus,sourceReference,rationale,idempotencyKey}});
        return response(201,{option});
      }
      if(path==="/api/admin/finance/liquidity-alerts"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const refresh=await rpc("refresh_financial_liquidity_alerts",{p_actor_id:ownerId});
        const alerts=await rpc("financial_liquidity_alerts_overview",{p_actor_id:ownerId});
        return response(200,{refresh:refresh||{},alerts:alerts||{alerts:[]}});
      }
      if(path==="/api/admin/finance/liquidity-alert-events"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const alertId=String(body.alertId||""),eventType=String(body.eventType||""),note=String(body.note||"").trim();
        const assignedTo=String(body.assignedTo||"").trim(),dueDate=String(body.dueDate||""),idempotencyKey=String(body.idempotencyKey||"");
        const validDate=(value)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+"T00:00:00Z"))&&new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(alertId)||
          !["acknowledged","action_assigned","in_progress","resolved","reopened","false_positive"].includes(eventType)||
          note.length<3||note.length>1000||(eventType==="action_assigned"&&(assignedTo.length<2||assignedTo.length>160))||
          (dueDate&&(!validDate(dueDate)||dueDate<new Date().toISOString().slice(0,10)))||idempotencyKey.length<8||idempotencyKey.length>180)
          return error(400,"LIQUIDITY_ALERT_EVENT_INVALID","Provide a valid alert, supported action, note, required assignee and non-backdated due date.");
        const event=await rpc("record_financial_liquidity_alert_event",{p_actor_id:ownerId,p_payload:{alertId,eventType,note,assignedTo:assignedTo||null,dueDate:dueDate||null,idempotencyKey}});
        return response(201,{event});
      }
      if(path==="/api/admin/finance/liquidity-policies"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const currency=String(body.currency||"").trim().toUpperCase(),floor=Number(body.minimumCashFloorMinor),reserve=Number(body.reserveTargetMinor);
        const effectiveFrom=String(body.effectiveFrom||""),sourceReference=String(body.sourceReference||"").trim();
        const rationale=String(body.rationale||"").trim(),idempotencyKey=String(body.idempotencyKey||"");
        if(!/^[A-Z]{3}$/.test(currency)||!Number.isSafeInteger(floor)||floor<0||!Number.isSafeInteger(reserve)||reserve<floor||
          !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)||!Number.isFinite(Date.parse(effectiveFrom+"T00:00:00Z"))||
          new Date(effectiveFrom+"T00:00:00Z").toISOString().slice(0,10)!==effectiveFrom||effectiveFrom<new Date().toISOString().slice(0,10)||
          sourceReference.length<3||sourceReference.length>240||rationale.length<3||rationale.length>1000||idempotencyKey.length<8||idempotencyKey.length>160)
          return error(400,"LIQUIDITY_POLICY_INVALID","Provide a valid currency, non-negative minimum cash floor, reserve target at least the floor, non-backdated effective date and policy evidence.");
        const policy=await rpc("record_financial_liquidity_policy",{p_actor_id:ownerId,p_payload:{currency,minimumCashFloorMinor:floor,reserveTargetMinor:reserve,effectiveFrom,sourceReference,rationale,idempotencyKey}});
        return response(201,{policy});
      }
      if(path==="/api/admin/finance/cashflow-reconciliation"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const today=new Date().toISOString().slice(0,10);
        const defaultFrom=new Date(Date.now()-90*86400000).toISOString().slice(0,10);
        const defaultTo=new Date(Date.now()+180*86400000).toISOString().slice(0,10);
        const fromDate=String(query.fromDate||defaultFrom),toDate=String(query.toDate||defaultTo);
        const validDate=(value)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+"T00:00:00Z"))&&new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
        if(!validDate(fromDate)||!validDate(toDate)||toDate<fromDate||Date.parse(toDate+"T00:00:00Z")-Date.parse(fromDate+"T00:00:00Z")>366*86400000)
          return error(400,"CASHFLOW_RECONCILIATION_RANGE_INVALID","Provide a valid ordered date range no longer than 367 days.");
        const reconciliation=await rpc("financial_cashflow_reconciliation",{p_actor_id:ownerId,p_from_date:fromDate,p_to_date:toDate});
        return response(200,{reconciliation:reconciliation||{items:[],currencies:[],limitations:["No reconciliation data is available."]}});
      }
      if(path==="/api/admin/finance/cashflow-actuals"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const cashflowItemId=String(body.cashflowItemId||""),amount=Number(body.amountMinor),actualDate=String(body.actualDate||"");
        const sourceType=String(body.sourceType||""),sourceReference=String(body.sourceReference||"").trim();
        const evidenceNote=String(body.evidenceNote||"").trim(),idempotencyKey=String(body.idempotencyKey||"");
        if(!UUID.test(cashflowItemId)||!Number.isSafeInteger(amount)||amount<=0||!/^\d{4}-\d{2}-\d{2}$/.test(actualDate)||!Number.isFinite(Date.parse(actualDate+"T00:00:00Z"))||new Date(actualDate+"T00:00:00Z").toISOString().slice(0,10)!==actualDate||actualDate>new Date().toISOString().slice(0,10)||!["bank_statement","bank_portal","cashbook","payment_confirmation","receipt_confirmation","other"].includes(sourceType)||sourceReference.length<3||sourceReference.length>240||evidenceNote.length<3||evidenceNote.length>1000||idempotencyKey.length<8||idempotencyKey.length>160)
          return error(400,"CASHFLOW_ACTUAL_INVALID","Provide a valid cashflow item, positive safe-integer amount, non-future actual date and source-referenced evidence.");
        const actual=await rpc("record_financial_cashflow_actual",{p_actor_id:ownerId,p_payload:{cashflowItemId,amountMinor:amount,actualDate,sourceType,sourceReference,evidenceNote,idempotencyKey}});
        return response(201,{actual});
      }
      if(path==="/api/admin/finance/predictive-overview"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const result=await rpc("financial_predictive_revenue_overview",{p_actor_id:ownerId});
        return response(200,{forecast:result||{currencies:[],limitations:["Forecast data is not yet available."]}});
      }
      if(path==="/api/admin/finance/revenue-movement"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const result=await rpc("financial_revenue_movement_overview",{p_actor_id:ownerId});
        return response(200,{movementIntelligence:result||{comparison:{available:false},movement:[],cohorts:[],limitations:["Revenue movement data is not yet available."]}});
      }
      if(path==="/api/admin/finance/revenue-retention"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const result=await rpc("financial_revenue_retention_overview",{p_actor_id:ownerId});
        return response(200,{intelligence:result||{retention:[],acquisition:[],forecastAccuracy:[],limitations:[]}});
      }
      if(path==="/api/admin/finance/ai-cost-intelligence"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const month=String(body.periodMonth||"");
        const periodMonth=month||new Date().toISOString().slice(0,7)+"-01";
        if(!/^\d{4}-\d{2}-01$/.test(periodMonth)||!Number.isFinite(Date.parse(periodMonth+"T00:00:00Z"))||new Date(periodMonth+"T00:00:00Z").toISOString().slice(0,10)!==periodMonth)
          return error(400,"AI_COST_PERIOD_INVALID","Provide a valid reporting month.");
        const result=await rpc("ai_cost_intelligence_overview",{p_actor_id:ownerId,p_period_month:periodMonth});
        return response(200,{intelligence:result||{byProviderModel:[],byCustomer:[],unpricedEvents:0,limitations:[]}});
      }
      if(path==="/api/admin/finance/model-rate-cards"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const provider=query.provider?String(query.provider).trim().toLowerCase():null;
        const model=query.model?String(query.model).trim():null;
        const currency=query.currency?String(query.currency).trim().toUpperCase():null;
        const limit=Number(query.limit||200);
        if(provider&&(!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(provider))||
          model&&model.length>160||currency&&!/^[A-Z]{3}$/.test(currency)||
          !Number.isSafeInteger(limit)||limit<1||limit>500)
          return error(400,"MODEL_RATE_CARD_FILTER_INVALID","Provide valid provider/model/currency filters and a limit from 1 to 500.");
        const result=await rpc("ai_model_price_rate_card_catalog",{p_actor_id:ownerId,
          p_provider:provider,p_model:model,p_currency:currency,p_limit:limit});
        return response(200,{catalog:result||{rateCards:[],count:0,limitations:[]}});
      }
      if(path==="/api/admin/finance/model-rate-cards"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const rate=body.rateCard||{};
        const provider=String(rate.provider||"").trim().toLowerCase();
        const model=String(rate.model||"").trim();
        const currency=String(rate.currency||"").trim().toUpperCase();
        const version=String(rate.rateCardVersion||"").trim();
        const billingUnit=String(rate.billingUnit||"");
        const effectiveFrom=String(rate.effectiveFrom||"");
        const effectiveTo=rate.effectiveTo?String(rate.effectiveTo):null;
        const sourceType=String(rate.sourceType||"");
        const sourceReference=String(rate.sourceReference||"").trim();
        const sourceUrl=String(rate.sourceUrl||"").trim();
        const sourceCheckedAt=rate.sourceCheckedAt?String(rate.sourceCheckedAt):null;
        const sourceFingerprint=String(rate.sourceFingerprint||"").toLowerCase();
        const verificationStatus=String(rate.verificationStatus||"");
        const dimensions=rate.pricingDimensions===undefined?{}:rate.pricingDimensions;
        const priceFields=["inputPerMillionMinor","outputPerMillionMinor","imageUnitMinor","videoSecondMinor","renderSecondMinor"];
        const prices=priceFields.map(key=>rate[key]===undefined||rate[key]===null?null:Number(rate[key]));
        const validTimestamp=value=>typeof value==="string"&&Number.isFinite(Date.parse(value));
        if(!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(provider)||!model||model.length>160||
          !/^[A-Z]{3}$/.test(currency)||!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(version)||
          !["tokens_per_million","image","video_second","render_second","request","frame","minute","character_block","mixed"].includes(billingUnit)||
          !validTimestamp(effectiveFrom)||(effectiveTo&&(!validTimestamp(effectiveTo)||Date.parse(effectiveTo)<=Date.parse(effectiveFrom)))||
          !["provider_pricing","provider_contract","admin_verified"].includes(sourceType)||
          sourceReference.length<3||sourceReference.length>240||sourceUrl.length>1000||(sourceUrl&&!/^https:\/\//.test(sourceUrl))||
          (sourceFingerprint&&!/^[a-f0-9]{64}$/.test(sourceFingerprint))||
          !["source_linked","contract_attested","admin_attested"].includes(verificationStatus)||
          !dimensions||typeof dimensions!=="object"||Array.isArray(dimensions)||JSON.stringify(dimensions).length>12000||Object.entries(dimensions).some(([key,value])=>!key||key.length>80||typeof value!=="number"||!Number.isFinite(value)||value<0)||
          (sourceCheckedAt&&!validTimestamp(sourceCheckedAt))||(rate.supersedesId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(rate.supersedesId)))||
          prices.some(value=>value!==null&&(!Number.isFinite(value)||value<0))||
          !prices.some(value=>value!==null&&value>0)||
          (sourceType==="provider_pricing"&&(!sourceUrl||!validTimestamp(sourceCheckedAt)||verificationStatus!=="source_linked"))||
          (sourceType==="provider_contract"&&verificationStatus!=="contract_attested")||
          (sourceType==="admin_verified"&&verificationStatus!=="admin_attested"))
          return error(400,"MODEL_RATE_CARD_INVALID","Provide a valid versioned rate card, billing unit, effective period, non-negative price and matching source-evidence status.");
        const result=await rpc("add_ai_model_price_rate_card",{p_actor_id:ownerId,p_rate_card:{
          ...rate,provider,model,currency,rateCardVersion:version,billingUnit,effectiveFrom,effectiveTo,
          sourceType,sourceReference,sourceUrl,sourceCheckedAt,sourceFingerprint,verificationStatus,
          pricingDimensions:dimensions
        }});
        return response(201,{rateCard:result});
      }
      if(path==="/api/admin/finance/resource-rates"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const provider=String(body.provider||"").trim().toLowerCase();
        const resourceType=String(body.resourceType||"");
        const unit=String(body.unit||"");
        const currency=String(body.currency||"").trim().toUpperCase();
        const rate=Number(body.rateMinorPerUnit);
        const effectiveFrom=String(body.effectiveFrom||"");
        const effectiveTo=body.effectiveTo?String(body.effectiveTo):null;
        const sourceType=String(body.sourceType||"");
        const sourceReference=String(body.sourceReference||"").trim();
        if(provider.length<2||provider.length>80||!Number.isFinite(rate)||rate<0||
          !Number.isFinite(Date.parse(effectiveFrom))||(effectiveTo&&!Number.isFinite(Date.parse(effectiveTo)))||
          (effectiveTo&&Date.parse(effectiveTo)<=Date.parse(effectiveFrom))||
          !["provider_invoice","cloud_contract","admin_verified"].includes(sourceType)||
          sourceReference.length<3||sourceReference.length>240)
          return error(400,"RESOURCE_RATE_INVALID","Provide a valid provider, resource type, unit, currency, non-negative rate, effective period and evidence reference.");
        const result=await rpc("add_ai_resource_rate_card",{p_actor_id:ownerId,p_provider:provider,
          p_resource_type:resourceType,p_unit:unit,p_currency:currency,p_rate_minor_per_unit:rate,
          p_effective_from:effectiveFrom,p_effective_to:effectiveTo,p_source_type:sourceType,
          p_source_reference:sourceReference});
        return response(200,{rateCard:result});
      }
      if(path==="/api/admin/finance/resource-usage"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        let event;
        try{event=normalizeResourceUsage(body);}catch(err){return error(400,err.code||"RESOURCE_USAGE_INVALID",err.message||"Resource usage is invalid.");}
        const result=await rpc("record_ai_resource_usage_event",{
          p_actor_id:ownerId,p_occurred_at:event.occurredAt,p_owner_id:event.ownerId,
          p_project_id:event.projectId,p_job_id:event.jobId,p_operation_id:event.operationId,
          p_provider:event.provider,p_model:event.model,p_resource_type:event.resourceType,
          p_quantity:event.quantity,p_unit:event.unit,p_currency:event.currency,
          p_provider_cost_minor:event.providerCostMinor,p_idempotency_key:event.idempotencyKey,
          p_evidence:{source:"admin_api"}
        });
        return response(200,{resourceUsage:result});
      }
      if(path==="/api/admin/finance/resource-economics"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const periodMonth=String(query.periodMonth||body.periodMonth||new Date().toISOString().slice(0,7)+"-01");
        if(!/^\d{4}-\d{2}-01$/.test(periodMonth)||!Number.isFinite(Date.parse(periodMonth+"T00:00:00Z"))||
          new Date(periodMonth+"T00:00:00Z").toISOString().slice(0,10)!==periodMonth)
          return error(400,"RESOURCE_PERIOD_INVALID","Provide a valid first-of-month reporting date.");
        const result=await rpc("ai_resource_economics_overview",{p_actor_id:ownerId,p_period_month:periodMonth});
        return response(200,{economics:result||{byResource:[],byCustomer:[],topJobs:[],unpricedEvents:0,limitations:[]}});
      }
      if(path==="/api/admin/finance/model-performance"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        let event;
        try{event=normalizeModelPerformance(body);}catch(err){return error(400,err.code||"MODEL_PERFORMANCE_INVALID",err.message||"Model performance evidence is invalid.");}
        const result=await rpc("record_ai_model_performance_event",{p_actor_id:ownerId,
          p_usage_event_id:event.usageEventId,p_provider:event.provider,p_model:event.model,
          p_operation:event.operation,p_latency_ms:event.latencyMs,p_quality_score:event.qualityScore,
          p_quality_source:event.qualitySource,p_evaluation_version:event.evaluationVersion,
          p_idempotency_key:event.idempotencyKey});
        return response(200,{performance:result});
      }
      if(path==="/api/admin/finance/model-routing/shadow"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        let request;
        try{request=normalizeShadowRoutingRequest(body);}catch(err){return error(400,err.code||"MODEL_ROUTE_REQUEST_INVALID",err.message||"Shadow routing constraints are invalid.");}
        const result=await rpc("recommend_ai_model_route_shadow",{p_actor_id:ownerId,
          p_operation:request.operation,p_currency:request.currency,p_max_cost_minor:request.maxCostMinor,
          p_max_latency_ms:request.maxLatencyMs,p_min_quality_score:request.minQualityScore,
          p_idempotency_key:request.idempotencyKey});
        return response(200,{recommendation:result||{decisionStatus:"insufficient_evidence",decisionMode:"shadow_only",executionChanged:false,candidates:[]}});
      }
      if(path==="/api/admin/finance/workload-telemetry"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        let event;
        try{event=normalizeWorkloadTelemetry(body);}catch(err){return error(400,err.code||"WORKLOAD_TELEMETRY_INVALID",err.message||"Workload telemetry is invalid.");}
        const result=await rpc("record_ai_workload_telemetry_event",{
          p_actor_id:ownerId,p_occurred_at:event.occurredAt,p_owner_id:event.ownerId,
          p_project_id:event.projectId,p_job_id:event.jobId,p_operation_id:event.operationId,
          p_provider:event.provider,p_model:event.model,p_operation:event.operation,
          p_evidence_source:event.source,p_resolution_tier:event.resolutionTier,
          p_currency:event.currency,p_provider_cost_minor:event.providerCostMinor,
          p_dimensions:event.dimensions,p_resource_type:event.resourceType,
          p_resource_unit:event.resourceUnit,p_resource_quantity:event.resourceQuantity,
          p_evidence_reference:event.evidenceReference,p_idempotency_key:event.idempotencyKey
        });
        return response(201,{telemetry:result});
      }
      if(path==="/api/admin/finance/subscription-economics"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const month=String(query.periodMonth||new Date().toISOString().slice(0,7)+"-01");
        const monthDate=new Date(month+"T00:00:00Z");
        const limit=Number(query.limit||250);
        if(month.length!==10||month.slice(7)!=="-01"||!Number.isFinite(monthDate.getTime())||
          monthDate.toISOString().slice(0,10)!==month||!Number.isSafeInteger(limit)||limit<1||limit>1000)
          return error(400,"SUBSCRIPTION_ECONOMICS_FILTER_INVALID","Provide a valid month start date and a limit from 1 to 1000.");
        const result=await rpc("subscription_customer_economics_report",{p_actor_id:ownerId,p_period_month:month,p_limit:limit});
        return response(200,{economics:result||{periodMonth:month,customers:[],byCurrency:[],limitations:[]}});
      }
      if(path==="/api/admin/finance/workload-telemetry"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const month=String(query.periodMonth||new Date().toISOString().slice(0,7)+"-01");
        const monthDate=new Date(month+"T00:00:00Z");
        const limit=Number(query.limit||100);
        if(month.length!==10||month.slice(7)!=="-01"||!Number.isFinite(monthDate.getTime())||
          monthDate.toISOString().slice(0,10)!==month||!Number.isSafeInteger(limit)||limit<1||limit>500)
          return error(400,"WORKLOAD_TELEMETRY_FILTER_INVALID","Provide a month start date and a limit from 1 to 500.");
        const result=await rpc("ai_workload_telemetry_overview",{p_actor_id:ownerId,p_period_month:month,p_limit:limit});
        return response(200,{telemetry:result||{periodMonth:month,totals:{},byProviderModelOperation:[]}});
      }
      if(path==="/api/admin/finance/ai-usage"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        let event;
        try{event=normalizeGenAiUsage(body);}catch(err){return error(400,err.code||"AI_USAGE_EVENT_INVALID",err.message||"AI usage event is invalid.");}
        const {occurredAt,provider,requestedModel,responseModel,operation,status,ownerId:attributedOwner,
          currency,providerCostMinor,inputTokens,outputTokens,imageCount,videoSeconds,renderSeconds,
          operationId,idempotencyKey}=event;
        if(!Number.isFinite(Date.parse(occurredAt))||!operationId||operationId.length>180||
          (attributedOwner&&!UUID.test(String(attributedOwner)))||
          (body.projectId&&!UUID.test(String(body.projectId)))||(body.jobId&&!UUID.test(String(body.jobId)))||
          (providerCostMinor!==null&&!currency)||idempotencyKey.length<8||idempotencyKey.length>180)
          return error(400,"AI_USAGE_EVENT_INVALID","Usage requires a valid timestamp, operation/request identifier, trusted owner/project/job IDs and idempotency key. Provider-reported cost requires currency.");
        const result=await rpc("record_ai_usage_cost_event",{
          p_actor_id:ownerId,p_occurred_at:occurredAt,p_owner_id:attributedOwner,
          p_project_id:body.projectId||null,p_job_id:body.jobId||null,
          p_operation_id:operationId,p_provider:provider,p_requested_model:requestedModel,
          p_response_model:responseModel,p_operation:operation,p_status:status,
          p_input_tokens:inputTokens,p_output_tokens:outputTokens,p_image_count:imageCount,
          p_video_seconds:videoSeconds,p_render_seconds:renderSeconds,p_currency:currency,
          p_provider_cost_minor:providerCostMinor,p_invoice_line_reference:event.invoiceLineReference,
          p_trace_id:event.traceId,p_idempotency_key:idempotencyKey
        });
        return response(200,{usage:result});
      }
      if(path==="/api/admin/finance/ai-invoices/import"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const provider=String(body.provider||"").trim().toLowerCase();
        const invoiceReference=String(body.invoiceReference||"").trim();
        const currency=String(body.currency||"").trim().toUpperCase();
        const periodStart=String(body.periodStart||""),periodEnd=String(body.periodEnd||"");
        const totalMinor=Number(body.totalMinor);
        const validDay=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+"T00:00:00Z"))&&new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
        if(!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(provider)||!invoiceReference||invoiceReference.length>180||
          !/^[A-Z]{3}$/.test(currency)||!validDay(periodStart)||!validDay(periodEnd)||periodEnd<periodStart||
          !Number.isSafeInteger(totalMinor)||totalMinor<0)
          return error(400,"AI_INVOICE_HEADER_INVALID","Provide a provider, invoice reference, ISO date range, currency and non-negative minor-unit invoice total.");
        let lines;
        try{
          lines=typeof body.csv==="string"?parseProviderInvoiceCsv(body.csv,{provider,currency}):body.lines;
          if(!Array.isArray(lines)||lines.length<1||lines.length>5000)throw Object.assign(new Error("Invoice requires 1 to 5,000 line items."),{code:"AI_INVOICE_LINES_INVALID"});
          lines=lines.map((line,index)=>{
            const amount=Number(line.amountMinor);
            const usagePeriod=String(line.usagePeriod||"");
            const lineReference=String(line.lineReference||line.providerLineReference||"").trim();
            const model=String(line.model||"").trim();
            const operation=String(line.operation||"");
            const usageQuantity=line.usageQuantity==null?null:Number(line.usageQuantity);
            if(!lineReference||lineReference.length>180||!model||model.length>160||
              !["text","image","video","render","upscale","audio","embedding","other"].includes(operation)||
              !Number.isSafeInteger(amount)||!/^\d{4}-\d{2}-\d{2}$/.test(usagePeriod)||
              !Number.isFinite(Date.parse(usagePeriod+"T00:00:00Z"))||new Date(usagePeriod+"T00:00:00Z").toISOString().slice(0,10)!==usagePeriod||
              (usageQuantity!==null&&(!Number.isFinite(usageQuantity)||usageQuantity<0)))
              throw Object.assign(new Error("Invoice line "+(index+1)+" is invalid."),{code:"AI_INVOICE_LINE_INVALID"});
            return {provider,currency,lineReference,model,operation,amountMinor:amount,usagePeriod,
              usageQuantity,usageUnit:String(line.usageUnit||"")};
          });
        }catch(err){return error(400,err.code||"AI_INVOICE_CSV_INVALID",err.message||"Invoice lines are invalid.");}
        const fingerprint=hashText(JSON.stringify({provider,invoiceReference,currency,periodStart,periodEnd,totalMinor,lines}));
        const result=await rpc("import_ai_provider_invoice",{p_actor_id:ownerId,p_provider:provider,
          p_invoice_reference:invoiceReference,p_currency:currency,p_period_start:periodStart,p_period_end:periodEnd,
          p_total_minor:totalMinor,p_source_fingerprint:fingerprint,p_lines:lines});
        return response(200,{invoice:result});
      }
      if(path==="/api/admin/finance/ai-invoices/reconcile"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const importId=String(body.importId||"");
        if(!UUID.test(importId))return error(400,"AI_INVOICE_IMPORT_ID_INVALID","Provide a valid invoice import ID.");
        const result=await rpc("reconcile_ai_provider_invoice",{p_actor_id:ownerId,p_import_id:importId});
        return response(200,{reconciliation:result});
      }
      if(path==="/api/admin/finance/ai-invoices/post-to-ledger"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const importId=String(body.importId||"");
        if(!UUID.test(importId))return error(400,"AI_INVOICE_IMPORT_ID_INVALID","Provide a valid invoice import ID.");
        const result=await rpc("post_verified_ai_invoice_to_service_cost_ledger",{p_actor_id:ownerId,p_import_id:importId});
        return response(200,{posting:result});
      }
      if(path==="/api/admin/finance/ai-cost-anomalies"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const periodMonth=String(body.periodMonth||new Date().toISOString().slice(0,7)+"-01");
        if(!/^\d{4}-\d{2}-01$/.test(periodMonth)||!Number.isFinite(Date.parse(periodMonth+"T00:00:00Z"))||new Date(periodMonth+"T00:00:00Z").toISOString().slice(0,10)!==periodMonth)
          return error(400,"AI_COST_PERIOD_INVALID","Provide a valid reporting month.");
        const result=await rpc("ai_cost_anomaly_report",{p_actor_id:ownerId,p_period_month:periodMonth,
          p_min_cost_minor:100,p_spike_multiplier:2,p_failed_ratio:0.25});
        return response(200,{anomalies:result||{spendAnomalies:[],unpricedUsage:[],invoiceExceptions:[],limitations:[]}});
      }
      if(path==="/api/admin/finance/margin-policies"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const scopeType=String(body.scopeType||"");
        const attributedOwner=body.ownerId==null||body.ownerId===""?null:String(body.ownerId);
        const currency=String(body.currency||"").trim().toUpperCase();
        const margin=body.minGrossMarginPct==null||body.minGrossMarginPct===""?null:Number(body.minGrossMarginPct);
        const contribution=body.minContributionMinor==null||body.minContributionMinor===""?null:Number(body.minContributionMinor);
        const effectiveFrom=String(body.effectiveFrom||"");
        const effectiveTo=body.effectiveTo==null||body.effectiveTo===""?null:String(body.effectiveTo);
        const idempotency=String(body.idempotencyKey||"").trim();
        const validMonthStart=value=>/^\d{4}-\d{2}-01$/.test(value)&&Number.isFinite(Date.parse(value+"T00:00:00Z"))&&new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
        if(!["global","customer"].includes(scopeType)||(scopeType==="global"&&attributedOwner!==null)||
          (scopeType==="customer"&&!UUID.test(attributedOwner||""))||!/^[A-Z]{3}$/.test(currency)||
          (margin===null&&contribution===null)||(margin!==null&&(!Number.isFinite(margin)||margin<0||margin>100))||
          (contribution!==null&&(!Number.isSafeInteger(contribution)||contribution<0))||
          !validMonthStart(effectiveFrom)||(effectiveTo!==null&&(!validMonthStart(effectiveTo)||effectiveTo<=effectiveFrom))||
          idempotency.length<8||idempotency.length>160)
          return error(400,"FINANCIAL_MARGIN_POLICY_INVALID","Provide a valid scope, currency, at least one non-negative margin threshold, effective dates and idempotency key.");
        const result=await rpc("add_financial_margin_policy",{p_actor_id:ownerId,p_scope_type:scopeType,
          p_owner_id:attributedOwner,p_currency:currency,p_min_gross_margin_pct:margin,
          p_min_contribution_minor:contribution,p_effective_from:effectiveFrom,
          p_effective_to:effectiveTo,p_idempotency_key:idempotency});
        return response(200,{policy:result});
      }
      if(path==="/api/admin/finance/margin-alerts/evaluate"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const result=await rpc("evaluate_financial_margin_alerts",{p_actor_id:ownerId});
        return response(200,{evaluation:result||{evaluatedCustomers:0,policiesApplied:0,alertsCreated:0,alerts:[]}});
      }
      if(path==="/api/admin/finance/margin-alerts"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const limit=query.limit==null?50:Number(query.limit);
        if(!Number.isSafeInteger(limit)||limit<1||limit>200)
          return error(400,"FINANCIAL_ALERT_LIMIT_INVALID","Alert limit must be an integer between 1 and 200.");
        const result=await rpc("list_financial_margin_alerts",{p_actor_id:ownerId,p_limit:limit});
        return response(200,{marginAlerts:result||{alerts:[],count:0}});
      }
      if(path==="/api/admin/finance/profitability"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const result=await rpc("financial_profitability_overview",{p_actor_id:ownerId});
        return response(200,{profitability:result||{byCurrency:[],customers:[],sharedCosts:[],limitations:[]}});
      }
      if(path==="/api/admin/finance/scenario-baseline"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const month=String(query.periodMonth||new Date().toISOString().slice(0,7)+"-01");
        const monthDate=new Date(month+"T00:00:00Z");
        if(month.length!==10||month.slice(7)!=="-01"||Number.isNaN(monthDate.getTime())||monthDate.toISOString().slice(0,10)!==month)
          return error(400,"FINANCIAL_SCENARIO_PERIOD_INVALID","Provide a valid first day of a reporting month.");
        const baseline=await rpc("financial_scenario_baseline",{p_actor_id:ownerId,p_period_month:month});
        return response(200,{baseline:baseline||{periodMonth:month,byCurrency:[],limitations:[]}});
      }
      if(path==="/api/admin/finance/scenarios"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const limit=query.limit==null?25:Number(query.limit);
        if(!Number.isSafeInteger(limit)||limit<1||limit>100)return error(400,"FINANCIAL_SCENARIO_LIMIT_INVALID","Scenario snapshot limit must be an integer between 1 and 100.");
        const result=await rpc("list_financial_scenario_snapshots",{p_actor_id:ownerId,p_limit:limit});
        return response(200,{...result,source:"immutable saved scenario snapshots"});
      }
      if(path==="/api/admin/finance/scenarios"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const scenarioName=String(body.scenarioName||"").trim();
        const idempotencyKey=String(body.idempotencyKey||"");
        const rawInput=body.input;
        const evidenceReferences=body.evidenceReferences??[];
        if(!scenarioName||scenarioName.length>100||!/^[A-Za-z0-9:_-]{8,128}$/.test(idempotencyKey)||
          !Array.isArray(evidenceReferences)||evidenceReferences.length>50||
          evidenceReferences.some(item=>typeof item!=="string"||item.trim().length<1||item.length>500)){
          return error(400,"FINANCIAL_SCENARIO_PAYLOAD_INVALID","Provide a scenario name, a unique 8–128 character idempotency key and up to 50 evidence references.");
        }
        try{
          const result=calculateFinancialScenarioIntelligence(rawInput);
          const inputHash=createHash("sha256").update(JSON.stringify({scenarioName,input:rawInput,evidenceReferences})).digest("hex");
          const stableResult={...result};delete stableResult.generatedAt;
          const resultHash=createHash("sha256").update(JSON.stringify(stableResult)).digest("hex");
          const saved=await rpc("create_financial_scenario_snapshot",{
            p_actor_id:ownerId,p_scenario_name:scenarioName,p_period_month:result.periodMonth,
            p_currency:result.currency,p_model_version:result.model,
            p_input_payload:rawInput,p_result_payload:result,p_evidence_references:evidenceReferences,
            p_input_sha256:inputHash,p_result_sha256:resultHash,p_idempotency_key:idempotencyKey
          });
          const snapshot=saved?.snapshot||null;
          await rpc("write_financial_admin_audit",{
            p_actor_id:ownerId,p_action:"finance.scenario.snapshot.create",
            p_resource_type:"financial_scenario_snapshot",p_resource_id:String(snapshot?.id||""),
            p_reason:"Administrator saved an immutable financial scenario calculation",
            p_request_id:randomUUID(),p_metadata:{scenarioName,currency:result.currency,periodMonth:result.periodMonth,model:result.model,idempotentReplay:Boolean(saved?.idempotentReplay)}
          });
          return response(saved?.idempotentReplay?200:201,{...saved,source:"server-calculated immutable scenario snapshot"});
        }catch(err){
          if(err instanceof TypeError||err instanceof RangeError)return error(400,"FINANCIAL_SCENARIO_INPUT_INVALID",String(err.message||"Scenario inputs are invalid."));
          throw err;
        }
      }
      if(path==="/api/admin/finance/customer-lifetime-acquisition-economics"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const month=String(query.periodMonth||new Date().toISOString().slice(0,7)+"-01");
        const monthDate=new Date(month+"T00:00:00Z");
        const discountRateBps=Number(query.discountRateBps??100);
        const horizonMonths=Number(query.horizonMonths??36);
        if(month.length!==10||month.slice(7)!=="-01"||!Number.isFinite(monthDate.getTime())||
          monthDate.toISOString().slice(0,10)!==month||!Number.isSafeInteger(discountRateBps)||
          discountRateBps<0||discountRateBps>5000||!Number.isSafeInteger(horizonMonths)||
          horizonMonths<1||horizonMonths>60)
          return error(400,"CUSTOMER_LIFETIME_FILTER_INVALID","Provide a valid month start, discount rate from 0 to 5000 basis points and projection horizon from 1 to 60 months.");
        const result=await rpc("customer_lifetime_acquisition_economics_report",{
          p_actor_id:ownerId,p_period_month:month,p_discount_rate_bps:discountRateBps,p_horizon_months:horizonMonths
        });
        return response(200,{economics:result||{periodMonth:month,byCurrency:[],channels:[],campaigns:[],customers:[],limitations:[]}});
      }
      if(path==="/api/admin/finance/profitability-trends"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const months=query.months==null?12:Number(query.months);
        if(!Number.isSafeInteger(months)||months<3||months>36)
          return error(400,"FINANCIAL_TREND_RANGE_INVALID","Trend period must be an integer between 3 and 36 months.");
        const result=await rpc("financial_profitability_trend_report",{p_actor_id:ownerId,p_months:months});
        return response(200,{trends:result||{periods:[],limitations:[]}});
      }
      if(path==="/api/admin/finance/close"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const subjectOwnerId=String(query.ownerId||ownerId);
        if(!UUID.test(subjectOwnerId))return error(400,"FINANCIAL_CLOSE_OWNER_INVALID","ownerId must be a verified account UUID.");
        const overview=await rpc("get_financial_close_overview",{p_owner_id:subjectOwnerId});
        return response(200,{close:overview||{periods:[],tasks:[],approvals:[]}});
      }
      if(path==="/api/admin/finance/close/commands"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        try{
          const command=String(body.command||"");
          const eventTypes={
            create_period:"close_period.created",assign_task:"close_task.assigned",
            complete_task:"close_task.completed",waive_task:"close_task.waived",
            submit_for_approval:"close_period.submitted",record_approval:"close_approval.recorded",
            reassign_approval:"close_approval.assigned",lock_period:"close_period.locked",reopen_period:"close_period.reopened",
            record_reconciliation:"reconciliation.recorded",review_reconciliation:"reconciliation.reviewed"
          };
          const eventType=eventTypes[command];
          const payload=body.payload&&typeof body.payload==="object"&&!Array.isArray(body.payload)?body.payload:null;
          const auditKey=String(body.idempotencyKey||idempotencyKey||"");
          const subjectOwnerId=String(body.subjectOwnerId||ownerId);
          if(!eventType)return error(400,"FINANCIAL_CLOSE_COMMAND_INVALID","Unsupported financial close command.");
          if(!payload)return error(400,"FINANCIAL_CLOSE_PAYLOAD_INVALID","A JSON object payload is required.");
          if(!UUID.test(subjectOwnerId))return error(400,"FINANCIAL_CLOSE_OWNER_INVALID","subjectOwnerId must be a verified account UUID.");
          if(!auditKey)return error(400,"FINANCIAL_AUDIT_IDEMPOTENCY_INVALID","An idempotency key is required.");
          const head=await rpc("get_financial_audit_head",{p_owner_id:subjectOwnerId});
          const event=createFinancialAuditEvent({
            ownerId:subjectOwnerId,actorId:ownerId,eventType,payload,
            idempotencyKey:auditKey,occurredAt:new Date().toISOString(),
            sequence:Number(head?.sequence||0)+1,previousHash:head?.headHash||"0".repeat(64)
          });
          const envelope=Object.fromEntries(Object.entries(event).filter(([key])=>!["eventHash","canonicalEvent"].includes(key)));
          const reconciliationCommand=command==="record_reconciliation"||command==="review_reconciliation";
          const result=await rpc(reconciliationCommand?"execute_financial_reconciliation_command":"execute_financial_close_command",{
            p_owner_id:subjectOwnerId,p_actor_id:ownerId,p_command:command,p_payload:payload,
            p_event_envelope:envelope,p_canonical_event:event.canonicalEvent,p_event_hash:event.eventHash
          });
          return response(result?.duplicate?200:201,{duplicate:Boolean(result?.duplicate),command,result});
        }catch(err){
          const status=err.status||(String(err.code||"").startsWith("FINANCIAL_")?400:409);
          return error(status,err.code||"FINANCIAL_CLOSE_COMMAND_FAILED",err.message||"Financial close command could not be completed.");
        }
      }
      if(path==="/api/admin/finance/audit/events"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        try{
          const auditKey=String(body.idempotencyKey||idempotencyKey||"");
          const subjectOwnerId=String(body.subjectOwnerId||ownerId);
          if(!UUID.test(subjectOwnerId))return error(400,"FINANCIAL_AUDIT_OWNER_INVALID","subjectOwnerId must be a verified account UUID.");
          if(!auditKey)return error(400,"FINANCIAL_AUDIT_IDEMPOTENCY_INVALID","An idempotency key is required.");
          if(!FINANCIAL_AUDIT_EVENT_TYPES.includes(body.eventType))return error(400,"FINANCIAL_AUDIT_EVENT_TYPE_INVALID","Unsupported financial audit event type.");
          const existing=await dbRequest("financial_audit_events?select=event_id,sequence_number,event_hash,idempotency_key,event_envelope&owner_id=eq."+encodeURIComponent(subjectOwnerId)+"&idempotency_key=eq."+encodeURIComponent(auditKey)+"&limit=1");
          if(Array.isArray(existing.data)&&existing.data.length){
            const prior=existing.data[0];
            if(prior.event_envelope?.eventType!==body.eventType||canonicalFinancialAuditJson(prior.event_envelope?.payload??{})!==canonicalFinancialAuditJson(body.payload??{}))
              return error(409,"FINANCIAL_AUDIT_IDEMPOTENCY_CONFLICT","This idempotency key was already used for a different audit event.");
            return response(200,{duplicate:true,event:{eventId:prior.event_id,sequence:Number(prior.sequence_number),eventHash:prior.event_hash}});
          }
          const head=await rpc("get_financial_audit_head",{p_owner_id:subjectOwnerId});
          const event=createFinancialAuditEvent({
            ownerId:subjectOwnerId,actorId:ownerId,eventType:body.eventType,payload:body.payload||{},
            idempotencyKey:auditKey,occurredAt:body.occurredAt||new Date().toISOString(),
            sequence:Number(head?.sequence||0)+1,previousHash:head?.headHash||"0".repeat(64)
          });
          const envelope=Object.fromEntries(Object.entries(event).filter(([key])=>!["eventHash","canonicalEvent"].includes(key)));
          const result=await rpc("append_financial_audit_event",{
            p_owner_id:subjectOwnerId,p_actor_id:ownerId,p_idempotency_key:auditKey,
            p_event_envelope:envelope,p_canonical_event:event.canonicalEvent,p_event_hash:event.eventHash
          });
          return response(result?.duplicate?200:201,{duplicate:Boolean(result?.duplicate),event:{eventId:result?.eventId||event.eventId,sequence:Number(result?.sequence||event.sequence),eventType:event.eventType,eventHash:result?.eventHash||event.eventHash,previousHash:event.previousHash}});
        }catch(err){
          const status=err.status||(String(err.code||"").startsWith("FINANCIAL_AUDIT_")?400:409);
          return error(status,err.code||"FINANCIAL_AUDIT_APPEND_FAILED",err.message||"Financial audit event could not be appended.");
        }
      }
      if(path==="/api/admin/finance/audit/events"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const subjectOwnerId=String(query.ownerId||ownerId);if(!UUID.test(subjectOwnerId))return error(400,"FINANCIAL_AUDIT_OWNER_INVALID","ownerId must be a verified account UUID.");
        const after=Number(query.afterSequence||0),limit=Math.min(500,Math.max(1,Number(query.limit)||100));
        if(!Number.isSafeInteger(after)||after<0)return error(400,"FINANCIAL_AUDIT_CURSOR_INVALID","afterSequence must be a non-negative integer.");
        const rows=await dbRequest("financial_audit_events?select=event_envelope,event_hash,sequence_number,previous_hash,idempotency_key&owner_id=eq."+encodeURIComponent(subjectOwnerId)+"&sequence_number=gt."+after+"&order=sequence_number.asc&limit="+limit);
        const head=await rpc("get_financial_audit_head",{p_owner_id:subjectOwnerId});
        return response(200,{events:rows.data||[],head:head||{sequence:0,headHash:"0".repeat(64)},pagination:{afterSequence:after,limit,returned:(rows.data||[]).length}});
      }
      if(path==="/api/admin/finance/audit/export"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const subjectOwnerId=String(query.ownerId||ownerId);if(!UUID.test(subjectOwnerId))return error(400,"FINANCIAL_AUDIT_OWNER_INVALID","ownerId must be a verified account UUID.");
        const head=await rpc("get_financial_audit_head",{p_owner_id:subjectOwnerId});
        const rows=[];let offset=0;
        while(offset<5000){
          const page=await dbRequest("financial_audit_events?select=event_envelope,event_hash,sequence_number,previous_hash,idempotency_key&owner_id=eq."+encodeURIComponent(subjectOwnerId)+"&order=sequence_number.asc&offset="+offset+"&limit=500");
          const batch=Array.isArray(page.data)?page.data:[];
          rows.push(...batch);offset+=batch.length;
          if(batch.length<500)break;
        }
        const bundle=exportFinancialAuditBundle({
          ownerId:subjectOwnerId,events:rows,head:head||{sequence:0,headHash:"0".repeat(64)},
          signingPrivateKey:financialAuditSigningPrivateKey
        });
        return response(200,{bundle});
      }
      if(path==="/api/admin/finance/audit/verify"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const subjectOwnerId=String(query.ownerId||ownerId);if(!UUID.test(subjectOwnerId))return error(400,"FINANCIAL_AUDIT_OWNER_INVALID","ownerId must be a verified account UUID.");
        const head=await rpc("get_financial_audit_head",{p_owner_id:subjectOwnerId});
        const records=[];let offset=0;
        while(offset<5000){
          const page=await dbRequest("financial_audit_events?select=event_envelope,event_hash,sequence_number,previous_hash,idempotency_key&owner_id=eq."+encodeURIComponent(subjectOwnerId)+"&order=sequence_number.asc&offset="+offset+"&limit=500");
          const batch=Array.isArray(page.data)?page.data:[];
          records.push(...batch);offset+=batch.length;
          if(batch.length<500)break;
        }
        const result=verifyFinancialAuditChain(records,{ownerId:subjectOwnerId,expectedHead:head?.headHash||"0".repeat(64)});
        const complete=Number(head?.sequence||0)===records.length;
        return response(200,{verification:{...result,complete,valid:result.valid&&complete,storedHead:head||{sequence:0,headHash:"0".repeat(64)},limitations:[...result.limitations,...(!complete?["The full chain exceeds the 5,000-record verification limit or could not be fully retrieved; this response is not a complete verification."]:[])]}});
      }
      if(path==="/api/admin/finance/close/readiness"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        try{
          const assessment=assessFinancialCloseReadiness({
            period:body.period,asOf:body.asOf,evidence:body.evidence,
            tasks:body.tasks,reconciliations:body.reconciliations
          });
          return response(200,{assessment});
        }catch(err){
          return error(400,err.code||"FINANCIAL_CLOSE_INPUT_INVALID",err.message||"Financial close readiness could not be assessed.");
        }
      }
      if(path==="/api/admin/finance/reconciliation-preview"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const hasInvoices=Array.isArray(body.invoiceHeaders);
        const hasInvoiceUsage=Array.isArray(body.usageEvents)||(Array.isArray(body.invoiceLines)&&!hasInvoices);
        const hasSettlement=Array.isArray(body.statementRows)||Array.isArray(body.payments);
        if(!hasInvoices&&!hasInvoiceUsage&&!hasSettlement)
          return error(400,"FINANCIAL_RECON_INPUT_REQUIRED","Provide invoice headers, invoice lines with usage events, or payment statement rows with internal payment records.");
        try{
          const reconciliation={generatedAt:new Date().toISOString(),mode:"read_only_preview",automaticPosting:false};
          if(hasInvoices)reconciliation.duplicateInvoices=detectDuplicateInvoices({invoices:body.invoiceHeaders});
          if(hasInvoices&&Array.isArray(body.invoiceLines))reconciliation.invoiceHeaderTotals=reconcileInvoiceTotals({invoiceHeaders:body.invoiceHeaders,invoiceLines:body.invoiceLines});
          if(hasInvoiceUsage){
            if(!Array.isArray(body.invoiceLines)||!Array.isArray(body.usageEvents))
              return error(400,"FINANCIAL_RECON_INPUT_INCOMPLETE","Invoice-line reconciliation requires both invoiceLines and usageEvents arrays.");
            reconciliation.providerInvoiceUsage=reconcileProviderInvoiceLines({invoiceLines:body.invoiceLines,usageEvents:body.usageEvents});
          }
          if(hasSettlement){
            if(!Array.isArray(body.statementRows)||!Array.isArray(body.payments))
              return error(400,"FINANCIAL_RECON_INPUT_INCOMPLETE","Payment settlement reconciliation requires both statementRows and payments arrays.");
            reconciliation.paymentSettlement=reconcilePaymentSettlement({statementRows:body.statementRows,payments:body.payments});
          }
          return response(200,{reconciliation});
        }catch(err){
          return error(400,err.code||"FINANCIAL_RECON_INPUT_INVALID",err.message||"Financial reconciliation preview could not be calculated.");
        }
      }
      if(path==="/api/admin/finance/workload-variance"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        try{
          const variance=analyzeWorkloadCostVariance({
            estimate:body.estimate,actuals:body.actuals,
            acceptedOutputs:body.acceptedOutputs,rejectedOutputs:body.rejectedOutputs
          });
          return response(200,{variance});
        }catch(err){
          return error(400,err.code||"WORKLOAD_VARIANCE_INVALID",err.message||"Workload cost variance could not be calculated.");
        }
      }
      if(path==="/api/admin/finance/workload-estimates"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        try{
          const estimate=estimateWorkloadEconomics({
            rateCard:body.rateCard,workload:body.workload,pricing:body.pricing,
            uncertaintyBps:body.uncertaintyBps
          });
          return response(200,{estimate});
        }catch(err){
          return error(400,err.code||"WORKLOAD_ESTIMATE_INVALID",err.message||"Workload estimate could not be calculated.");
        }
      }
      if(path==="/api/admin/finance/model-economics-comparison"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        try{
          const comparison=compareWorkloadCandidates({
            rateCards:body.rateCards,workload:body.workload,pricing:body.pricing,
            uncertaintyBps:body.uncertaintyBps,limits:body.limits
          });
          return response(200,{comparison});
        }catch(err){
          return error(400,err.code||"MODEL_ECONOMICS_COMPARISON_INVALID",err.message||"Model comparison could not be calculated.");
        }
      }
      if(path==="/api/admin/finance/shared-cost-allocations"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const months=query.months==null?12:Number(query.months);
        if(!Number.isSafeInteger(months)||months<1||months>36)
          return error(400,"SHARED_ALLOCATION_RANGE_INVALID","Allocation report period must be an integer between 1 and 36 months.");
        const result=await rpc("financial_shared_cost_allocation_overview",{p_actor_id:ownerId,p_months:months});
        return response(200,{allocations:result||{policies:[],batches:[],customers:[],limitations:[]}});
      }
      if(path==="/api/admin/finance/shared-cost-allocation-policies"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const category=String(body.costCategory||"");
        const driverType=String(body.driverType||"");
        const currency=String(body.currency||"").trim().toUpperCase();
        const effectiveFrom=String(body.effectiveFrom||"");
        const effectiveTo=body.effectiveTo==null||body.effectiveTo===""?null:String(body.effectiveTo);
        const minimumRecipients=body.minimumRecipients==null?2:Number(body.minimumRecipients);
        const idempotencyKey=String(body.idempotencyKey||"").trim();
        const drivers={ai_inference:["inference_tokens"],image_generation:["image_count"],video_generation:["video_seconds"],render_compute:["ffmpeg_seconds","gpu_seconds","cpu_seconds"],storage:["storage_gb_days"],egress:["egress_gb"]};
        const validMonth=(value)=>/^\d{4}-\d{2}-01$/.test(value)&&Number.isFinite(Date.parse(value+"T00:00:00Z"))&&new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
        if(!Object.prototype.hasOwnProperty.call(drivers,category)||!drivers[category].includes(driverType)||!/^[A-Z]{3}$/.test(currency)||!validMonth(effectiveFrom)||
          (effectiveTo!==null&&(!validMonth(effectiveTo)||effectiveTo<=effectiveFrom))||
          !Number.isSafeInteger(minimumRecipients)||minimumRecipients<2||minimumRecipients>100000||
          idempotencyKey.length<8||idempotencyKey.length>160)
          return error(400,"SHARED_ALLOCATION_POLICY_INVALID","Choose a supported measured driver for the cost category, valid currency and month range, at least two recipients, and a valid idempotency key.");
        const result=await rpc("add_financial_shared_cost_allocation_policy",{
          p_actor_id:ownerId,p_cost_category:category,p_driver_type:driverType,p_currency:currency,
          p_effective_from:effectiveFrom,p_effective_to:effectiveTo,
          p_minimum_recipients:minimumRecipients,p_idempotency_key:idempotencyKey
        });
        return response(201,{policy:result});
      }
      if(path==="/api/admin/finance/shared-cost-allocations/run"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const periodMonth=String(body.periodMonth||"");
        const currency=String(body.currency||"").trim().toUpperCase();
        const category=String(body.costCategory||"");
        const categories=["ai_inference","image_generation","video_generation","render_compute","storage","egress"];
        if(!/^\d{4}-\d{2}-01$/.test(periodMonth)||!Number.isFinite(Date.parse(periodMonth+"T00:00:00Z"))||
          new Date(periodMonth+"T00:00:00Z").toISOString().slice(0,10)!==periodMonth||
          !/^[A-Z]{3}$/.test(currency)||!categories.includes(category))
          return error(400,"SHARED_ALLOCATION_RUN_INVALID","Provide a valid month, ISO currency and supported shared-cost category.");
        const result=await rpc("run_financial_shared_cost_allocation",{
          p_actor_id:ownerId,p_period_month:periodMonth,p_currency:currency,p_cost_category:category
        });
        return response(200,{run:result});
      }
      if(path==="/api/admin/finance/service-cost"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const periodMonth=String(body.periodMonth||"");
        const attributedOwnerId=body.ownerId==null||body.ownerId===""?null:String(body.ownerId);
        const category=String(body.category||"");
        const sourceType=String(body.sourceType||"");
        const currency=String(body.currency||"").trim().toUpperCase();
        const amountMinor=Number(body.amountMinor);
        const sourceReference=String(body.sourceReference||"").trim();
        const description=String(body.description||"").trim();
        const idempotencyKey=String(body.idempotencyKey||"").trim();
        const reversesEventId=body.reversesEventId==null||body.reversesEventId===""?null:String(body.reversesEventId);
        const categories=["ai_inference","video_generation","image_generation","render_compute","storage","egress","payment_processing","support","other"];
        const sources=["provider_invoice","provider_usage_export","cloud_invoice","payment_processor","manual_receipt","other"];
        if(!/^\d{4}-\d{2}-01$/.test(periodMonth)||!Number.isFinite(Date.parse(periodMonth+"T00:00:00Z"))||new Date(periodMonth+"T00:00:00Z").toISOString().slice(0,10)!==periodMonth||(attributedOwnerId&&!UUID.test(attributedOwnerId))||
          !categories.includes(category)||!sources.includes(sourceType)||!/^[A-Z]{3}$/.test(currency)||
          !Number.isSafeInteger(amountMinor)||amountMinor===0||(amountMinor<0&&!UUID.test(reversesEventId||""))||
          (amountMinor>0&&reversesEventId!==null)||sourceReference.length>160||
          description.length<3||description.length>500||idempotencyKey.length<8||idempotencyKey.length>160)
          return error(400,"FINANCIAL_SERVICE_COST_INVALID","Provide a valid month, cost category, source, currency, non-zero minor-unit amount, description and idempotency key. Negative reversals must reference an original cost.");
        const result=await rpc("record_financial_service_cost",{
          p_actor_id:ownerId,p_period_month:periodMonth,p_owner_id:attributedOwnerId,
          p_cost_category:category,p_source_type:sourceType,p_currency:currency,
          p_amount_minor:amountMinor,p_source_reference:sourceReference,p_description:description,
          p_idempotency_key:idempotencyKey,p_reverses_event_id:reversesEventId
        });
        return response(200,{cost:result});
      }
      if(path==="/api/admin/finance/revenue-retention/snapshot"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const result=await rpc("capture_subscription_revenue_snapshot",{p_actor_id:ownerId});
        return response(200,{snapshot:result});
      }
      if(path==="/api/admin/finance/acquisition-spend"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const periodMonth=String(body.periodMonth||"");
        const channel=String(body.channel||"").trim().toLowerCase();
        const campaign=String(body.campaign||"").trim();
        const currency=String(body.currency||"").trim().toUpperCase();
        const amountMinor=Number(body.amountMinor);
        const description=String(body.description||"").trim();
        const idempotencyKey=String(body.idempotencyKey||"").trim();
        if(!/^\d{4}-\d{2}-01$/.test(periodMonth)||!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(channel)||
          campaign.length>120||!/^[A-Z]{3}$/.test(currency)||!Number.isSafeInteger(amountMinor)||amountMinor<=0||
          description.length<3||description.length>500||idempotencyKey.length<8||idempotencyKey.length>160)
          return error(400,"ACQUISITION_SPEND_INVALID","Provide a month, channel, currency, positive integer minor-unit amount, description and idempotency key.");
        const result=await rpc("record_customer_acquisition_spend",{
          p_actor_id:ownerId,p_period_month:periodMonth,p_channel:channel,p_campaign:campaign,
          p_currency:currency,p_amount_minor:amountMinor,p_description:description,p_idempotency_key:idempotencyKey
        });
        return response(200,{spend:result});
      }
      if(path==="/api/admin/finance/acquisition-attribution"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCIAL_ADMIN_REQUIRED","A finance administrator role is required.");
        const attributedOwnerId=String(body.ownerId||"");
        const channel=String(body.channel||"").trim().toLowerCase();
        const campaign=String(body.campaign||"").trim();
        const currency=String(body.currency||"").trim().toUpperCase();
        const sourceType=String(body.sourceType||"");
        const acquiredAt=String(body.acquiredAt||"");
        if(!UUID.test(attributedOwnerId)||!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(channel)||
          campaign.length>120||!/^[A-Z]{3}$/.test(currency)||
          !["self_reported","referral","partner","paid_campaign","organic","other"].includes(sourceType)||
          !Number.isFinite(Date.parse(acquiredAt))||Date.parse(acquiredAt)>Date.now())
          return error(400,"ACQUISITION_ATTRIBUTION_INVALID","Provide a valid customer ID, channel, currency, source type and acquisition timestamp.");
        const result=await rpc("record_customer_acquisition_attribution",{
          p_actor_id:ownerId,p_owner_id:attributedOwnerId,p_channel:channel,p_campaign:campaign,
          p_currency:currency,p_source_type:sourceType,p_acquired_at:new Date(acquiredAt).toISOString()
        });
        return response(200,{attribution:result});
      }
      if(path==="/api/admin/customer-success/experiments"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"CUSTOMER_SUCCESS_ADMIN_REQUIRED","A platform or billing administrator role is required.");
        const experimentKey=String(body.experimentKey||"").trim();
        const name=String(body.name||"").trim();
        const hypothesis=String(body.hypothesis||"").trim();
        const primaryMetric=String(body.primaryMetric||"");
        const variants=Array.isArray(body.variants)?body.variants:[];
        const allowedMetrics=["activation_rate","first_renewal_rate","paid_retention","net_revenue_retention","render_completion_rate","workflow_completion_rate","winback_conversion"];
        if(!/^[a-z0-9][a-z0-9_-]{2,59}$/.test(experimentKey)||name.length<3||name.length>120||
          hypothesis.length<10||hypothesis.length>1000||!allowedMetrics.includes(primaryMetric)||
          variants.length<2||variants.length>4||variants.some(v=>!v||!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(String(v.key||""))||String(v.label||"").length<1||String(v.label||"").length>80))
          return error(400,"GROWTH_EXPERIMENT_INVALID","Experiment details, metric and 2–4 valid variants are required.");
        const result=await rpc("customer_growth_create_experiment",{
          p_admin_id:ownerId,p_experiment_key:experimentKey,p_name:name,p_hypothesis:hypothesis,
          p_primary_metric:primaryMetric,p_variants:variants,
          p_starts_at:body.startsAt||null,p_ends_at:body.endsAt||null
        });
        return response(201,{experiment:result});
      }
      if(path==="/api/admin/customer-success/experiments"&&method==="PATCH"){
        if(!await requireAdmin(ownerId))return error(403,"CUSTOMER_SUCCESS_ADMIN_REQUIRED","A platform or billing administrator role is required.");
        const experimentId=String(body.experimentId||""),status=String(body.status||"");
        if(!UUID.test(experimentId)||!["draft","running","paused","completed"].includes(status))
          return error(400,"GROWTH_EXPERIMENT_STATUS_INVALID","A valid experiment ID and status are required.");
        const result=await rpc("customer_growth_set_experiment_status",{p_admin_id:ownerId,p_experiment_id:experimentId,p_status:status});
        return response(200,{experiment:result});
      }
      if(path==="/api/admin/customer-success/interventions"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"CUSTOMER_SUCCESS_ADMIN_REQUIRED","A platform or billing administrator role is required.");
        const result=await dbRequest("customer_success_interventions?select=id,owner_id,intervention_type,status,reason,outcome,created_at,updated_at,resolved_at&order=created_at.desc&limit=100");
        return response(200,{interventions:Array.isArray(result.data)?result.data:[]});
      }
      if(path==="/api/admin/customer-success/interventions"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"CUSTOMER_SUCCESS_ADMIN_REQUIRED","A platform or billing administrator role is required.");
        const customerId=String(body.ownerId||""),type=String(body.type||""),reason=String(body.reason||"").trim();
        if(!UUID.test(customerId)||!["onboarding_help","first_value_nudge","usage_guidance","renewal_checkin","payment_recovery","winback"].includes(type)||reason.length<3||reason.length>500)
          return error(400,"CUSTOMER_INTERVENTION_INVALID","A customer, supported intervention type and reason are required.");
        const result=await rpc("customer_growth_record_intervention",{p_admin_id:ownerId,p_owner_id:customerId,p_type:type,p_reason:reason});
        return response(201,{intervention:result});
      }
      if(path==="/api/admin/customer-success/interventions"&&method==="PATCH"){
        if(!await requireAdmin(ownerId))return error(403,"CUSTOMER_SUCCESS_ADMIN_REQUIRED","A platform or billing administrator role is required.");
        const interventionId=String(body.interventionId||""),status=String(body.status||""),outcome=body.outcome==null?null:String(body.outcome);
        const allowedOutcomes=["renewed","reactivated","expanded","engaged","no_change","declined","unreachable","not_applicable"];
        if(!UUID.test(interventionId)||!["approved","dismissed","completed"].includes(status)||
          (status==="completed"&&!allowedOutcomes.includes(String(outcome)))||(status!=="completed"&&outcome!==null))
          return error(400,"CUSTOMER_INTERVENTION_UPDATE_INVALID","A valid intervention ID, status and completion outcome are required.");
        const result=await rpc("customer_growth_update_intervention",{p_admin_id:ownerId,p_intervention_id:interventionId,p_status:status,p_outcome:outcome});
        return response(200,{intervention:result});
      }
      if(path==="/api/admin/customer-success/overview"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"CUSTOMER_SUCCESS_ADMIN_REQUIRED","A platform or billing administrator role is required.");
        const result=await rpc("customer_success_admin_overview",{});
        return response(200,{overview:result||{customers:[],totalCustomers:0,healthy:0,watch:0,atRisk:0,critical:0}});
      }
      if(path==="/api/admin/finance/summary"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A billing administrator role is required.");
        const from=String(query.from||"").slice(0,30),to=String(query.to||"").slice(0,30);
        const validPeriod=from&&to&&/^\d{4}-\d{2}-\d{2}$/.test(from)&&/^\d{4}-\d{2}-\d{2}$/.test(to);
        const paymentDateFilter=validPeriod?"&and=(created_at.gte."+from+"T00:00:00Z,created_at.lte."+to+"T23:59:59Z)":"";
        const refundDateFilter=validPeriod?"&and=(requested_at.gte."+from+"T00:00:00Z,requested_at.lte."+to+"T23:59:59Z)":"";
        const [payments,refunds,disputes]=await Promise.all([
          dbRequest("payment_transactions?select=amount_minor,currency,status,created_at,provider_fee_minor&order=created_at.desc&limit=1000"+paymentDateFilter),
          dbRequest("payment_refunds?select=amount_minor,currency,status,requested_at&order=requested_at.desc&limit=1000"+refundDateFilter),
          dbRequest("chargeback_cases?select=amount_minor,currency,status,response_due_at&status=in.(open,under_review)&limit=1000")
        ]);
        const paymentRows=Array.isArray(payments.data)?payments.data:[];
        const refundRows=Array.isArray(refunds.data)?refunds.data:[];
        const disputeRows=Array.isArray(disputes.data)?disputes.data:[];
        const currencies=[...new Set([...paymentRows,...refundRows,...disputeRows].map(row=>row.currency))];
        const byCurrency=currencies.map(currency=>{
          const ps=paymentRows.filter(row=>row.currency===currency&&row.status==="successful");
          const rs=refundRows.filter(row=>row.currency===currency&&row.status==="succeeded");
          const ds=disputeRows.filter(row=>row.currency===currency);
          const sum=rows=>rows.reduce((total,row)=>total+Number(row.amount_minor||0),0);
          return {currency,grossRevenueMinor:sum(ps),refundsMinor:sum(rs),netRevenueMinor:sum(ps)-sum(rs),providerFeesMinor:sum(ps.map(row=>({amount_minor:row.provider_fee_minor||0}))),outstandingDisputesMinor:sum(ds),successfulPayments:ps.length,successfulRefunds:rs.length,outstandingDisputes:ds.length};
        });
        return response(200,{period:validPeriod?{from,to}:null,byCurrency,reconciliationRequired:true,sourceTruncated:paymentRows.length===1000||refundRows.length===1000||disputeRows.length===1000,sourceLimit:1000,source:"provider-backed transaction records"});
      }
      if(path==="/api/admin/finance/disputes"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A finance administrator role is required.");
        const limit=Math.max(1,Math.min(200,Number(query.limit)||100));
        const casesResult=await dbRequest("chargeback_cases?select=id,owner_id,payment_transaction_id,provider,provider_case_id,amount_minor,currency,reason,status,stage,response_due_at,outcome_at,provider_reference,created_at,updated_at&order=response_due_at.asc.nullslast&limit="+limit);
        const cases=Array.isArray(casesResult.data)?casesResult.data:[];
        const ids=cases.map(row=>row.id).filter(id=>UUID.test(String(id)));
        const evidenceResult=ids.length?await dbRequest("financial_dispute_evidence_items?select=id,case_id,evidence_type,status,storage_object_path,note,reviewed_at,updated_at&case_id=in.("+ids.join(",")+")&order=updated_at.desc"): {data:[]};
        const evidence=Array.isArray(evidenceResult.data)?evidenceResult.data:[];
        const now=Date.now();
        const deadlines=cases.reduce((acc,row)=>{
          const due=Date.parse(row.response_due_at||"");
          if(Number.isFinite(due)){if(due<now)acc.overdue++;else if(due-now<=72*60*60*1000)acc.dueSoon++;}
          return acc;
        },{overdue:0,dueSoon:0});
        return response(200,{cases,evidence,deadlines,limit,source:"provider-backed dispute records"});
      }
      if(path==="/api/admin/finance/disputes/evidence"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A finance administrator role is required.");
        const caseId=String(body.caseId||"");
        const evidenceType=String(body.evidenceType||"");
        const status=String(body.status||"");
        const objectPath=body.storageObjectPath==null?null:String(body.storageObjectPath).trim();
        const note=String(body.note||"").trim().slice(0,1000);
        const reason=String(body.reason||"").trim().slice(0,500);
        const evidenceTypes=["payment_receipt","service_delivery","customer_communication","refund_record","terms_acceptance","other"];
        const evidenceStatuses=["missing","uploaded","verified","rejected"];
        if(!UUID.test(caseId)||!evidenceTypes.includes(evidenceType)||!evidenceStatuses.includes(status)||reason.length<3||note.length>1000)
          return error(400,"DISPUTE_EVIDENCE_INPUT_INVALID","Provide a valid dispute, evidence type, status and audit reason.");
        if(["uploaded","verified"].includes(status)&&(!objectPath||objectPath.length>500||/^https?:\/\//i.test(objectPath)||objectPath.includes("..")||objectPath.startsWith("/")))
          return error(400,"DISPUTE_EVIDENCE_PATH_INVALID","Uploaded evidence must reference a private relative storage object path.");
        const evidence=await rpc("upsert_financial_dispute_evidence",{
          p_actor_id:ownerId,p_case_id:caseId,p_evidence_type:evidenceType,p_status:status,
          p_storage_object_path:objectPath,p_note:note,p_reason:reason
        });
        return response(200,{evidence});
      }
      if(path==="/api/admin/finance/refunds"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A billing administrator role is required.");
        if(!refundsEnabled)return error(503,"REFUNDS_DISABLED","Refund initiation is disabled.");
        const paymentId=String(body.paymentTransactionId||"");
        const amountMinor=Number(body.amountMinor);
        const reason=String(body.reason||"").trim().slice(0,500);
        const key=String(idempotencyKey||"").trim();
        if(!UUID.test(paymentId)||!Number.isSafeInteger(amountMinor)||amountMinor<=0||reason.length<3||key.length<8||key.length>180)
          return error(400,"REFUND_INPUT_INVALID","Provide a payment ID, positive amount in minor units, reason and an idempotency key.");
        const paymentResult=await dbRequest("payment_transactions?select=id,owner_id,provider_transaction_id,amount_minor,currency,status&id=eq."+encodeURIComponent(paymentId)+"&limit=1");
        const payment=Array.isArray(paymentResult.data)?paymentResult.data[0]:null;
        if(!payment)return error(404,"PAYMENT_NOT_FOUND","Payment transaction not found.");
        if(payment.status!=="successful"||!payment.provider_transaction_id)return error(409,"PAYMENT_NOT_REFUNDABLE","Only a verified successful Flutterwave charge can be refunded.");
        if(!Number.isSafeInteger(payment.amount_minor)||amountMinor>payment.amount_minor)return error(400,"REFUND_AMOUNT_INVALID","Refund amount exceeds the original payment.");
        const reservation=await rpc("reserve_payment_refund",{
          p_owner_id:payment.owner_id,p_payment_transaction_id:payment.id,
          p_amount_minor:amountMinor,p_currency:payment.currency,
          p_reason:reason,p_idempotency_key:key,p_requested_by:ownerId
        });
        const refundId=typeof reservation==="string"?reservation:reservation?.id;
        if(!UUID.test(String(refundId||"")))throw new Error("Refund reservation RPC did not return a valid refund ID.");
        await rpc("write_financial_admin_audit",{p_actor_id:ownerId,p_action:"finance.refund.initiate",p_resource_type:"payment_refund",p_resource_id:String(refundId),p_reason:reason,p_request_id:randomUUID(),p_metadata:{paymentTransactionId:payment.id,amountMinor, currency:payment.currency}});
        const refundResult=await dbRequest("payment_refunds?select=id,status,provider_refund_id&id=eq."+encodeURIComponent(refundId)+"&limit=1");
        const refund=Array.isArray(refundResult.data)?refundResult.data[0]:null;
        if(!refund)throw new Error("Reserved refund record could not be retrieved.");
        if(refund.provider_refund_id)return response(200,{refund:{id:refund.id,status:refund.status},idempotentReplay:true});
        try{
          const created=await providerRequest("/refunds",{
            method:"POST",idempotencyKey:key,
            body:{amount:minorToMajor(amountMinor,payment.currency),reason,charge_id:payment.provider_transaction_id}
          });
          const providerRefund=created?.data;
          if(!providerRefund?.id)throw Object.assign(new Error("Flutterwave returned no refund ID."),{code:"PROVIDER_INVALID_RESPONSE"});
          await dbRequest("payment_refunds?id=eq."+encodeURIComponent(refundId),{
            method:"PATCH",body:{
              provider_refund_id:String(providerRefund.id),status:"processing",
              provider_payload:providerRefund,updated_at:new Date().toISOString()
            },prefer:"return=minimal"
          });
          let verified={status:"processing"};
          try{verified=await verifyAndFinalizeRefund(String(providerRefund.id));}catch{}
          return response(202,{refund:{id:refundId,providerRefundId:String(providerRefund.id),status:verified.status||"processing"},message:"Refund initiated. Credits will only be reversed after Flutterwave confirms successful completion."});
        }catch(err){
          // A timeout or provider 5xx is ambiguous. Keep the reservation active
          // to prevent a second refund request from over-refunding the charge.
          return response(err.status===202?202:502,{refund:{id:refundId,status:"requested"},error:{code:err.code||"PROVIDER_RESULT_UNCERTAIN",message:"Refund result is not yet confirmed. The amount remains reserved for safe reconciliation."}});
        }
      }
      if(path==="/api/admin/finance/reconcile"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A billing administrator role is required.");
        const result=await reconcilePendingRefunds({limit:100});
        await rpc("write_financial_admin_audit",{p_actor_id:ownerId,p_action:"finance.refunds.reconcile",p_resource_type:"refund_batch",p_resource_id:randomUUID(),p_reason:"Administrator initiated pending refund reconciliation",p_request_id:randomUUID(),p_metadata:{checked:result.checked}});
        return response(200,result);
      }
      if(path==="/api/admin/finance/command-centre"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A finance administrator role is required.");
        const from=String(query.from||"").slice(0,30),to=String(query.to||"").slice(0,30);
        const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+"T00:00:00Z"));
        if((from&&!validDate(from))||(to&&!validDate(to))||(from&&to&&to<from))return error(400,"FINANCE_PERIOD_INVALID","Use a valid inclusive date range.");
        const start=from?from+"T00:00:00.000Z":new Date(Date.now()-30*86400000).toISOString();
        const end=to?to+"T23:59:59.999Z":new Date().toISOString();
        const data=await rpc("admin_financial_command_centre",{p_actor_id:ownerId,p_from:start,p_to:end,p_limit:Math.max(1,Math.min(200,Number(query.limit)||100))});
        return response(200,{...data,generatedAt:new Date().toISOString(),source:"verified local payment, refund and subscription records"});
      }
      if(path==="/api/admin/finance/customer"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A finance administrator role is required.");
        const customerId=String(query.ownerId||"");
        if(!UUID.test(customerId))return error(400,"CUSTOMER_ID_INVALID","A valid customer ID is required.");
        const [payments,subscriptions,refunds,attempts,disputes]=await Promise.all([
          dbRequest("payment_transactions?select=id,tx_ref,provider_transaction_id,amount_minor,currency,status,payment_method,description,paid_at,created_at,provider_fee_minor&owner_id=eq."+encodeURIComponent(customerId)+"&order=created_at.desc&limit=200"),
          dbRequest("customer_subscriptions?select=id,plan_code,status,billing_interval,amount_minor,currency,current_period_start,current_period_end,grace_until,cancel_at_period_end,created_at&owner_id=eq."+encodeURIComponent(customerId)+"&order=created_at.desc&limit=50"),
          dbRequest("payment_refunds?select=id,payment_transaction_id,amount_minor,currency,status,reason,requested_at,completed_at&owner_id=eq."+encodeURIComponent(customerId)+"&order=requested_at.desc&limit=100"),
          dbRequest("payment_attempts?select=id,tx_ref,amount_minor,currency,status,failure_code,failure_message,attempt_number,next_retry_at,created_at&owner_id=eq."+encodeURIComponent(customerId)+"&order=created_at.desc&limit=100"),
          dbRequest("chargeback_cases?select=id,payment_transaction_id,provider_case_id,amount_minor,currency,status,stage,response_due_at,created_at&owner_id=eq."+encodeURIComponent(customerId)+"&order=created_at.desc&limit=100")
        ]);
        const rows=x=>Array.isArray(x.data)?x.data:[];
        await rpc("write_financial_admin_audit",{p_actor_id:ownerId,p_action:"finance.customer_profile.view",p_resource_type:"customer",p_resource_id:customerId,p_reason:"Administrator viewed customer financial profile",p_request_id:randomUUID(),p_metadata:{payments:rows(payments).length,refunds:rows(refunds).length,chargebacks:rows(disputes).length}});
        return response(200,{customerId,payments:rows(payments),subscriptions:rows(subscriptions),refunds:rows(refunds),paymentAttempts:rows(attempts),chargebacks:rows(disputes)});
      }
      if(path==="/api/admin/finance/audit"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A finance administrator role is required.");
        const limit=Math.max(1,Math.min(200,Number(query.limit)||50));
        const result=await dbRequest("financial_admin_audit?select=id,actor_id,actor_role,action,resource_type,resource_id,reason,request_id,metadata,created_at&order=created_at.desc&limit="+limit);
        return response(200,{events:Array.isArray(result.data)?result.data:[],limit,immutable:true});
      }
      if(path==="/api/admin/finance/export"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A finance administrator role is required.");
        const kind=String(query.kind||"payments");
        const limit=Math.max(1,Math.min(1000,Number(query.limit)||1000));
        const allowed={
          payments:"payment_transactions?select=id,owner_id,tx_ref,provider_transaction_id,amount_minor,currency,status,payment_method,provider_fee_minor,paid_at,created_at&order=created_at.desc&limit="+limit,
          refunds:"payment_refunds?select=id,owner_id,payment_transaction_id,provider_refund_id,amount_minor,currency,status,reason,requested_at,completed_at&order=requested_at.desc&limit="+limit,
          subscriptions:"customer_subscriptions?select=id,owner_id,plan_code,status,billing_interval,amount_minor,currency,current_period_start,current_period_end,created_at&order=created_at.desc&limit="+limit,
          chargebacks:"chargeback_cases?select=id,owner_id,provider_case_id,amount_minor,currency,status,stage,response_due_at,created_at&order=created_at.desc&limit="+limit,
          settlements:"flutterwave_settlement_records?select=provider_settlement_id,currency,gross_amount_minor,net_amount_minor,fee_amount_minor,refund_amount_minor,chargeback_amount_minor,provider_status,destination,due_at,settled_at,last_reconciled_at&order=last_reconciled_at.desc&limit="+limit
,          costs:"financial_service_cost_events?select=id,period_month,owner_id,cost_category,source_type,currency,amount_minor,entry_type,reverses_event_id,source_reference,description,recorded_by,created_at&order=period_month.desc,created_at.desc&limit="+limit
        };
        if(!allowed[kind])return error(400,"EXPORT_KIND_INVALID","Choose payments, refunds, subscriptions, chargebacks, settlements or costs.");
        const data=await dbRequest(allowed[kind]);
        await rpc("write_financial_admin_audit",{p_actor_id:ownerId,p_action:"finance.export."+kind,p_resource_type:"financial_report",p_resource_id:kind,p_reason:"Administrator requested financial data export",p_request_id:randomUUID(),p_metadata:{rowCount:Array.isArray(data.data)?data.data.length:0}});
        return response(200,{kind,generatedAt:new Date().toISOString(),rows:Array.isArray(data.data)?data.data:[],truncated:Array.isArray(data.data)&&data.data.length===limit});
      }
      if(path==="/api/admin/finance/settlements/reconcile"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A finance administrator role is required.");
        const from=String(body.from||"").slice(0,10),to=String(body.to||"").slice(0,10);
        const dateOk=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+"T00:00:00Z"));
        if(!dateOk(from)||!dateOk(to)||to<from)return error(400,"SETTLEMENT_PERIOD_INVALID","Provide a valid settlement date range.");
        const settlements=[];
        let page=1,totalPages=1;
        while(page<=totalPages&&page<=10){
          const list=await providerRequest("/settlements?page="+page+"&size=100&from="+encodeURIComponent(from)+"&to="+encodeURIComponent(to));
          if(Array.isArray(list?.data))settlements.push(...list.data);
          totalPages=Math.max(1,Math.min(100,Number(list?.meta?.page_info?.total_pages)||1));
          page++;
        }
        const truncated=totalPages>10;
        const results=[];
        for(const summary of settlements){
          try{
            const sid=String(summary?.id||"");
            if(!sid)continue;
            const firstDetail=await providerRequest("/settlements/"+encodeURIComponent(sid)+"?page=1&size=50");
            const detail=firstDetail?.data||firstDetail;
            const charges=Array.isArray(detail?.charges)?[...detail.charges]:[];
            const declared=Number(detail?.charge_count||summary?.charge_count||0);
            const chargePages=Math.max(1,Math.min(100,Number(firstDetail?.meta?.page_info?.total_pages)||1));
            for(let chargePage=2;chargePage<=chargePages&&chargePage<=20;chargePage++){
              const nextPage=await providerRequest("/settlements/"+encodeURIComponent(sid)+"?page="+chargePage+"&size=50");
              const nextDetail=nextPage?.data||nextPage;
              if(Array.isArray(nextDetail?.charges))charges.push(...nextDetail.charges);
            }
            const complete=declared===charges.length&&chargePages<=20;
            let expectedGross=null,expectedFees=null;
            if(complete){
              const ids=charges.map(c=>String(c?.id||"")).filter(Boolean);
              if(ids.length===charges.length&&ids.length){
                const filter=ids.map(id=>encodeURIComponent(id)).join(",");
                const local=await dbRequest("payment_transactions?select=provider_transaction_id,amount_minor,provider_fee_minor,currency,status&provider=eq.flutterwave&provider_transaction_id=in.("+filter+")");
                const localRows=Array.isArray(local.data)?local.data:[];
                if(localRows.length===ids.length&&localRows.every(row=>row.currency===detail.currency&&row.status==="successful")){
                  expectedGross=localRows.reduce((sum,row)=>sum+Number(row.amount_minor),0);
                  if(localRows.every(row=>Number.isSafeInteger(row.provider_fee_minor)))expectedFees=localRows.reduce((sum,row)=>sum+Number(row.provider_fee_minor),0);
                }
              }
            }
            const recorded=await rpc("record_flutterwave_settlement",{p_actor_id:ownerId,p_settlement:detail,p_expected_gross_minor:expectedGross,p_expected_fees_minor:expectedFees});
            results.push({...recorded,lineItemsComplete:complete,localChargeMatch:expectedGross!==null,reconciliationStatus:recorded.exceptions?.length?"exception":expectedGross===null?"review_required":"matched"});
          }catch(err){results.push({providerSettlementId:String(summary?.id||""),reconciliationStatus:"failed",code:err.code||"SETTLEMENT_RECONCILIATION_FAILED"});}
        }
        await rpc("write_financial_admin_audit",{p_actor_id:ownerId,p_action:"finance.settlements.reconcile",p_resource_type:"settlement_batch",p_resource_id:from+"/"+to,p_reason:"Administrator initiated Flutterwave settlement reconciliation",p_request_id:randomUUID(),p_metadata:{settlementCount:results.length}});
        return response(200,{from,to,checked:results.length,results,truncated,provider:"flutterwave",note:"Settlements without complete provider charge details or exact local charge matches remain review_required; no discrepancy is silently marked as reconciled."});
      }
      if(path==="/api/admin/finance/reconciliation-exceptions/resolve"&&method==="POST"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A finance administrator role is required.");
        const exceptionId=String(body.exceptionId||""),status=String(body.status||""),reason=String(body.reason||"").trim();
        if(!UUID.test(exceptionId)||!["investigating","resolved","accepted_difference"].includes(status)||reason.length<3||reason.length>500)
          return error(400,"RECONCILIATION_RESOLUTION_INVALID","Provide an exception, valid status and a reason.");
        await rpc("resolve_financial_reconciliation_exception",{p_actor_id:ownerId,p_exception_id:exceptionId,p_status:status,p_reason:reason});
        return response(200,{success:true,status,exceptionId});
      }
      return null;
    }catch(err){
      const status=err.status===400?400:err.status===404?404:err.status===409?409:err.status===202?202:502;
      return error(status,err.code||"FINANCIAL_API_ERROR",status===502?"Financial operation could not be completed safely.":String(err.message||"Financial operation failed."));
    }
  }

  async function recordWorkerWorkloadTelemetry({job,measurement}={}){
    if(!resourceCostMeteringEnabled)return {recorded:false,reason:"resource_cost_metering_disabled"};
    if(!UUID.test(String(financialSystemActorId||"")))return {recorded:false,reason:"financial_system_actor_not_configured"};
    if(!job||!measurement)return {recorded:false,reason:"resource_measurement_missing"};
    const measuredAt=String(measurement.measuredAt||new Date().toISOString());
    const stableIdentity=[job.id,measurement.measurementId||"",measurement.resourceType||"",measurement.quantity??"",measurement.unit||"",measuredAt].join("|");
    const idempotencyKey="worker-workload:"+hashText(stableIdentity).slice(0,64);
    const operationMap={"media.probe":"other","media.thumbnail":"image","media.transcode":"video","media.audio_extract":"audio","media.audio-clean":"audio","media.proxy":"video","media.denoise":"audio","media.color":"video","media.resize":"image","media.interpolate":"video","media.upscale":"upscale","media.ai-upscale":"upscale","timeline.render":"render","workflow.execute":"other"};
    const event=normalizeWorkloadTelemetry({
      occurredAt:measuredAt,provider:"executive-visuals-worker",model:job.job_type,
      operation:operationMap[job.job_type]||"other",source:"worker_measurement",
      operationId:job.id,ownerId:job.owner_id,projectId:job.project_id,jobId:job.id,
      dimensions:measurement.dimensions||{},resourceType:measurement.resourceType,
      resourceUnit:measurement.unit,resourceQuantity:measurement.quantity,
      idempotencyKey
    });
    const result=await rpc("record_ai_workload_telemetry_event",{
      p_actor_id:financialSystemActorId,p_occurred_at:event.occurredAt,p_owner_id:event.ownerId,
      p_project_id:event.projectId,p_job_id:event.jobId,p_operation_id:event.operationId,
      p_provider:event.provider,p_model:event.model,p_operation:event.operation,
      p_evidence_source:event.source,p_resolution_tier:event.resolutionTier,
      p_currency:event.currency,p_provider_cost_minor:event.providerCostMinor,
      p_dimensions:event.dimensions,p_resource_type:event.resourceType,
      p_resource_unit:event.resourceUnit,p_resource_quantity:event.resourceQuantity,
      p_evidence_reference:event.evidenceReference,p_idempotency_key:event.idempotencyKey
    });
    return {recorded:true,result};
  }

  async function recordWorkerResourceUsage({job,measurement}={}){
    if(!resourceCostMeteringEnabled)return {recorded:false,reason:"resource_cost_metering_disabled"};
    if(!UUID.test(String(financialSystemActorId||"")))return {recorded:false,reason:"financial_system_actor_not_configured"};
    if(!job||!measurement)return {recorded:false,reason:"resource_measurement_missing"};
    const event=normalizeResourceUsage({
      occurredAt:measurement.measuredAt,provider:"executive-visuals-worker",model:job.job_type,
      operationId:job.id,resourceType:measurement.resourceType,quantity:measurement.quantity,
      unit:measurement.unit,currency:resourceCostCurrency,ownerId:job.owner_id,
      projectId:job.project_id,jobId:job.id,
      idempotencyKey:"worker-resource:"+job.id+":"+String(measurement.measurementId||randomUUID())
    });
    const result=await rpc("record_ai_resource_usage_event",{
      p_actor_id:financialSystemActorId,p_occurred_at:event.occurredAt,p_owner_id:event.ownerId,
      p_project_id:event.projectId,p_job_id:event.jobId,p_operation_id:event.operationId,
      p_provider:event.provider,p_model:event.model,p_resource_type:event.resourceType,
      p_quantity:event.quantity,p_unit:event.unit,p_currency:event.currency,
      p_provider_cost_minor:null,p_idempotency_key:event.idempotencyKey,
      p_evidence:{source:"worker_instrumentation",measurement:"ffmpeg_process_wall_clock",
        jobType:job.job_type,attempt:Number(job.attempt_count)||1}
    });
    return {recorded:true,result};
  }

  return {handle,handleWebhook,verifyAndFinalizeRefund,verifyAndFinalizePayment,reconcilePendingRefunds,recordWorkerResourceUsage,recordWorkerWorkloadTelemetry,expireDueSubscriptions:()=>rpc("expire_due_subscriptions",{p_limit:100})};
}
