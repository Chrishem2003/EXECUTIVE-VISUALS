import { createHmac, timingSafeEqual } from "node:crypto";

const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const text=value=>String(value??"").trim();
const jsonHeaders={"content-type":"application/json","accept":"application/json"};
const fail=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const same=(a,b)=>{const left=Buffer.from(String(a)),right=Buffer.from(String(b));return left.length===right.length&&timingSafeEqual(left,right);};

async function requestJson(fetchImpl,url,{method="GET",headers={},body,timeoutMs=15000}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl(url,{method,headers:{...jsonHeaders,...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal,redirect:"error"});
    const raw=await response.text();
    let data=null;
    if(raw){try{data=JSON.parse(raw);}catch{throw fail("PAYMENT_PROVIDER_INVALID_JSON","Payment provider returned invalid JSON.",502);}}
    if(!response.ok)throw fail("PAYMENT_PROVIDER_REQUEST_FAILED","Payment provider request failed (HTTP "+response.status+").",502);
    return data;
  }catch(error){
    if(error?.name==="AbortError")throw fail("PAYMENT_PROVIDER_TIMEOUT","Payment provider request timed out.",504);
    throw error;
  }finally{clearTimeout(timer);}
}

function verifyPaddleSignature(rawBody,signature,secret,{now=Date.now(),toleranceSeconds=5}={}){
  if(!Buffer.isBuffer(rawBody)||rawBody.length===0||rawBody.length>1024*1024)return false;
  const fields=String(signature||"").split(";").map(part=>part.trim().split("=",2)).filter(pair=>pair.length===2);
  const timestamp=Number(fields.find(([key])=>key==="ts")?.[1]);
  const signatures=fields.filter(([key,value])=>key==="h1"&&/^[a-f0-9]{64}$/i.test(value)).map(([,value])=>value);
  if(!Number.isSafeInteger(timestamp)||!signatures.length||!secret)return false;
  if(Math.abs(Math.floor(now/1000)-timestamp)>toleranceSeconds)return false;
  const expected=createHmac("sha256",secret).update(String(timestamp)+":").update(rawBody).digest("hex");
  return signatures.some(provided=>same(expected,provided));
}

const PADDLE_EVENTS=new Set([
  "subscription.created","subscription.activated","subscription.updated","subscription.canceled",
  "subscription.past_due","subscription.paused","subscription.resumed","transaction.completed",
  "transaction.payment_failed","adjustment.created","adjustment.updated"
]);
function normalizePaddleEvent(event){
  const type=text(event?.event_type),data=event?.data||{},custom=data.custom_data||{};
  if(!PADDLE_EVENTS.has(type))return {ignored:true,eventType:type};
  const subscriptionId=text(data.id&&type.startsWith("subscription.")?data.id:data.subscription_id);
  const statusMap={
    "subscription.created":"pending","subscription.activated":"active","subscription.updated":text(data.status)||"active",
    "subscription.canceled":"canceled","subscription.past_due":"past_due","subscription.paused":"paused","subscription.resumed":"active",
    "transaction.completed":"payment_succeeded","transaction.payment_failed":"payment_failed"
  };
  const period=data.current_billing_period||{};
  const totals=data.details?.totals||{};
  const lineItems=data.details?.line_items||[];
  const amountMinor=Number(totals.subtotal);
  const totalPaidMinor=Number(totals.grand_total);
  const discountMinor=Number(totals.discount||0);
  return {
    ignored:false,provider:"paddle",eventId:text(event?.event_id),eventType:type,
    ownerId:text(custom.owner_id),planCode:text(custom.plan_code),paymentId:text(custom.payment_id),reference:text(custom.reference),
    providerCustomerId:text(data.customer_id),providerSubscriptionId:subscriptionId,
    providerTransactionId:text(data.id&&type.startsWith("transaction.")?data.id:(type.startsWith("adjustment.")?data.transaction_id:"")),
    adjustmentId:text(data.id&&type.startsWith("adjustment.")?data.id:""),
    adjustmentAction:text(data.action),adjustmentStatus:text(data.status),
    adjustmentAmount:text(data.totals?.total)||null,adjustmentCurrency:text(data.currency_code).toUpperCase()||null,
    status:statusMap[type],currency:text(data.currency_code).toUpperCase(),
    providerPriceId:text(lineItems[0]?.price_id||data.items?.[0]?.price?.id),
    amountMinor:Number.isSafeInteger(amountMinor)?amountMinor:null,
    totalPaidMinor:Number.isSafeInteger(totalPaidMinor)?totalPaidMinor:null,
    discountMinor:Number.isSafeInteger(discountMinor)?discountMinor:null,
    origin:text(data.origin),
    periodStart:text(period.starts_at)||null,periodEnd:text(period.ends_at)||null,
    cancelAtPeriodEnd:text(data.scheduled_change?.action).toLowerCase()==="cancel",
    occurredAt:text(event?.occurred_at)||null,rawEventType:type
  };
}

