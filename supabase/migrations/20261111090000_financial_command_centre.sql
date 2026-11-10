-- Batch 12: financial command-centre aggregates, settlement records and immutable admin audit.
-- Apply only after the complete preceding billing migration chain in isolated Supabase staging.
create or replace function executive_visuals.financial_currency_factor(p_currency text)
returns integer language sql immutable strict
set search_path=pg_catalog as $
 select case
  when upper(p_currency) in ('BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF') then 1
  when upper(p_currency) in ('BHD','IQD','JOD','KWD','LYD','OMR','TND') then 1000
  else 100
 end
$;

create table if not exists executive_visuals.financial_admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  actor_role text not null check (actor_role in ('owner','platform_admin','billing_admin')),
  action text not null check (action ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  resource_type text not null check (char_length(resource_type) between 2 and 80),
  resource_id text,
  reason text not null check (char_length(reason) between 3 and 500),
  request_id text,
  ip_fingerprint text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now()
);
create index if not exists financial_admin_audit_created_idx
  on executive_visuals.financial_admin_audit(created_at desc);
create index if not exists financial_admin_audit_actor_idx
  on executive_visuals.financial_admin_audit(actor_id,created_at desc);

create table if not exists executive_visuals.flutterwave_settlement_records (
  id uuid primary key default gen_random_uuid(),
  provider_settlement_id text not null unique,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  gross_amount_minor bigint not null check (gross_amount_minor >= 0),
  net_amount_minor bigint not null check (net_amount_minor >= 0),
  fee_amount_minor bigint not null check (fee_amount_minor >= 0),
  refund_amount_minor bigint not null default 0 check (refund_amount_minor >= 0),
  chargeback_amount_minor bigint not null default 0 check (chargeback_amount_minor >= 0),
  provider_status text not null,
  destination text,
  due_at timestamptz,
  settled_at timestamptz,
  charge_count integer not null default 0 check (charge_count >= 0),
  provider_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_payload)='object'),
  last_reconciled_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists flutterwave_settlement_currency_date_idx
  on executive_visuals.flutterwave_settlement_records(currency,settled_at desc);

