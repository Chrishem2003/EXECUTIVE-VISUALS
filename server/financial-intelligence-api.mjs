import { randomUUID, createHash } from "node:crypto";
import {
  verifyFlutterwaveWebhook, verifyFlutterwaveV3Webhook, hashWebhookPayload,
  parseRefundStatus, getCurrencyDecimals, minorToMajor
} from "./payment-intelligence.mjs";
import { createFlutterwaveAccessTokenProvider } from "./flutterwave-auth.mjs";

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
      return {matched:true,status:"failed",paymentId:payment.id};
    }
    if(providerStatus!=="succeeded")return {matched:true,status:"pending",paymentId:payment.id};
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
    const existing=await dbRequest("payment_webhook_events?select=id&provider=eq.flutterwave&event_key=eq."+eventKey+"&limit=1");
    if(Array.isArray(existing.data)&&existing.data.length)return response(200,{received:true,duplicate:true});
    const inserted=await dbRequest("payment_webhook_events",{
      method:"POST",body:{
        provider:"flutterwave",event_key:eventKey,event_type:event,
        payload_hash:payloadHash,signature_verified:true,
        processing_status:"received",payload
      },prefer:"return=minimal",allowConflict:true
    });
    if(inserted.status===409)return response(200,{received:true,duplicate:true});
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
    if(!billingEnabled)return error(503,"BILLING_DISABLED","Financial intelligence APIs are disabled until staging verification is complete.");
    if(!UUID.test(String(ownerId||"")))return error(401,"AUTH_REQUIRED","A verified Supabase account is required.");
    try{
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
        const prior=await dbRequest("payment_transactions?select=id,tx_ref,status,provider_transaction_id,metadata&owner_id=eq."+encodeURIComponent(ownerId)+"&metadata->>idempotency_key=eq."+encodeURIComponent(key)+"&limit=1");
        if(Array.isArray(prior.data)&&prior.data.length){
          const row=prior.data[0];
          if(row.metadata?.product_code!==productCode||row.metadata?.mobile_money_network!==network)
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
      if(path==="/api/billing/refunds"&&method==="GET"){
        const limit=Math.max(1,Math.min(SAFE_PAGE,Number(query.limit)||25));
        const offset=Math.max(0,Math.min(10000,Number(query.offset)||0));
        const result=await dbRequest("payment_refunds?select=id,payment_transaction_id,amount_minor,currency,status,reason,requested_at,completed_at&owner_id=eq."+encodeURIComponent(ownerId)+"&order=requested_at.desc&limit="+limit+"&offset="+offset);
        return response(200,{refunds:Array.isArray(result.data)?result.data:[],limit,offset});
      }
      if(path==="/api/admin/finance/summary"&&method==="GET"){
        if(!await requireAdmin(ownerId))return error(403,"FINANCE_ADMIN_REQUIRED","A billing administrator role is required.");
        const from=String(query.from||"").slice(0,30),to=String(query.to||"").slice(0,30);
        const validPeriod=from&&to&&/^\\d{4}-\\d{2}-\\d{2}$/.test(from)&&/^\\d{4}-\\d{2}-\\d{2}$/.test(to);
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
        return response(200,result);
      }
      return null;
    }catch(err){
      const status=err.status===400?400:err.status===404?404:err.status===409?409:err.status===202?202:502;
      return error(status,err.code||"FINANCIAL_API_ERROR",status===502?"Financial operation could not be completed safely.":String(err.message||"Financial operation failed."));
    }
  }

  return {handle,handleWebhook,verifyAndFinalizeRefund,verifyAndFinalizePayment,reconcilePendingRefunds};
}
