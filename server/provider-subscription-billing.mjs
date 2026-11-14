import {createHash,randomUUID} from "node:crypto";
import {createSubscriptionPaymentProviders} from "./subscription-payment-providers.mjs";
import {createUnifiedSubscriptionBilling} from "./unified-subscription-billing.mjs";

const jsonResponse=(status,body)=>({status,body});
const hash=value=>createHash("sha256").update(String(value)).digest("hex");
const text=value=>String(value??"").trim();
const validEmail=value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export function getProviderSubscriptionBillingReadiness(env=process.env){
  const paddle=Boolean(env.PADDLE_API_KEY&&env.PADDLE_WEBHOOK_SECRET&&env.PADDLE_RETURN_URL);
  const pesapal=Boolean(env.PESAPAL_CONSUMER_KEY&&env.PESAPAL_CONSUMER_SECRET&&env.PESAPAL_IPN_ID&&env.PESAPAL_CALLBACK_URL);
  return {
    enabled:env.PADDLE_PESAPAL_BILLING_ENABLED==="true",
    paddle:{configured:paddle,environment:env.PADDLE_API_BASE_URL==="https://api.paddle.com"?"live":"sandbox"},
    pesapal:{configured:pesapal,environment:env.PESAPAL_API_BASE_URL==="https://pay.pesapal.com/v3"?"live":"sandbox"},
    databaseConfigured:Boolean(env.SUPABASE_URL&&env.SUPABASE_SERVICE_ROLE_KEY),
    ready:env.PADDLE_PESAPAL_BILLING_ENABLED==="true"&&paddle&&pesapal&&Boolean(env.SUPABASE_URL&&env.SUPABASE_SERVICE_ROLE_KEY)
  };
}

