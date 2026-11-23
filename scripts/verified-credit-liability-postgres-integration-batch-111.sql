-- Batch 111: deferred value and unused credit liability must remain separate.
reset role;
do $batch111_seed$
declare
  v_owner constant uuid:='71717171-7171-4171-8171-717171717171';
  v_payment constant uuid:='71717171-7171-4171-8171-717171717203';
  v_old_grant uuid;
  v_grant uuid;
begin
  insert into executive_visuals.payment_transactions(
    id,owner_id,provider,provider_transaction_id,tx_ref,amount_minor,currency,status,
    payment_method,customer_email,description,paid_at,verified_at,metadata
  ) values(
    v_payment,v_owner,'pesapal','batch111-provider-paid','batch111-paid-ref',2000,'USD','successful',
    'hosted_checkout','batch71-owner@example.invalid','Unused verified credit pack',
    '2026-11-23T09:00:00Z','2026-11-23T09:00:00Z',
    '{"payment_purpose":"credit_pack_purchase","credit_pack_applied":true}'
  ) on conflict(id) do nothing;
  insert into executive_visuals.credit_ledger(
    owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,reason,metadata
  ) values(
    v_owner,'purchase_grant',200,'batch111-old-ledger-paid',v_payment,'Unused verified paid credit pack','{}'
  ) returning id into v_old_grant;
  select id into v_grant from executive_visuals.billing_credit_ledger
   where idempotency_key='payment-credit-ledger:'||v_old_grant::text;
  if v_grant is null then raise exception 'Batch 111 test paid-credit grant was not mirrored'; end if;
  perform executive_visuals.register_generation_credit_revenue_source(
    v_owner,v_grant,'paid_credit_pack',v_payment,2000,'USD',
    '{"evidenceType":"verified_provider_payment","batch":111}'
  );
end
$batch111_seed$;

set role service_role;
do $batch111_verify$
declare
  v_owner constant uuid:='71717171-7171-4171-8171-717171717171';
  v_report jsonb;
  v_usd jsonb;
  v_unpriced jsonb;
begin
  v_report:=executive_visuals.financial_credit_liability_report(v_owner,null);
  select value into v_usd
    from jsonb_array_elements(v_report->'byCurrency')
    where value->>'currency'='USD';
  if v_usd is null then
    raise exception 'Batch 111 did not return the verified USD credit source';
  end if;
  if (v_usd->>'recognizedRevenueMinor')::bigint<>1000
     or (v_usd->>'deferredRevenueLiabilityMinor')::bigint<>2000 then
    raise exception 'Batch 111 must distinguish earned revenue from deferred paid-credit value: %',v_usd;
  end if;
  if (v_usd->>'creditsGranted')::bigint<>350
     or (v_usd->>'creditsConsumed')::bigint<>130
     or (v_usd->>'creditsRemaining')::bigint<>220 then
    raise exception 'Batch 111 credit unit totals are inconsistent: %',v_usd;
  end if;
  if (v_usd->>'pendingSubscriptionSplitCredits')::bigint<>20
     or (v_usd->>'unattributedCredits')::bigint<>0 then
    raise exception 'Pending subscription value must remain unpriced and separate: %',v_usd;
  end if;
  v_unpriced:=v_report->'unpriced';
  if (v_unpriced->>'pending_split_credits')::bigint<>20
     or (v_unpriced->>'unattributed_credits')::bigint<>5 then
    raise exception 'Batch 111 must surface pending and unattributed credits outside currency totals: %',v_unpriced;
  end if;
  if (v_usd->>'integrityExceptionSources')::integer<>0 then
    raise exception 'Unexpected source integrity exception: %',v_usd;
  end if;
  if v_report->'limitations' is null then
    raise exception 'Batch 111 must disclose report limitations';
  end if;
end
$batch111_verify$;
reset role;
