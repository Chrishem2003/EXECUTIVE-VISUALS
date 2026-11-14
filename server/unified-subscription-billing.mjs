const fail=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const text=value=>String(value??"").trim();
const PROVIDERS=new Set(["paddle","pesapal"]);

export function createUnifiedSubscriptionBilling({providers,repository}={}){
  if(!providers?.paddle||!providers?.pesapal)throw new Error("Paddle and Pesapal providers are required.");
  const required=["reserveCheckout","getCheckout","attachProviderCheckout","markCheckoutUncertain","applyProviderEvent","findPendingPesapalPayment"];
  for(const method of required)if(typeof repository?.[method]!=="function")throw new Error("Subscription repository must implement "+method+".");

  async function createCheckout({provider,ownerId,planCode,email,idempotencyKey,returnUrl,pesapalOrder}={}){
    const selected=text(provider).toLowerCase(),owner=text(ownerId),plan=text(planCode).toLowerCase(),key=text(idempotencyKey),customerEmail=text(email).toLowerCase();
    if(!PROVIDERS.has(selected)||!owner||!plan||!key||key.length<8||key.length>180||!customerEmail)
      throw fail("SUBSCRIPTION_CHECKOUT_INPUT_INVALID","A supported provider, authenticated owner, plan, email and idempotency key are required.");
    const reservation=await repository.reserveCheckout({provider:selected,ownerId:owner,planCode:plan,email:customerEmail,idempotencyKey:key});
    const reference=text(reservation?.reference||reservation?.txRef);
    if(!reservation?.paymentId||!reservation?.subscriptionId||!reference)
      throw fail("SUBSCRIPTION_RESERVATION_INVALID","The subscription ledger did not reserve a pending payment.");
    if(reservation.idempotentReplay){
      const existing=await repository.getCheckout({paymentId:reservation.paymentId,ownerId:owner});
      if(!existing)throw fail("SUBSCRIPTION_CHECKOUT_REPLAY_UNAVAILABLE","The original checkout is being reconciled; do not create another charge.",409);
      return {...existing,idempotentReplay:true};
    }
    try{
      let checkout;
      if(selected==="paddle"){
        checkout=await providers.paddle.createCheckout({planCode:plan,ownerId:owner,email:customerEmail,returnUrl,paymentId:reservation.paymentId,reference,priceId:reservation.providerPriceId});
      }else{
        const order=pesapalOrder||{};
        checkout=await providers.pesapal.createCheckout({
          ...order,reference,amount:reservation.amountMajor,
          currency:reservation.currency,email:customerEmail
        });
      }
      await repository.attachProviderCheckout({
        ownerId:owner,paymentId:reservation.paymentId,subscriptionId:reservation.subscriptionId,
        provider:selected,providerCheckout:checkout
      });
      return {paymentId:reservation.paymentId,subscriptionId:reservation.subscriptionId,reference,provider:selected,...checkout,idempotentReplay:false};
    }catch(error){
      await repository.markCheckoutUncertain({
        ownerId:owner,paymentId:reservation.paymentId,subscriptionId:reservation.subscriptionId,
        provider:selected,errorCode:error?.code||"PROVIDER_RESULT_UNCERTAIN"
      }).catch(()=>{});
      throw fail("SUBSCRIPTION_CHECKOUT_UNCERTAIN","Checkout could not be confirmed. The pending reservation was retained for reconciliation; do not retry with a new idempotency key.",202);
    }
  }

  async function handlePaddleWebhook({rawBody,signature}={}){
    const event=providers.paddle.verifyWebhook(rawBody,signature);
    if(event.ignored)return {received:true,ignored:true,eventId:event.eventId||null};
    if(!event.eventId||!event.ownerId||!event.planCode||(event.eventType==="transaction.completed"&&(!event.paymentId||!event.reference)))
      throw fail("PADDLE_EVENT_REQUIRES_REVIEW","Verified Paddle event lacks the application owner or plan mapping.",202);
    const result=await repository.applyProviderEvent({provider:"paddle",event});
    return {received:true,provider:"paddle",eventId:event.eventId,...result};
  }

  async function handlePesapalNotification(query={}){
    const reference=text(query.OrderMerchantReference);
    if(!reference)throw fail("PESAPAL_REFERENCE_MISSING","Pesapal notification has no merchant reference.");
    const pending=await repository.findPendingPesapalPayment({merchantReference:reference});
    if(!pending)throw fail("PESAPAL_PAYMENT_NOT_FOUND","No pending Pesapal payment matches this merchant reference.",404);
    const event=await providers.pesapal.handleNotification(query,{
      expectedAmount:pending.amountMajor,expectedCurrency:pending.currency
    });
    const result=await repository.applyProviderEvent({provider:"pesapal",event,paymentId:pending.paymentId,subscriptionId:pending.subscriptionId,ownerId:pending.ownerId});
    return {received:true,provider:"pesapal",eventId:event.eventId,...result};
  }

  return Object.freeze({createCheckout,handlePaddleWebhook,handlePesapalNotification});
}