export function createProviderSubscriptionBilling({
  supabaseUrl=process.env.SUPABASE_URL,
  serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
  paddleReturnUrl=process.env.PADDLE_RETURN_URL,
  pesapalCallbackUrl=process.env.PESAPAL_CALLBACK_URL,
  pesapalNotificationId=process.env.PESAPAL_IPN_ID,
  providers:providedProviders,
  fetchImpl=globalThis.fetch,
  now=()=>Date.now()
}={}){
  if(!supabaseUrl||!serviceRoleKey)throw new Error("Provider subscription billing requires server-side Supabase credentials.");
  if(typeof fetchImpl!=="function")throw new Error("Provider subscription billing requires fetch.");
  const origin=new URL(supabaseUrl).origin;
  const providers=providedProviders||createSubscriptionPaymentProviders();
  if(!providers?.paddle||!providers?.pesapal)throw new Error("Paddle and Pesapal adapters are required.");
  if(!paddleReturnUrl||new URL(paddleReturnUrl).protocol!=="https:")throw new Error("PADDLE_RETURN_URL must be HTTPS.");
  if(!pesapalCallbackUrl||new URL(pesapalCallbackUrl).protocol!=="https:"||!pesapalNotificationId)throw new Error("Pesapal callback URL and registered IPN ID are required.");

  async function dbRequest(path,{method="GET",body=null,prefer="return=representation",allowConflict=false}={}){
    const headers={
      apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,
      "accept-profile":"executive_visuals","content-profile":"executive_visuals",
      accept:"application/json",prefer
    };
    if(body!==null)headers["content-type"]="application/json";
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{
      const result=await fetchImpl(origin+"/rest/v1/"+path,{
        method,headers,...(body===null?{}:{body:JSON.stringify(body)}),
        signal:controller.signal,redirect:"error"
      });
      const raw=await result.text();
      let data=null;
      if(raw){try{data=JSON.parse(raw);}catch{throw Object.assign(new Error("Subscription database returned invalid JSON."),{code:"SUBSCRIPTION_DATABASE_INVALID_JSON",status:502});}}
      if(!result.ok){
        if(allowConflict&&result.status===409)return {data:null,status:409};
        throw Object.assign(new Error("Subscription database request failed (HTTP "+result.status+")."),{code:"SUBSCRIPTION_DATABASE_ERROR",status:502});
      }
      return {data,status:result.status};
    }catch(error){
      if(error?.name==="AbortError")throw Object.assign(new Error("Subscription database request timed out."),{code:"SUBSCRIPTION_DATABASE_TIMEOUT",status:504});
      throw error;
    }finally{clearTimeout(timer);}
  }

  async function rpc(name,body){
    const result=await dbRequest("rpc/"+name,{method:"POST",body,prefer:"return=representation"});
    return result.data;
  }

  async function getPayment(paymentId,ownerId){
    const result=await dbRequest("payment_transactions?select=id,owner_id,provider,provider_transaction_id,tx_ref,amount_minor,currency,status,metadata&id=eq."+encodeURIComponent(paymentId)+"&owner_id=eq."+encodeURIComponent(ownerId)+"&limit=1");
    return Array.isArray(result.data)?result.data[0]||null:null;
  }

  const repository={
    async reserveCheckout({provider,ownerId,planCode,email,idempotencyKey}){
      const result=await rpc("reserve_subscription_purchase_for_provider",{
        p_owner_id:ownerId,p_plan_code:planCode,p_customer_email:email,p_provider:provider,
        p_idempotency_key:idempotencyKey,p_tx_ref:"EVP"+randomUUID().replaceAll("-","")
      });
      if(!result||typeof result!=="object")return null;
      return {...result,reference:result.txRef};
    },
    async getCheckout({paymentId,ownerId}){
      const payment=await getPayment(paymentId,ownerId);
      if(!payment)return null;
      return {
        paymentId:payment.id,reference:payment.tx_ref,status:payment.status,
        provider:payment.provider,providerTransactionId:payment.provider_transaction_id,
        checkoutUrl:payment.metadata?.provider_checkout_url||null,
        idempotentReplay:true
      };
    },
    async attachProviderCheckout({ownerId,paymentId,provider,providerCheckout}){
      const payment=await getPayment(paymentId,ownerId);
      if(!payment||payment.provider!==provider||payment.status!=="pending")throw Object.assign(new Error("Pending subscription payment could not be matched."),{code:"SUBSCRIPTION_PAYMENT_NOT_PENDING",status:409});
      const providerTransactionId=provider==="paddle"?providerCheckout.transactionId:providerCheckout.trackingId;
      if(!providerTransactionId)throw Object.assign(new Error("Provider checkout did not return a transaction identifier."),{code:"PROVIDER_CHECKOUT_ID_MISSING",status:502});
      await dbRequest("payment_transactions?id=eq."+encodeURIComponent(paymentId)+"&owner_id=eq."+encodeURIComponent(ownerId),{
        method:"PATCH",body:{
          provider_transaction_id:String(providerTransactionId),
          metadata:{...payment.metadata,provider_checkout_id:String(providerTransactionId),
            provider_checkout_url:String(providerCheckout.checkoutUrl),provider_checkout_status:String(providerCheckout.status||"pending"),
            provider_checkout_created_at:new Date(now()).toISOString()},
          updated_at:new Date(now()).toISOString()
        },prefer:"return=minimal"
      });
      return true;
    },
    async markCheckoutUncertain({ownerId,paymentId,provider,errorCode}){
      const payment=await getPayment(paymentId,ownerId);
      if(!payment||payment.provider!==provider)return false;
      await dbRequest("payment_transactions?id=eq."+encodeURIComponent(paymentId)+"&owner_id=eq."+encodeURIComponent(ownerId),{
        method:"PATCH",body:{metadata:{...payment.metadata,checkout_result_uncertain:true,checkout_error_code:errorCode,checkout_uncertain_at:new Date(now()).toISOString()},updated_at:new Date(now()).toISOString()},prefer:"return=minimal"
      });
      return true;
    },
    async findPendingPesapalPayment({merchantReference}){
      const result=await dbRequest("payment_transactions?select=id,owner_id,provider_transaction_id,tx_ref,amount_minor,currency,status,metadata&provider=eq.pesapal&status=eq.pending&tx_ref=eq."+encodeURIComponent(merchantReference)+"&limit=1");
      const payment=Array.isArray(result.data)?result.data[0]:null;
      if(!payment)return null;
      const subscriptionId=String(payment.metadata?.subscription_id||"");
      if(!subscriptionId)return null;
      return {
        paymentId:payment.id,ownerId:payment.owner_id,subscriptionId,
        providerTransactionId:payment.provider_transaction_id,reference:payment.tx_ref,
        amountMinor:Number(payment.amount_minor),
        amountMajor:payment.currency==="UGX"?Number(payment.amount_minor):Number(payment.amount_minor)/100,
        currency:payment.currency
      };
    },
    async applyProviderEvent({provider,event,paymentId,subscriptionId,ownerId}){
      const eventId=text(event?.eventId);
      if(!eventId)throw Object.assign(new Error("Verified provider event has no stable event ID."),{code:"PROVIDER_EVENT_ID_MISSING",status:422});
      const eventKey=hash(provider+":"+eventId);
      const payload={provider,eventId,eventType:event.eventType,ownerId:event.ownerId||ownerId||null,
        paymentId:event.paymentId||paymentId||null,reference:event.reference||event.merchantReference||null,
        providerTransactionId:event.providerTransactionId||event.trackingId||null,
        currency:event.currency||null,amountMinor:event.amountMinor??null,occurredAt:event.occurredAt||null};
      const inserted=await dbRequest("payment_webhook_events",{
        method:"POST",body:{provider,event_key:eventKey,event_type:String(event.eventType||"unknown"),
          payload_hash:hash(JSON.stringify(payload)),signature_verified:true,
          processing_status:"received",payload},prefer:"return=minimal",allowConflict:true
      });
      if(inserted.status===409){
        const prior=await dbRequest("payment_webhook_events?select=processing_status&provider=eq."+provider+"&event_key=eq."+eventKey+"&limit=1");
        const state=Array.isArray(prior.data)?prior.data[0]?.processing_status:null;
        if(state==="processed"||state==="ignored"||state==="needs_review")return {duplicate:true,processingStatus:state};
      }
      await dbRequest("payment_webhook_events?provider=eq."+provider+"&event_key=eq."+eventKey,{
        method:"PATCH",body:{processing_status:"processing",error_message:null},prefer:"return=minimal"
      });
      try{
        if(provider==="paddle"&&event.eventType!=="transaction.completed"){
          await dbRequest("payment_webhook_events?provider=eq.paddle&event_key=eq."+eventKey,{
            method:"PATCH",body:{processing_status:"needs_review",error_message:"Verified Paddle subscription lifecycle event awaits lifecycle processor.",processed_at:new Date(now()).toISOString()},prefer:"return=minimal"
          });
          return {applied:false,needsReview:true};
        }
        let payment;
        if(provider==="paddle"){
          if(!event.paymentId||!event.ownerId||!event.reference||!event.providerTransactionId||!Number.isSafeInteger(event.amountMinor)||!event.currency)
            throw Object.assign(new Error("Paddle transaction event is missing its reserved ledger correlation or amount."),{code:"PADDLE_EVENT_LEDGER_MISMATCH",status:409});
          payment=await getPayment(event.paymentId,event.ownerId);
          if(!payment||payment.provider!=="paddle"||payment.tx_ref!==event.reference||payment.status!=="pending"||
            (payment.provider_transaction_id&&payment.provider_transaction_id!==event.providerTransactionId))
            throw Object.assign(new Error("Paddle transaction does not match a pending reserved payment."),{code:"PADDLE_EVENT_LEDGER_MISMATCH",status:409});
        }else{
          const reference=text(event.merchantReference);
          const result=await dbRequest("payment_transactions?select=id,owner_id,provider_transaction_id,tx_ref,amount_minor,currency,status,metadata&provider=eq.pesapal&status=eq.pending&tx_ref=eq."+encodeURIComponent(reference)+"&limit=1");
          payment=Array.isArray(result.data)?result.data[0]||null:null;
          if(!payment||payment.owner_id!==ownerId||payment.provider_transaction_id!==event.trackingId||payment.tx_ref!==reference)
            throw Object.assign(new Error("Pesapal transaction does not match a pending reserved payment."),{code:"PESAPAL_EVENT_LEDGER_MISMATCH",status:409});
          if(payment.currency!=="UGX"||event.currency!=="UGX"||!Number.isSafeInteger(Number(event.amount))||Number(event.amount)!==Number(payment.amount_minor))
            throw Object.assign(new Error("Pesapal amount or currency does not match the reserved payment."),{code:"PESAPAL_EVENT_AMOUNT_MISMATCH",status:409});
        }
        const amountMinor=provider==="paddle"?event.amountMinor:Number(event.amount);
        const currency=provider==="paddle"?event.currency:event.currency;
        const reference=provider==="paddle"?event.reference:event.merchantReference;
        const providerTransactionId=provider==="paddle"?event.providerTransactionId:event.trackingId;
        const settled=await rpc("finalize_subscription_purchase_for_provider",{
          p_payment_id:payment.id,p_provider_transaction_id:providerTransactionId,
          p_provider_payload:{status:"succeeded",amount_minor:amountMinor,currency,reference,
            provider_subscription_id:event.providerSubscriptionId||event.recurring?.correlationId||null,
            provider_customer_id:event.providerCustomerId||null},
          p_verified_at:event.occurredAt&&Number.isFinite(Date.parse(event.occurredAt))?event.occurredAt:new Date(now()).toISOString()
        });
        await dbRequest("payment_webhook_events?provider=eq."+provider+"&event_key=eq."+eventKey,{
          method:"PATCH",body:{processing_status:"processed",processed_at:new Date(now()).toISOString()},prefer:"return=minimal"
        });
        return {applied:true,settlement:settled};
      }catch(error){
        await dbRequest("payment_webhook_events?provider=eq."+provider+"&event_key=eq."+eventKey,{
          method:"PATCH",body:{processing_status:"failed",error_message:String(error?.code||"PROVIDER_EVENT_PROCESSING_FAILED").slice(0,160)},prefer:"return=minimal"
        }).catch(()=>{});
        throw error;
      }
    }
  };

  const service=createUnifiedSubscriptionBilling({providers,repository});

  async function handle({method,path,ownerId,body={},idempotencyKey=""}={}){
    if(path==="/api/billing/subscription/provider-checkout"&&method==="POST"){
      const provider=text(body.provider).toLowerCase();
      const planCode=text(body.planCode).toLowerCase();
      const email=text(body.email).toLowerCase();
      const key=text(idempotencyKey);
      if(!ownerId||!["paddle","pesapal"].includes(provider)||!planCode||!validEmail(email)||key.length<8||key.length>180)
        return jsonResponse(400,{error:{code:"PROVIDER_SUBSCRIPTION_CHECKOUT_INPUT_INVALID",message:"Provide a provider, plan, valid email and idempotency key."}});
      if(provider==="pesapal"&&(!text(body.firstName)||!text(body.lastName)||!text(body.phone)))
        return jsonResponse(400,{error:{code:"PESAPAL_BILLING_DETAILS_REQUIRED",message:"Pesapal checkout requires the customer's name and phone number."}});
      try{
        const result=await service.createCheckout({
          provider,ownerId,planCode,email,idempotencyKey:key,returnUrl:paddleReturnUrl,
          pesapalOrder:provider==="pesapal"?{
            description:"Executive Visuals "+planCode+" subscription",
            firstName:text(body.firstName).slice(0,80),lastName:text(body.lastName).slice(0,80),
            phone:text(body.phone),countryCode:"UG",callbackUrl:pesapalCallbackUrl,notificationId:pesapalNotificationId
          }:undefined
        });
        return jsonResponse(result.idempotentReplay?200:202,{checkout:result});
      }catch(error){
        return jsonResponse(Number(error?.status)||502,{error:{code:error?.code||"PROVIDER_SUBSCRIPTION_CHECKOUT_FAILED",message:error?.message||"Provider checkout failed."}});
      }
    }
    return jsonResponse(404,{error:{code:"PROVIDER_SUBSCRIPTION_ROUTE_NOT_FOUND",message:"Provider subscription route not found."}});
  }

  async function handlePaddleWebhook({rawBody,signature}={}){
    try{
      const result=await service.handlePaddleWebhook({rawBody,signature});
      return jsonResponse(200,result);
    }catch(error){
      return jsonResponse(Number(error?.status)||400,{error:{code:error?.code||"PADDLE_WEBHOOK_FAILED",message:error?.message||"Paddle webhook could not be processed."}});
    }
  }

  async function handlePesapalIpn(query={}){
    try{
      const result=await service.handlePesapalNotification(query);
      return jsonResponse(200,{
        orderNotificationType:text(query.OrderNotificationType),
        orderTrackingId:text(query.OrderTrackingId),
        orderMerchantReference:text(query.OrderMerchantReference),
        status:200,result
      });
    }catch(error){
      return jsonResponse(500,{
        orderNotificationType:text(query.OrderNotificationType),
        orderTrackingId:text(query.OrderTrackingId),
        orderMerchantReference:text(query.OrderMerchantReference),
        status:500,error:{code:error?.code||"PESAPAL_IPN_FAILED"}
      });
    }
  }

  return Object.freeze({handle,handlePaddleWebhook,handlePesapalIpn});
}
