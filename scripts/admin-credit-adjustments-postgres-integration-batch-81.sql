-- Batch 81: administrator credit adjustments preserve wallet and revenue provenance.do $batch81_seed$
declare
  v_admin constant uuid:='81818181-8181-4181-8181-818181818001';
  v_customer constant uuid:='81818181-8181-4181-8181-818181818002';
  v_regular constant uuid:='81818181-8181-4181-8181-818181818003';
  v_job constant uuid:='81818181-8181-4181-8181-818181818005';
  v_reservation uuid;
begin
  insert into auth.users(id,email) values
    (v_admin,'batch81-admin@example.invalid'),
    (v_customer,'batch81-customer@example.invalid'),
    (v_regular,'batch81-regular@example.invalid')
  on conflict(id) do nothing;
  insert into executive_visuals.platform_admins(user_id,role,reason)
    values(v_admin,'billing_admin','Batch 81 disposable PostgreSQL integration')
  on conflict(user_id) do update set role=excluded.role,reason=excluded.reason;

  insert into executive_visuals.billing_credit_accounts(owner_id)
    values(v_customer) on conflict(owner_id) do nothing;
  insert into executive_visuals.jobs(id,owner_id,job_type)
    values(v_job,v_customer,'video.generate') on conflict(id) do nothing;
end
$batch81_seed$;

do $batch81_verify$
declare
  v_admin constant uuid:='81818181-8181-4181-8181-818181818001';
  v_customer constant uuid:='81818181-8181-4181-8181-818181818002';
  v_regular constant uuid:='81818181-8181-4181-8181-818181818003';
  v_job constant uuid:='81818181-8181-4181-8181-818181818005';
  v_result jsonb;
  v_replay jsonb;
  v_ledger_id uuid;
  v_source_count bigint;
  v_audit_count bigint;
  v_balance bigint;
  v_reservation uuid;
begin
  v_result:=executive_visuals.apply_admin_credit_adjustment(
    v_admin,v_customer,1000,'batch81-positive-0001',
    'Initial support compensation for integration'
  );
  if v_result->>'deltaCredits'<>'1000' or (v_result->>'balanceAfter')::bigint<>1000 then
    raise exception 'Positive administrator compensation did not grant the expected balance: %',v_result;
  end if;

  select ledger_id into v_ledger_id
    from executive_visuals.billing_credit_admin_adjustments
   where id=(v_result->>'adjustmentId')::uuid;
  select count(*) into v_source_count
    from executive_visuals.billing_credit_revenue_sources
   where grant_ledger_id=v_ledger_id and source_type='admin_compensation'
     and revenue_status='non_revenue' and allocatable_revenue_minor=0;
  if v_source_count<>1 then
    raise exception 'Admin compensation must be classified as zero-revenue provenance';
  end if;

  select reservation_id into v_reservation
    from executive_visuals.reserve_generation_credits(
      v_customer,v_job,200,'batch81-active-reservation'
    );
  if v_reservation is null then raise exception 'Generation reservation was not created'; end if;

  begin
    perform executive_visuals.apply_admin_credit_adjustment(
      v_admin,v_customer,-801,'batch81-excessive-debit',
      'Debit must not consume reserved credits'
    );
    raise exception 'Administrator debit consumed credits reserved for active generation';
  exception when sqlstate '23514' then
    if sqlerrm not like '%ADMIN_CREDIT_ADJUSTMENT_EXCEEDS_AVAILABLE_BALANCE%' then raise; end if;
  end;

  v_result:=executive_visuals.apply_admin_credit_adjustment(
    v_admin,v_customer,-800,'batch81-negative-0001',
    'Approved correction after reservation review'
  );
  if v_result->>'deltaCredits'<>'-800' or (v_result->>'balanceAfter')::bigint<>0 then
    raise exception 'Administrator debit did not preserve the reserved balance: %',v_result;
  end if;

  v_replay:=executive_visuals.apply_admin_credit_adjustment(
    v_admin,v_customer,-800,'batch81-negative-0001',
    'Approved correction after reservation review'
  );
  if coalesce((v_replay->>'idempotentReplay')::boolean,false) is not true then
    raise exception 'Repeated adjustment was not idempotent';
  end if;

  begin
    perform executive_visuals.apply_admin_credit_adjustment(
      v_regular,v_customer,50,'batch81-nonadmin-0001',
      'Non-admin must not adjust credits'
    );
    raise exception 'Non-administrator was allowed to adjust credits';
  exception when sqlstate '42501' then
    if sqlerrm not like '%FINANCIAL_ADMIN_REQUIRED%' then raise; end if;
  end;

  select coalesce(sum(amount),0)::bigint into v_balance
    from executive_visuals.billing_credit_ledger where owner_id=v_customer;
  if v_balance<>0 then raise exception 'Unexpected final wallet balance after fully spending only unreserved credits: %',v_balance; end if;
  select count(*) into v_audit_count
    from executive_visuals.billing_credit_admin_adjustments where owner_id=v_customer;
  if v_audit_count<>2 then raise exception 'Expected exactly two durable adjustment audit records, got %',v_audit_count; end if;
  select count(*) into v_source_count
    from executive_visuals.billing_credit_revenue_sources s
    join executive_visuals.billing_credit_ledger l on l.id=s.grant_ledger_id
   where s.owner_id=v_customer and s.source_type='admin_compensation'
     and s.revenue_status='non_revenue' and l.id=v_ledger_id;
  if v_source_count<>1 then raise exception 'Positive adjustment created duplicate or incorrect revenue provenance'; end if;

  v_result:=executive_visuals.list_admin_credit_adjustments(v_admin,v_customer,25);
  if jsonb_array_length(v_result)<>2 then raise exception 'Admin adjustment history did not return both audit records'; end if;
end
$batch81_verify$;
reset role;