export function createPaddleSubscriptionProvider({
  apiKey=process.env.PADDLE_API_KEY,
  webhookSecret=process.env.PADDLE_WEBHOOK_SECRET,
  baseUrl=process.env.PADDLE_API_BASE_URL||"https://sandbox-api.paddle.com",
  allowLive=process.env.PADDLE_ALLOW_LIVE==="true",
  priceIds=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>key.startsWith("PADDLE_PRICE_ID_")&&value).map(([key,value])=>[key.slice("PADDLE_PRICE_ID_".length).toLowerCase(),value])),
  fetchImpl=globalThis.fetch,
  now=()=>Date.now()
}={}){
  const base=new URL(baseUrl);
  const sandbox=base.hostname==="sandbox-api.paddle.com";
  const live=base.hostname==="api.paddle.com";
  if(base.protocol!=="https:"||(!sandbox&&!live))throw fail("PADDLE_API_HOST_INVALID","Paddle API must use its documented sandbox or production HTTPS host.",500);
  if(live&&!allowLive)throw fail("PADDLE_LIVE_DISABLED","Live Paddle requests require PADDLE_ALLOW_LIVE=true.",500);
  if(!apiKey)throw fail("PADDLE_API_KEY_REQUIRED","Paddle API key is not configured.",500);
  if(typeof fetchImpl!=="function")throw fail("PAYMENT_FETCH_REQUIRED","A fetch implementation is required.",500);

  async function getPrice(priceId){
    const id=text(priceId);
    if(!/^pri_[A-Za-z0-9]+$/.test(id))throw fail("PADDLE_PRICE_ID_INVALID","A valid server-mapped Paddle price ID is required.");
    const result=await requestJson(fetchImpl,new URL("/prices/"+encodeURIComponent(id),base),{
      headers:{authorization:"Bearer "+apiKey}
    });
    const price=result?.data;
    if(!price?.id||price.id!==id)throw fail("PADDLE_PRICE_NOT_FOUND","The configured Paddle price could not be found.",404);
    return {
      id:price.id,status:text(price.status),
      amountMinor:Number(price.unit_price?.amount),
      currency:text(price.unit_price?.currency_code).toUpperCase(),
      interval:text(price.billing_cycle?.interval).toLowerCase(),
      frequency:Number(price.billing_cycle?.frequency||0)
    };
  }

  async function createCheckout({planCode,ownerId,email,returnUrl,paymentId,reference,priceId:reservedPriceId,expectedPrice,quantity=1}={}){
    const plan=text(planCode).toLowerCase(),owner=text(ownerId),customerEmail=text(email).toLowerCase();
    const priceId=text(priceIds[plan]);
    if(!/^[a-z][a-z0-9_-]{1,63}$/.test(plan)||!owner||!EMAIL.test(customerEmail)||!priceId||!/^pri_[A-Za-z0-9]+$/.test(priceId)||(reservedPriceId&&text(reservedPriceId)!==priceId))
      throw fail("PADDLE_CHECKOUT_INPUT_INVALID","A mapped Paddle price, owner, plan and valid customer email are required.");
    if(expectedPrice){
      const configured=await getPrice(priceId);
      const expectedInterval=String(expectedPrice.billingInterval||"").toLowerCase()==="yearly"?"year":"month";
      if(configured.status!=="active"||configured.amountMinor!==Number(expectedPrice.amountMinor)||
         configured.currency!==String(expectedPrice.currency||"").toUpperCase()||
         configured.interval!==expectedInterval||configured.frequency!==1)
        throw fail("PADDLE_PRICE_CONFIGURATION_MISMATCH","Paddle price must be active and match the server plan amount, currency and monthly/yearly billing interval.",409);
    }
    if(!Number.isInteger(quantity)||quantity!==1)throw fail("PADDLE_QUANTITY_INVALID","Subscription checkout quantity must be one.");
    const successUrl=text(returnUrl);
    if(successUrl){const url=new URL(successUrl);if(url.protocol!=="https:"&&!["localhost","127.0.0.1"].includes(url.hostname))throw fail("PADDLE_RETURN_URL_INVALID","Checkout return URL must use HTTPS.");}
    const result=await requestJson(fetchImpl,new URL("/transactions",base),{
      method:"POST",headers:{authorization:"Bearer "+apiKey},
      body:{
        items:[{price_id:priceId,quantity}],
        customer:{email:customerEmail},
        collection_mode:"automatic",
        checkout:{...(successUrl?{url:successUrl}:{})},
        custom_data:{owner_id:owner,plan_code:plan,payment_id:text(paymentId),reference:text(reference),product:"executive_visuals"}
      }
    });
    const transaction=result?.data;
    if(!transaction?.id||!transaction?.checkout?.url)throw fail("PADDLE_CHECKOUT_RESPONSE_INVALID","Paddle did not return a hosted checkout URL.",502);
    return {provider:"paddle",transactionId:transaction.id,checkoutUrl:transaction.checkout.url,status:transaction.status||"draft"};
  }

  async function createCustomerPortalSession({customerId,subscriptionId}={}){
    const customer=text(customerId),subscription=text(subscriptionId);
    if(!/^ctm_[a-z0-9]{26}$/.test(customer)||!/^sub_[a-z0-9]{26}$/.test(subscription))
      throw fail("PADDLE_PORTAL_INPUT_INVALID","A verified Paddle customer and subscription ID are required.");
    const result=await requestJson(fetchImpl,new URL("/customers/"+encodeURIComponent(customer)+"/portal-sessions",base),{
      method:"POST",headers:{authorization:"Bearer "+apiKey},
      body:{subscription_ids:[subscription]}
    });
    const urls=result?.data?.urls||{};
    const subscriptionUrls=Array.isArray(urls.subscriptions)?urls.subscriptions.find(item=>item.id===subscription):null;
    const portalUrl=text(subscriptionUrls?.view_subscription||urls.general?.overview);
    if(!/^https:\/\/customer-portal\.paddle\.com\//.test(portalUrl))
      throw fail("PADDLE_PORTAL_URL_MISSING","Paddle did not return a valid hosted customer portal URL.",502);
    return {portalUrl,cancelUrl:text(subscriptionUrls?.cancel_subscription)||null,
      paymentMethodUrl:text(subscriptionUrls?.update_subscription_payment_method)||null};
  }

  function verifyWebhook(rawBody,signature){
    if(!verifyPaddleSignature(rawBody,signature,webhookSecret,{now:now()}))throw fail("PADDLE_WEBHOOK_SIGNATURE_INVALID","Paddle webhook signature is invalid or expired.",401);
    let event;try{event=JSON.parse(rawBody.toString("utf8"));}catch{throw fail("PADDLE_WEBHOOK_JSON_INVALID","Paddle webhook body must be valid JSON.");}
    if(!text(event?.event_id)||!text(event?.event_type))throw fail("PADDLE_WEBHOOK_EVENT_INVALID","Paddle webhook event identity is missing.");
    return normalizePaddleEvent(event);
  }

  return Object.freeze({name:"paddle",environment:sandbox?"sandbox":"live",getPrice,createCheckout,createCustomerPortalSession,verifyWebhook});
}

export function createPesapalSubscriptionProvider({
  consumerKey=process.env.PESAPAL_CONSUMER_KEY,
  consumerSecret=process.env.PESAPAL_CONSUMER_SECRET,
  baseUrl=process.env.PESAPAL_API_BASE_URL||"https://cybqa.pesapal.com/pesapalv3",
  allowLive=process.env.PESAPAL_ALLOW_LIVE==="true",
  fetchImpl=globalThis.fetch,
  now=()=>Date.now()
}={}){
  const parsedBase=new URL(baseUrl);
  const base=new URL(parsedBase.href.endsWith("/")?parsedBase.href:parsedBase.href+"/");
  const sandbox=base.hostname==="cybqa.pesapal.com";
  const live=base.hostname==="pay.pesapal.com";
  if(base.protocol!=="https:"||(!sandbox&&!live))throw fail("PESAPAL_API_HOST_INVALID","Pesapal API must use its documented sandbox or production HTTPS host.",500);
  if(live&&!allowLive)throw fail("PESAPAL_LIVE_DISABLED","Live Pesapal requests require PESAPAL_ALLOW_LIVE=true.",500);
  if(!consumerKey||!consumerSecret)throw fail("PESAPAL_CREDENTIALS_REQUIRED","Pesapal consumer key and secret are not configured.",500);
  if(typeof fetchImpl!=="function")throw fail("PAYMENT_FETCH_REQUIRED","A fetch implementation is required.",500);
  let token=null,tokenExpiresAt=0;

  async function accessToken(){
    if(token&&tokenExpiresAt>now()+60000)return token;
    const result=await requestJson(fetchImpl,new URL("api/Auth/RequestToken",base),{
      method:"POST",body:{consumer_key:consumerKey,consumer_secret:consumerSecret}
    });
    if(!result?.token)throw fail("PESAPAL_AUTH_RESPONSE_INVALID","Pesapal did not return an access token.",502);
    token=result.token;tokenExpiresAt=now()+Math.max(60,Number(result.expiryDate?((Date.parse(result.expiryDate)-now())/1000):300))*1000;
    return token;
  }

  async function registerIpn(url){
    const callback=new URL(text(url));
    if(callback.protocol!=="https:")throw fail("PESAPAL_IPN_URL_INVALID","Pesapal IPN endpoint must use HTTPS.");
    const result=await requestJson(fetchImpl,new URL("api/URLSetup/RegisterIPN",base),{
      method:"POST",headers:{authorization:"Bearer "+await accessToken()},
      body:{url:callback.toString(),ipn_notification_type:"GET"}
    });
    if(!result?.ipn_id)throw fail("PESAPAL_IPN_REGISTRATION_FAILED","Pesapal did not return an IPN registration ID.",502);
    return {notificationId:result.ipn_id,url:result.url};
  }

  async function createCheckout({reference,description,amount,currency="UGX",email,firstName,lastName,phone,countryCode="UG",callbackUrl,notificationId,accountNumber,subscriptionDetails}={}){
    const orderRef=text(reference),mail=text(email).toLowerCase(),ccy=text(currency).toUpperCase(),value=Number(amount);
    if(!orderRef||orderRef.length>50||!EMAIL.test(mail)||!Number.isFinite(value)||value<=0||!/^[A-Z]{3}$/.test(ccy)||!text(callbackUrl)||!text(notificationId))
      throw fail("PESAPAL_CHECKOUT_INPUT_INVALID","A reference, valid customer email, positive amount, currency, callback URL and registered IPN are required.");
    const body={
      id:orderRef,currency:ccy,amount:value,description:text(description).slice(0,100),
      callback_url:text(callbackUrl),notification_id:text(notificationId),
      billing_address:{email_address:mail,phone_number:text(phone),country_code:text(countryCode).toUpperCase(),first_name:text(firstName),last_name:text(lastName)},
      ...(text(accountNumber)?{account_number:text(accountNumber)}:{})
    };
    if(subscriptionDetails){
      const {startDate,endDate,frequency}=subscriptionDetails;
      if(!/^\d{2}-\d{2}-\d{4}$/.test(text(startDate))||!/^\d{2}-\d{2}-\d{4}$/.test(text(endDate))||!["DAILY","WEEKLY","MONTHLY","YEARLY"].includes(text(frequency).toUpperCase()))
        throw fail("PESAPAL_SUBSCRIPTION_DETAILS_INVALID","Pesapal recurring payment requires valid dates and a supported frequency.");
      body.subscription_details={start_date:startDate,end_date:endDate,frequency:text(frequency).toUpperCase()};
    }
    const result=await requestJson(fetchImpl,new URL("api/Transactions/SubmitOrderRequest",base),{
      method:"POST",headers:{authorization:"Bearer "+await accessToken()},body
    });
    if(!result?.order_tracking_id||!result?.redirect_url)throw fail("PESAPAL_CHECKOUT_RESPONSE_INVALID","Pesapal did not return a tracking ID and hosted checkout URL.",502);
    return {provider:"pesapal",trackingId:result.order_tracking_id,merchantReference:orderRef,checkoutUrl:result.redirect_url,status:result.status||"pending"};
  }

  async function verifyNotification({trackingId,merchantReference,expectedAmount,expectedCurrency}={}){
    const tracking=text(trackingId),reference=text(merchantReference);
    if(!tracking||!reference)throw fail("PESAPAL_NOTIFICATION_INVALID","Pesapal tracking ID and merchant reference are required.");
    const url=new URL("api/Transactions/GetTransactionStatus",base);
    url.searchParams.set("orderTrackingId",tracking);
    const result=await requestJson(fetchImpl,url,{headers:{authorization:"Bearer "+await accessToken()}});
    const amount=Number(result?.amount),currency=text(result?.currency).toUpperCase();
    const completed=Number(result?.status_code)===1||text(result?.payment_status_description).toLowerCase()==="completed";
    if(text(result?.merchant_reference)!==reference||!completed||
      (expectedAmount!==undefined&&Math.abs(amount-Number(expectedAmount))>0.000001)||
      (expectedCurrency&&currency!==text(expectedCurrency).toUpperCase()))
      throw fail("PESAPAL_PAYMENT_NOT_VERIFIED","Pesapal transaction does not match the expected completed payment.",409);
    return {
      provider:"pesapal",eventId:tracking,eventType:"payment.completed",
      merchantReference:reference,trackingId:tracking,amount,currency,
      paymentMethod:text(result?.payment_method),confirmationCode:text(result?.confirmation_code),
      recurring:result?.subscription_transaction_info?{
        accountReference:text(result.subscription_transaction_info.account_reference),
        correlationId:text(result.subscription_transaction_info.correlation_id)
      }:null
    };
  }

  async function handleNotification(query,{expectedAmount,expectedCurrency}={}){
    const type=text(query?.OrderNotificationType).toUpperCase();
    if(!["IPNCHANGE","RECURRING"].includes(type))throw fail("PESAPAL_NOTIFICATION_TYPE_INVALID","Unsupported Pesapal IPN notification type.");
    const verified=await verifyNotification({
      trackingId:query?.OrderTrackingId,merchantReference:query?.OrderMerchantReference,
      expectedAmount,expectedCurrency
    });
    return {...verified,eventType:type==="RECURRING"?"recurring.payment.completed":"payment.completed",notificationType:type};
  }

  return Object.freeze({name:"pesapal",environment:sandbox?"sandbox":"live",accessToken,registerIpn,createCheckout,verifyNotification,handleNotification});
}

export function createSubscriptionPaymentProviders(options={}){
  return Object.freeze({
    paddle:createPaddleSubscriptionProvider(options.paddle||{}),
    pesapal:createPesapalSubscriptionProvider(options.pesapal||{})
  });
}