create table if not exists executive_visuals.financial_reconciliation_exceptions (
  id uuid primary key default gen_random_uuid(),
  settlement_record_id uuid references executive_visuals.flutterwave_settlement_records(id) on delete restrict,
  provider_settlement_id text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  exception_code text not null,
  expected_minor bigint,
  actual_minor bigint,
  status text not null default 'open' check (status in ('open','investigating','resolved','accepted_difference')),
  resolution_reason text,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists financial_reconciliation_exceptions_open_idx
  on executive_visuals.financial_reconciliation_exceptions(status,created_at desc);

alter table executive_visuals.financial_admin_audit enable row level security;
alter table executive_visuals.flutterwave_settlement_records enable row level security;
alter table executive_visuals.financial_reconciliation_exceptions enable row level security;
revoke all on executive_visuals.financial_admin_audit,
 executive_visuals.flutterwave_settlement_records,
 executive_visuals.financial_reconciliation_exceptions from anon,authenticated;
grant all on executive_visuals.financial_admin_audit,
 executive_visuals.flutterwave_settlement_records,
 executive_visuals.financial_reconciliation_exceptions to service_role;
-- Service role may append audit events only; it cannot rewrite or truncate history.
revoke update,delete,truncate on executive_visuals.financial_admin_audit from service_role;

-- Audit rows are append-only, including for the service role.
create or replace function executive_visuals.reject_financial_audit_mutation()
returns trigger language plpgsql set search_path=pg_catalog,executive_visuals as $$
begin
 raise exception 'Financial audit records are append-only' using errcode='42501';
end $$;
drop trigger if exists financial_admin_audit_immutable on executive_visuals.financial_admin_audit;
create trigger financial_admin_audit_immutable
 before update or delete on executive_visuals.financial_admin_audit
 for each row execute function executive_visuals.reject_financial_audit_mutation();

create or replace function executive_visuals.admin_financial_command_centre(
 p_actor_id uuid,
 p_from timestamptz default now()-interval '30 days',
 p_to timestamptz default now(),
 p_limit integer default 100
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare actor_role text; result jsonb;
begin
 select role into actor_role from platform_admins where user_id=p_actor_id;
 if coalesce(actor_role,'') not in ('owner','platform_admin','billing_admin') then
  raise exception 'Finance administrator role required' using errcode='42501';
 end if;
 if p_from is null or p_to is null or p_to<=p_from or p_to>now()+interval '1 day'
   or p_limit not between 1 and 200 then
  raise exception 'Invalid reporting period or limit' using errcode='22023';
 end if;
 with payments as (
  select * from payment_transactions where status='successful' and coalesce(paid_at,created_at)<=p_to
 ),
 refunds as (
  select r.* from payment_refunds r where r.status='succeeded' and r.completed_at<=p_to
 ),
 currency_rows as (
  select c.currency,
   coalesce((select sum(p.amount_minor) from payments p where p.currency=c.currency and coalesce(p.paid_at,p.created_at) between p_from and p_to),0) gross_minor,
   coalesce((select sum(p.provider_fee_minor) from payments p where p.currency=c.currency and coalesce(p.paid_at,p.created_at) between p_from and p_to),0) fees_minor,
   coalesce((select sum(r.amount_minor) from refunds r where r.currency=c.currency and r.completed_at between p_from and p_to),0) refunds_minor,
   (select count(*) from payments p where p.currency=c.currency and coalesce(p.paid_at,p.created_at) between p_from and p_to) successful_count,
   (select count(*) from payment_transactions p where p.currency=c.currency and p.status='failed' and p.created_at between p_from and p_to) failed_count
  from (select currency from payment_transactions union select currency from payment_refunds union select currency from customer_subscriptions) c
 ),
 mrr_rows as (
  select s.currency, sum(case when s.billing_interval='monthly' then s.amount_minor when s.billing_interval='yearly' then round(s.amount_minor::numeric/12)::bigint else 0 end)::bigint mrr_minor,
   count(*) filter(where s.amount_minor>0) paid_subscribers
  from customer_subscriptions s
  where s.status in ('active','past_due') and s.billing_interval in ('monthly','yearly') and s.current_period_start<=p_to
   and (s.current_period_end is null or s.current_period_end>p_to)
  group by s.currency
 ),
 tiers as (
  select s.currency,s.plan_code,coalesce(pl.name,s.plan_code) plan_name,
   count(*) filter(where s.status in ('active','past_due') and (s.current_period_end is null or s.current_period_end>p_to)) active_subscriptions,
   sum(case when s.status in ('active','past_due') and (s.current_period_end is null or s.current_period_end>p_to)
    then case when s.billing_interval='monthly' then s.amount_minor when s.billing_interval='yearly' then round(s.amount_minor::numeric/12)::bigint else 0 end else 0 end)::bigint mrr_minor
  from customer_subscriptions s left join subscription_plans pl on pl.plan_code=s.plan_code
  group by s.currency,s.plan_code,pl.name
 ),
 clv as (
  select p.owner_id,p.currency,sum(p.amount_minor)-coalesce((select sum(r.amount_minor) from refunds r where r.owner_id=p.owner_id and r.currency=p.currency),0) realized_minor
  from payments p group by p.owner_id,p.currency
 ),
 profiles as (
  select p.owner_id,p.currency,max(p.customer_email) email,
   (select s.status from customer_subscriptions s where s.owner_id=p.owner_id order by s.created_at desc limit 1) subscription_status,
   (select s.plan_code from customer_subscriptions s where s.owner_id=p.owner_id order by s.created_at desc limit 1) plan_code,
   (select s.current_period_end from customer_subscriptions s where s.owner_id=p.owner_id order by s.created_at desc limit 1) period_end,
   count(distinct p.id) payment_count,
   coalesce(sum(p.amount_minor) filter(where p.status='successful'),0) gross_paid_minor,
   coalesce((select sum(r.amount_minor) from payment_refunds r where r.owner_id=p.owner_id and r.currency=p.currency and r.status='succeeded'),0) refunded_minor
  from payment_transactions p
  group by p.owner_id,p.currency
 ),
 fraud as (
  select p.owner_id,p.currency,
   count(*) filter(where p.status='failed' and p.created_at>now()-interval '24 hours') failed_24h,
   count(*) filter(where p.status='successful' and p.created_at>now()-interval '24 hours') successful_24h,
   coalesce((select count(*) from payment_refunds r where r.owner_id=p.owner_id and r.status in ('requested','processing','succeeded') and r.created_at>now()-interval '30 days'),0) refund_cases_30d,
   coalesce((select sum(r.amount_minor) from payment_refunds r where r.owner_id=p.owner_id and r.currency=p.currency and r.status in ('requested','processing','succeeded') and r.created_at>now()-interval '30 days'),0) refund_value_30d,
   coalesce(sum(p.amount_minor) filter(where p.status='successful' and p.created_at>now()-interval '30 days'),0) gross_value_30d,
   coalesce((select count(*) from chargeback_cases cb where cb.owner_id=p.owner_id and cb.status in ('open','under_review','lost')),0) dispute_cases
  from payment_transactions p group by p.owner_id,p.currency
 )
 select jsonb_build_object(
  'period',jsonb_build_object('from',p_from,'to',p_to),
  'byCurrency',coalesce((select jsonb_agg(jsonb_build_object(
    'currency',c.currency,'grossRevenueMinor',c.gross_minor,'providerFeesMinor',c.fees_minor,
    'refundsMinor',c.refunds_minor,'netRevenueMinor',c.gross_minor-c.refunds_minor,
    'successfulPayments',c.successful_count,'failedPayments',c.failed_count,
    'mrrMinor',coalesce(m.mrr_minor,0),'arrMinor',coalesce(m.mrr_minor,0)*12,
    'paidSubscribers',coalesce(m.paid_subscribers,0)
  )) from currency_rows c left join mrr_rows m using(currency)),'[]'::jsonb),
  'tiers',coalesce((select jsonb_agg(to_jsonb(t)) from tiers t),'[]'::jsonb),
  'customerProfiles',coalesce((select jsonb_agg(jsonb_build_object(
    'ownerId',pr.owner_id,'email',pr.email,'currency',pr.currency,'subscriptionStatus',pr.subscription_status,
    'planCode',pr.plan_code,'periodEnd',pr.period_end,'paymentCount',pr.payment_count,
    'grossPaidMinor',pr.gross_paid_minor,'refundedMinor',pr.refunded_minor,
    'realizedLifetimeValueMinor',pr.gross_paid_minor-pr.refunded_minor
  )) from (select * from profiles order by gross_paid_minor desc limit p_limit) pr),'[]'::jsonb),
  'riskIndicators',coalesce((select jsonb_agg(jsonb_build_object(
    'ownerId',f.owner_id,'currency',f.currency,'failedPayments24h',f.failed_24h,
    'successfulPayments24h',f.successful_24h,'refundCases30d',f.refund_cases_30d,
    'disputeCases',f.dispute_cases,
    'signals',to_jsonb(array_remove(array[
      case when f.failed_24h>=3 then 'multiple_failed_payments_24h' end,
      case when f.refund_cases_30d>=3 then 'repeated_refunds_30d' end,
      case when f.successful_24h>=10 then 'rapid_successful_payments_24h' end,
      case when f.gross_value_30d>0 and f.refund_value_30d*2>=f.gross_value_30d then 'high_refund_value_ratio_30d' end,
      case when f.dispute_cases>0 then 'open_or_lost_dispute' end
    ],null))
  )) from fraud f where f.failed_24h>=3 or f.refund_cases_30d>=3 or f.successful_24h>=10
    or (f.gross_value_30d>0 and f.refund_value_30d*2>=f.gross_value_30d) or f.dispute_cases>0 limit p_limit),'[]'::jsonb),
  'failedPaymentRecovery',jsonb_build_object(
    'openAttempts',(select count(*) from payment_attempts where status in ('failed','retry_scheduled','exhausted') and created_at between p_from and p_to),
    'scheduledRetries',(select count(*) from payment_attempts where status='retry_scheduled' and created_at between p_from and p_to),
    'exhausted',(select count(*) from payment_attempts where status='exhausted' and created_at between p_from and p_to),
    'recovered',(select count(*) from payment_attempts where status='succeeded' and updated_at between p_from and p_to)
  ),
  'refunds',jsonb_build_object('pending',(select count(*) from payment_refunds where status in ('requested','processing')),
   'succeeded',(select count(*) from payment_refunds where status='succeeded' and completed_at between p_from and p_to)),
  'chargebacks',jsonb_build_object('open',(select count(*) from chargeback_cases where status in ('open','under_review')),
   'exposure',coalesce((select jsonb_agg(jsonb_build_object('currency',currency,'amountMinor',sum_minor)) from
    (select currency,sum(amount_minor) sum_minor from chargeback_cases where status in ('open','under_review') group by currency) x),'[]'::jsonb)),
  'refundQueue',coalesce((select jsonb_agg(jsonb_build_object(
   'id',r.id,'ownerId',r.owner_id,'paymentTransactionId',r.payment_transaction_id,
   'amountMinor',r.amount_minor,'currency',r.currency,'status',r.status,'reason',r.reason,'requestedAt',r.requested_at
  )) from (select * from payment_refunds where status in ('requested','processing') order by requested_at asc limit p_limit) r),'[]'::jsonb),
  'chargebackCases',coalesce((select jsonb_agg(jsonb_build_object(
   'id',cb.id,'ownerId',cb.owner_id,'providerCaseId',cb.provider_case_id,'amountMinor',cb.amount_minor,
   'currency',cb.currency,'status',cb.status,'stage',cb.stage,'responseDueAt',cb.response_due_at
  )) from (select * from chargeback_cases where status in ('open','under_review','lost') order by response_due_at asc nulls last limit p_limit) cb),'[]'::jsonb),
  'failedPaymentQueue',coalesce((select jsonb_agg(jsonb_build_object(
   'id',a.id,'ownerId',a.owner_id,'paymentTransactionId',a.payment_transaction_id,
   'amountMinor',a.amount_minor,'currency',a.currency,'status',a.status,'failureCode',a.failure_code,
   'attemptNumber',a.attempt_number,'nextRetryAt',a.next_retry_at,'createdAt',a.created_at
  )) from (select * from payment_attempts where status in ('failed','retry_scheduled','exhausted') order by created_at desc limit p_limit) a),'[]'::jsonb),
  'settlementExceptions',(select count(*) from financial_reconciliation_exceptions where status='open'),
  'dataQuality',jsonb_build_object('mrrIsRunRateNotCash','true','clvIsRealizedHistoricalValue','true','currenciesAreNeverAggregated','true')
 ) into result;
 return result;
end $$;
revoke all on function executive_visuals.admin_financial_command_centre(uuid,timestamptz,timestamptz,integer) from public,anon,authenticated;
grant execute on function executive_visuals.admin_financial_command_centre(uuid,timestamptz,timestamptz,integer) to service_role;

create or replace function executive_visuals.record_flutterwave_settlement(
 p_actor_id uuid,p_settlement jsonb,p_expected_gross_minor bigint,p_expected_fees_minor bigint
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals as $$
declare actor_role text; sid text; cur text; gross bigint; net bigint; fees bigint; refunds bigint; chargebacks bigint; rec_id uuid; issues jsonb:='[]'::jsonb;
begin
 select role into actor_role from platform_admins where user_id=p_actor_id;
 if coalesce(actor_role,'') not in ('owner','platform_admin','billing_admin') then raise exception 'Finance administrator role required' using errcode='42501'; end if;
 sid:=p_settlement->>'id'; cur:=upper(p_settlement->>'currency');
 if sid is null or cur !~ '^[A-Z]{3}$' then raise exception 'Settlement identity or currency invalid' using errcode='22023'; end if;
 gross:=round(coalesce((p_settlement->>'gross_amount')::numeric,0)*executive_visuals.financial_currency_factor(cur));
 net:=round(coalesce((p_settlement->>'net_amount')::numeric,0)*case when cur in ('UGX','JPY','KRW') then 1 else 100 end);
 fees:=round(coalesce((select sum((x->>'amount')::numeric) from jsonb_array_elements(coalesce(p_settlement->'fees','[]'::jsonb)) x),0)*case when cur in ('UGX','JPY','KRW') then 1 else 100 end);
 refunds:=round(coalesce((p_settlement->>'refund')::numeric,0)*case when cur in ('UGX','JPY','KRW') then 1 else 100 end);
 chargebacks:=round(coalesce((p_settlement->>'chargeback')::numeric,0)*case when cur in ('UGX','JPY','KRW') then 1 else 100 end);
 insert into flutterwave_settlement_records(provider_settlement_id,currency,gross_amount_minor,net_amount_minor,fee_amount_minor,refund_amount_minor,chargeback_amount_minor,provider_status,destination,due_at,settled_at,charge_count,provider_payload,last_reconciled_at)
 values(sid,cur,gross,net,fees,refunds,chargebacks,coalesce(p_settlement->>'status','unknown'),p_settlement->>'destination',
  nullif(p_settlement->>'due_datetime','')::timestamptz,nullif(p_settlement->>'processed_date','')::timestamptz,
  coalesce(nullif(p_settlement->>'charge_count','')::integer,0),p_settlement,now())
 on conflict(provider_settlement_id) do update set currency=excluded.currency,gross_amount_minor=excluded.gross_amount_minor,
 net_amount_minor=excluded.net_amount_minor,fee_amount_minor=excluded.fee_amount_minor,refund_amount_minor=excluded.refund_amount_minor,
 chargeback_amount_minor=excluded.chargeback_amount_minor,provider_status=excluded.provider_status,destination=excluded.destination,
 due_at=excluded.due_at,settled_at=excluded.settled_at,charge_count=excluded.charge_count,provider_payload=excluded.provider_payload,last_reconciled_at=now()
 returning id into rec_id;
 if p_expected_gross_minor is not null and gross<>p_expected_gross_minor then
  insert into financial_reconciliation_exceptions(settlement_record_id,provider_settlement_id,currency,exception_code,expected_minor,actual_minor)
  values(rec_id,sid,cur,'gross_amount_mismatch',p_expected_gross_minor,gross);
  issues:=issues||jsonb_build_array('gross_amount_mismatch');
 end if;
 if p_expected_fees_minor is not null and fees<>p_expected_fees_minor then
  insert into financial_reconciliation_exceptions(settlement_record_id,provider_settlement_id,currency,exception_code,expected_minor,actual_minor)
  values(rec_id,sid,cur,'provider_fee_mismatch',p_expected_fees_minor,fees);
  issues:=issues||jsonb_build_array('provider_fee_mismatch');
 end if;
 return jsonb_build_object('settlementRecordId',rec_id,'providerSettlementId',sid,'currency',cur,
  'grossMinor',gross,'netMinor',net,'feesMinor',fees,'refundsMinor',refunds,'chargebacksMinor',chargebacks,'exceptions',issues);
end $$;
revoke all on function executive_visuals.record_flutterwave_settlement(uuid,jsonb,bigint,bigint) from public,anon,authenticated;
grant execute on function executive_visuals.record_flutterwave_settlement(uuid,jsonb,bigint,bigint) to service_role;

create or replace function executive_visuals.resolve_financial_reconciliation_exception(
 p_actor_id uuid,p_exception_id uuid,p_status text,p_reason text
) returns void language plpgsql security definer
set search_path=pg_catalog,executive_visuals as $$
declare actor_role text;
begin
 select role into actor_role from platform_admins where user_id=p_actor_id;
 if coalesce(actor_role,'') not in ('owner','platform_admin','billing_admin') then raise exception 'Finance administrator role required' using errcode='42501'; end if;
 if p_status not in ('investigating','resolved','accepted_difference') or char_length(btrim(coalesce(p_reason,''))) not between 3 and 500 then raise exception 'Resolution status and reason required' using errcode='22023'; end if;
 update financial_reconciliation_exceptions set status=p_status,resolution_reason=btrim(p_reason),
  resolved_by=p_actor_id,resolved_at=case when p_status in ('resolved','accepted_difference') then now() else null end
 where id=p_exception_id and status in ('open','investigating');
 if not found then raise exception 'Open reconciliation exception not found' using errcode='P0002'; end if;
 insert into financial_admin_audit(actor_id,actor_role,action,resource_type,resource_id,reason,metadata)
 values(p_actor_id,actor_role,'finance.reconciliation_exception.'||p_status,'reconciliation_exception',p_exception_id::text,btrim(p_reason),'{}'::jsonb);
end $$;
revoke all on function executive_visuals.resolve_financial_reconciliation_exception(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function executive_visuals.resolve_financial_reconciliation_exception(uuid,uuid,text,text) to service_role;

create or replace function executive_visuals.write_financial_admin_audit(
 p_actor_id uuid,p_action text,p_resource_type text,p_resource_id text,p_reason text,p_request_id text default null,p_metadata jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer
set search_path=pg_catalog,executive_visuals as $$
declare actor_role text; new_id uuid;
begin
 select role into actor_role from platform_admins where user_id=p_actor_id;
 if coalesce(actor_role,'') not in ('owner','platform_admin','billing_admin') then raise exception 'Finance administrator role required' using errcode='42501'; end if;
 if p_action !~ '^[a-z][a-z0-9_.-]{2,95}$' or char_length(coalesce(p_reason,'')) not between 3 and 500
  or jsonb_typeof(coalesce(p_metadata,'{}'::jsonb))<>'object' then raise exception 'Audit reason and action required' using errcode='22023'; end if;
 insert into financial_admin_audit(actor_id,actor_role,action,resource_type,resource_id,reason,request_id,metadata)
 values(p_actor_id,actor_role,p_action,p_resource_type,p_resource_id,btrim(p_reason),p_request_id,p_metadata)
 returning id into new_id;
 return new_id;
end $$;
revoke all on function executive_visuals.write_financial_admin_audit(uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function executive_visuals.write_financial_admin_audit(uuid,text,text,text,text,text,jsonb) to service_role;
