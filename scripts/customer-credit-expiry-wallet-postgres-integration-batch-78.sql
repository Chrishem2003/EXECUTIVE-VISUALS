-- Batch 78: expire only unused subscription allowance credits after open work settles.
reset role;
do $batch78_seed$
declare
  v_owner constant uuid:='77777777-7777-4777-8777-777777777701';
  v_job constant uuid:='78787878-7878-4787-8787-787878787801';
  v_job_after_expiry constant uuid:='78787878-7878-4787-8787-787878787802';
  v_source uuid;
  v_reservation uuid;
  v_expiry_count bigint;
  v_expired bigint;
  v_balance bigint;
  v_wallet jsonb;
  v_result jsonb;
begin
  select id into v_source
    from executive_visuals.billing_credit_revenue_sources
   where owner_id=v_owner and source_type='subscription_allowance'
   order by created_at desc limit 1;
  if v_source is null then raise exception 'Batch 77 subscription source missing'; end if;

  if (select expires_at from executive_visuals.billing_credit_revenue_sources where id=v_source)
       is distinct from '2027-01-01T00:00:00Z'::timestamptz then
    raise exception 'Subscription source did not inherit its verified period end';
  end if;

  insert into executive_visuals.jobs(id,owner_id,job_type)
  values(v_job,v_owner,'video.generate'),(v_job_after_expiry,v_owner,'video.generate')
  on conflict(id) do nothing;

  select reservation_id into v_reservation
    from executive_visuals.reserve_generation_credits(v_owner,v_job,25,'batch78-open-reservation');

  -- Make the paid period due while the first generation job is still reserved.
  update executive_visuals.billing_credit_revenue_sources
     set expires_at='2026-11-22T00:00:00Z'
   where id=v_source;

  v_result:=executive_visuals.expire_due_subscription_credits(v_owner,'2027-01-01T00:00:00Z');
  if (v_result->>'accountsDeferredForOpenReservations')::bigint<>1
     or (v_result->>'creditsExpired')::bigint<>0 then
    raise exception 'Expiry must defer while a generation reservation remains open';
  end if;

  begin
    perform * from executive_visuals.reserve_generation_credits(v_owner,v_job_after_expiry,1,'batch78-blocked-during-deferred-expiry');
    raise exception 'New work must not spend subscription credits awaiting expiry';
  exception when others then
    if sqlerrm not like '%BILLING_CREDIT_EXPIRY_DEFERRED_OPEN_RESERVATION%' then raise; end if;
  end;

  perform * from executive_visuals.settle_generation_credit_reservation(
    v_reservation,20,
    '{"provider":"runway","evidenceType":"provider_invoice","evidenceId":"batch78-settled-job"}'
  );

  v_result:=executive_visuals.expire_due_subscription_credits(v_owner,'2027-01-01T00:00:00Z');
  if (v_result->>'sourcesExpired')::bigint<>1
     or (v_result->>'creditsExpired')::bigint<>55 then
    raise exception 'Expected only 55 unconsumed subscription credits to expire: %',v_result;
  end if;

  select credits_expired into v_expired
    from executive_visuals.billing_credit_source_expirations where source_id=v_source;
  if v_expired<>55 then raise exception 'Incorrect expired source remainder: %',v_expired; end if;

  if not exists(select 1 from executive_visuals.billing_credit_ledger
    where owner_id=v_owner and event_type='expiry' and amount=-55
      and idempotency_key='credit-expiry:'||v_source::text) then
    raise exception 'Append-only wallet expiry debit missing';
  end if;

  select coalesce(sum(amount),0) into v_balance
    from executive_visuals.billing_credit_ledger where owner_id=v_owner;
  if v_balance<>0 then raise exception 'Expected zero available balance after expiry; got %',v_balance; end if;

  v_result:=executive_visuals.expire_due_subscription_credits(v_owner,'2027-01-02T00:00:00Z');
  if (v_result->>'sourcesExpired')::bigint<>0 or (v_result->>'creditsExpired')::bigint<>0 then
    raise exception 'Repeated expiry sweep must be idempotent';
  end if;

  v_wallet:=executive_visuals.get_customer_credit_wallet(v_owner);
  if (v_wallet->>'availableCredits')::bigint<>0
     or (v_wallet->>'consumedCredits')::bigint<>20
     or jsonb_array_length(v_wallet->'recentTransactions')<3 then
    raise exception 'Customer wallet summary does not reconcile: %',v_wallet;
  end if;

  begin
    perform * from executive_visuals.reserve_generation_credits(v_owner,v_job_after_expiry,1,'batch78-after-expiry');
    raise exception 'Expired credits were incorrectly spendable';
  exception when others then
    if sqlerrm not like '%BILLING_INSUFFICIENT_CREDITS%' then raise; end if;
  end;

  if exists(select 1 from executive_visuals.billing_credit_revenue_sources
    where source_type='paid_credit_pack' and expires_at is not null) then
    raise exception 'Purchased credit packs must remain non-expiring';
  end if;
end
$batch78_seed$;
reset role;
