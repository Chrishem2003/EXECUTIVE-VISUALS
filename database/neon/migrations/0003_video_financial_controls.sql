-- Executive Visuals: isolated Neon financial controls for video generation.
-- Source-controlled only. Requires 0001_worker_queue.sql and 0002_video_submission_ledger.sql.
-- Owner UUIDs are issued by the application's verified identity layer; this migration does not create an identity store.
-- Apply only to the separately approved, disposable Neon staging branch.
begin;

create table if not exists executive_visuals.billing_credit_accounts(
 owner_id uuid primary key,status text not null default 'active' check(status in ('active','suspended')),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp()
);
create table if not exists executive_visuals.billing_credit_ledger(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
 amount bigint not null check(amount<>0),
 event_type text not null check(event_type in ('grant','admin_adjustment','generation_reserve','generation_refund','generation_settlement','expiry')),
 reference_id uuid,idempotency_key text not null unique check(char_length(idempotency_key) between 1 and 200),
 description text not null default '' check(char_length(description)<=500),
 evidence jsonb not null default '{}'::jsonb check(jsonb_typeof(evidence)='object'),
 created_at timestamptz not null default clock_timestamp()
);
create index if not exists ev_neon_credit_ledger_owner on executive_visuals.billing_credit_ledger(owner_id,created_at desc);
create table if not exists executive_visuals.billing_credit_reservations(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references executive_visuals.billing_credit_accounts(owner_id) on delete restrict,
 job_id uuid not null unique references executive_visuals.jobs(id) on delete restrict,
 idempotency_key text not null unique check(char_length(idempotency_key) between 1 and 200),
 reserved_credits bigint not null check(reserved_credits>0),actual_credits bigint check(actual_credits is null or actual_credits>=0),
 state text not null default 'reserved' check(state in ('reserved','settled','released')),
 evidence jsonb not null default '{}'::jsonb check(jsonb_typeof(evidence)='object'),
 created_at timestamptz not null default clock_timestamp(),settled_at timestamptz
);
create table if not exists executive_visuals.video_generation_budget_policies(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null,project_id uuid,provider text not null check(char_length(provider) between 1 and 100),
 model text not null check(char_length(model) between 1 and 160),currency text not null check(currency ~ '^[A-Z]{3}$'),
 spend_limit_amount numeric(14,6) not null check(spend_limit_amount>0),max_per_job_amount numeric(14,6) not null check(max_per_job_amount>0 and max_per_job_amount<=spend_limit_amount),
 reserved_amount numeric(14,6) not null default 0 check(reserved_amount>=0),spent_amount numeric(14,6) not null default 0 check(spent_amount>=0),
 rolling_24h_request_limit integer not null default 0 check(rolling_24h_request_limit between 0 and 10000),
 enabled boolean not null default false,created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp()
);
create unique index if not exists ev_neon_video_budget_policy_scope on executive_visuals.video_generation_budget_policies
(owner_id,coalesce(project_id,'00000000-0000-0000-0000-000000000000'::uuid),provider,model);
create table if not exists executive_visuals.video_generation_budget_approvals(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null,project_id uuid,provider text not null,model text not null,
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),currency text not null check(currency ~ '^[A-Z]{3}$'),
 approved_max_amount numeric(14,6) not null check(approved_max_amount>0),approval_note text not null default '' check(char_length(approval_note)<=1000),
 expires_at timestamptz not null,consumed_at timestamptz,created_at timestamptz not null default clock_timestamp(),
 check(expires_at>created_at)
);
create table if not exists executive_visuals.video_generation_budget_reservations(
 id uuid primary key default gen_random_uuid(),job_id uuid not null unique references executive_visuals.jobs(id) on delete restrict,
 approval_id uuid not null unique references executive_visuals.video_generation_budget_approvals(id),
 policy_id uuid not null references executive_visuals.video_generation_budget_policies(id),owner_id uuid not null,
 project_id uuid,provider text not null,model text not null,currency text not null check(currency ~ '^[A-Z]{3}$'),
 reserved_amount numeric(14,6) not null check(reserved_amount>0),actual_amount numeric(14,6) check(actual_amount is null or actual_amount>=0),
 state text not null default 'reserved' check(state in ('reserved','settled','released')),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp()
);
create table if not exists executive_visuals.video_generation_usage_reservations(
 job_id uuid primary key references executive_visuals.jobs(id) on delete restrict,owner_id uuid not null,provider text not null,model text not null,
 capability text not null default 'video.generate',created_at timestamptz not null default clock_timestamp()
);
create table if not exists executive_visuals.video_generation_cost_ledger(
 id uuid primary key default gen_random_uuid(),job_id uuid not null unique references executive_visuals.jobs(id) on delete restrict,
 owner_id uuid not null,project_id uuid,provider text not null,model text not null,provider_task_id text not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'),reserved_amount numeric(14,6) not null check(reserved_amount>0),
 actual_amount numeric(14,6) not null check(actual_amount>=0),evidence_reference text not null check(char_length(evidence_reference) between 1 and 1000),
 idempotency_key text not null unique,created_at timestamptz not null default clock_timestamp()
);
create index if not exists ev_neon_cost_owner_created on executive_visuals.video_generation_cost_ledger(owner_id,created_at desc);
create index if not exists ev_neon_usage_owner_created on executive_visuals.video_generation_usage_reservations(owner_id,created_at desc);

-- Append-only accounting and provider-cost evidence.
create or replace function executive_visuals.reject_financial_ledger_mutation_v1()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'FINANCIAL_LEDGER_IS_APPEND_ONLY'; end $$;
drop trigger if exists ev_neon_credit_ledger_immutable on executive_visuals.billing_credit_ledger;
create trigger ev_neon_credit_ledger_immutable before update or delete on executive_visuals.billing_credit_ledger
for each row execute function executive_visuals.reject_financial_ledger_mutation_v1();
drop trigger if exists ev_neon_video_cost_immutable on executive_visuals.video_generation_cost_ledger;
create trigger ev_neon_video_cost_immutable before update or delete on executive_visuals.video_generation_cost_ledger
for each row execute function executive_visuals.reject_financial_ledger_mutation_v1();

create or replace function executive_visuals.grant_generation_credits_v1(p_owner_id uuid,p_amount bigint,p_idempotency_key text,p_evidence jsonb default '{}'::jsonb)
returns table(ledger_id uuid,balance bigint,replayed boolean)
language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare prior executive_visuals.billing_credit_ledger; new_id uuid; total bigint;
begin
 if p_owner_id is null or p_amount is null or p_amount<=0 or p_amount>1000000000 or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 or jsonb_typeof(coalesce(p_evidence,'{}'::jsonb))<>'object' then raise exception 'BILLING_CREDIT_GRANT_ARGUMENTS_INVALID'; end if;
 insert into executive_visuals.billing_credit_accounts(owner_id) values(p_owner_id) on conflict(owner_id) do nothing;
 perform 1 from executive_visuals.billing_credit_accounts where owner_id=p_owner_id and status='active' for update;
 if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;
 select * into prior from executive_visuals.billing_credit_ledger where idempotency_key=p_idempotency_key;
 if prior.id is not null then
  if prior.owner_id<>p_owner_id or prior.amount<>p_amount or prior.event_type<>'grant' or prior.evidence<>coalesce(p_evidence,'{}'::jsonb) then raise exception 'BILLING_CREDIT_IDEMPOTENCY_CONFLICT'; end if;
  select coalesce(sum(amount),0) into total from executive_visuals.billing_credit_ledger where owner_id=p_owner_id;
  return query select prior.id,total,true; return;
 end if;
 insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,idempotency_key,description,evidence)
 values(p_owner_id,p_amount,'grant',p_idempotency_key,'Verified generation credit grant',coalesce(p_evidence,'{}'::jsonb)) returning id into new_id;
 select coalesce(sum(amount),0) into total from executive_visuals.billing_credit_ledger where owner_id=p_owner_id;
 return query select new_id,total,false;
end $$;

create or replace function executive_visuals.configure_video_budget_policy_v1(
 p_owner_id uuid,p_project_id uuid,p_provider text,p_model text,p_currency text,p_spend_limit numeric,p_max_per_job numeric,p_rolling_24h_limit integer,p_enabled boolean
) returns uuid language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare result_id uuid; current_row executive_visuals.video_generation_budget_policies;
begin
 if p_owner_id is null or p_provider is null or char_length(p_provider) not between 1 and 100 or p_model is null or char_length(p_model) not between 1 and 160 or p_currency !~ '^[A-Z]{3}$' or p_spend_limit<=0 or p_max_per_job<=0 or p_max_per_job>p_spend_limit or p_rolling_24h_limit not between 0 and 10000 then raise exception 'VIDEO_BUDGET_POLICY_ARGUMENTS_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text||':'||coalesce(p_project_id::text,'global')||':'||p_provider||':'||p_model,0));
 select * into current_row from executive_visuals.video_generation_budget_policies where owner_id=p_owner_id and project_id is not distinct from p_project_id and provider=p_provider and model=p_model for update;
 if current_row.id is null then
  insert into executive_visuals.video_generation_budget_policies(owner_id,project_id,provider,model,currency,spend_limit_amount,max_per_job_amount,rolling_24h_request_limit,enabled)
  values(p_owner_id,p_project_id,p_provider,p_model,p_currency,p_spend_limit,p_max_per_job,p_rolling_24h_limit,p_enabled) returning id into result_id;
 else
  if current_row.currency<>p_currency and (current_row.reserved_amount>0 or current_row.spent_amount>0) then raise exception 'VIDEO_BUDGET_POLICY_CURRENCY_LOCKED'; end if;
  if p_spend_limit<current_row.reserved_amount+current_row.spent_amount then raise exception 'VIDEO_BUDGET_LIMIT_BELOW_COMMITTED_SPEND'; end if;
  update executive_visuals.video_generation_budget_policies set currency=p_currency,spend_limit_amount=p_spend_limit,max_per_job_amount=p_max_per_job,rolling_24h_request_limit=p_rolling_24h_limit,enabled=p_enabled,updated_at=clock_timestamp() where id=current_row.id returning id into result_id;
 end if;
 return result_id;
end $$;

create or replace function executive_visuals.issue_video_budget_approval_v1(
 p_owner_id uuid,p_project_id uuid,p_provider text,p_model text,p_request_hash text,p_currency text,p_approved_max numeric,p_note text default '',p_ttl_seconds integer default 300
) returns uuid language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare result_id uuid;
begin
 if p_owner_id is null or p_provider is null or char_length(p_provider) not between 1 and 100 or p_model is null or char_length(p_model) not between 1 and 160 or p_request_hash !~ '^[a-f0-9]{64}$' or p_currency !~ '^[A-Z]{3}$' or p_approved_max<=0 or char_length(coalesce(p_note,''))>1000 or p_ttl_seconds not between 30 and 900 then raise exception 'VIDEO_BUDGET_APPROVAL_ARGUMENTS_INVALID'; end if;
 insert into executive_visuals.video_generation_budget_approvals(owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,approval_note,expires_at)
 values(p_owner_id,p_project_id,p_provider,p_model,p_request_hash,p_currency,p_approved_max,left(coalesce(p_note,''),1000),clock_timestamp()+make_interval(secs=>p_ttl_seconds)) returning id into result_id;
 return result_id;
end $$;

create or replace function executive_visuals.reserve_video_generation_financials_v1(
 p_job_id uuid,p_owner_id uuid,p_approval_id uuid,p_reserved_amount numeric,p_reserved_credits bigint,p_credit_idempotency_key text
) returns table(budget_reservation_id uuid,credit_reservation_id uuid,available_credits bigint,replayed boolean)
language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare j executive_visuals.jobs; policy_row executive_visuals.video_generation_budget_policies; approval_row executive_visuals.video_generation_budget_approvals;
 budget_row executive_visuals.video_generation_budget_reservations; credit_row executive_visuals.billing_credit_reservations;
 balance_now bigint; reserved_now bigint; budget_id uuid; credit_id uuid; provider_name text; model_name text; hash_value text; currency_value text;
begin
 if p_job_id is null or p_owner_id is null or p_approval_id is null or p_reserved_amount is null or p_reserved_amount<=0 or p_reserved_amount>1000000 or p_reserved_credits is null or p_reserved_credits<=0 or p_reserved_credits>100000000 or p_credit_idempotency_key is null or char_length(p_credit_idempotency_key) not between 1 and 200 then raise exception 'VIDEO_FINANCIAL_RESERVATION_ARGUMENTS_INVALID'; end if;
 select * into j from executive_visuals.jobs where id=p_job_id and owner_id=p_owner_id and job_type='video.generate' for update;
 if j.id is null then raise exception 'VIDEO_FINANCIAL_JOB_OWNER_MISMATCH'; end if;
 provider_name:=lower(coalesce(j.input->>'provider','')); model_name:=coalesce(j.input->>'model',''); hash_value:=coalesce(j.input->>'requestHash','');
 if provider_name='' or model_name='' or hash_value !~ '^[a-f0-9]{64}$' then raise exception 'VIDEO_FINANCIAL_JOB_INPUT_INVALID'; end if;
 select * into budget_row from executive_visuals.video_generation_budget_reservations where job_id=p_job_id for update;
 select * into credit_row from executive_visuals.billing_credit_reservations where job_id=p_job_id for update;
 if budget_row.id is not null or credit_row.id is not null then
  if budget_row.id is null or credit_row.id is null or budget_row.owner_id<>p_owner_id or credit_row.owner_id<>p_owner_id or budget_row.approval_id<>p_approval_id or budget_row.reserved_amount<>p_reserved_amount or credit_row.reserved_credits<>p_reserved_credits then raise exception 'VIDEO_FINANCIAL_RESERVATION_CONFLICT'; end if;
  select coalesce(sum(amount),0) into balance_now from executive_visuals.billing_credit_ledger where owner_id=p_owner_id;
  select coalesce(sum(reserved_credits),0) into reserved_now from executive_visuals.billing_credit_reservations where owner_id=p_owner_id and state='reserved';
  return query select budget_row.id,credit_row.id,balance_now-reserved_now,true; return;
 end if;
 select * into approval_row from executive_visuals.video_generation_budget_approvals where id=p_approval_id and owner_id=p_owner_id for update;
 if approval_row.id is null or approval_row.consumed_at is not null or approval_row.expires_at<=clock_timestamp() then raise exception 'VIDEO_BUDGET_APPROVAL_INVALID_OR_EXPIRED'; end if;
 if approval_row.project_id is distinct from j.project_id or approval_row.provider<>provider_name or approval_row.model<>model_name or approval_row.request_hash<>hash_value or p_reserved_amount>approval_row.approved_max_amount then raise exception 'VIDEO_BUDGET_APPROVAL_SCOPE_MISMATCH'; end if;
 currency_value:=approval_row.currency;
 insert into executive_visuals.billing_credit_accounts(owner_id) values(p_owner_id) on conflict(owner_id) do nothing;
 perform 1 from executive_visuals.billing_credit_accounts where owner_id=p_owner_id and status='active' for update;
 if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;
 select * into policy_row from executive_visuals.video_generation_budget_policies where owner_id=p_owner_id and project_id is not distinct from j.project_id and provider=provider_name and model=model_name for update;
 if policy_row.id is null or not policy_row.enabled or policy_row.currency<>currency_value then raise exception 'VIDEO_BUDGET_POLICY_DISABLED_OR_MISSING'; end if;
 if p_reserved_amount>policy_row.max_per_job_amount or policy_row.reserved_amount+policy_row.spent_amount+p_reserved_amount>policy_row.spend_limit_amount then raise exception 'VIDEO_BUDGET_LIMIT_EXCEEDED'; end if;
 if policy_row.rolling_24h_request_limit>0 and (select count(*) from executive_visuals.video_generation_usage_reservations u where u.owner_id=p_owner_id and u.provider=provider_name and u.model=model_name and u.created_at>clock_timestamp()-interval '24 hours')>=policy_row.rolling_24h_request_limit then raise exception 'VIDEO_BUDGET_ROLLING_REQUEST_LIMIT'; end if;
 select coalesce(sum(amount),0) into balance_now from executive_visuals.billing_credit_ledger where owner_id=p_owner_id;
 select coalesce(sum(reserved_credits),0) into reserved_now from executive_visuals.billing_credit_reservations where owner_id=p_owner_id and state='reserved';
 if balance_now-reserved_now<p_reserved_credits then raise exception 'BILLING_INSUFFICIENT_CREDITS'; end if;
 insert into executive_visuals.video_generation_budget_reservations(job_id,approval_id,policy_id,owner_id,project_id,provider,model,currency,reserved_amount)
 values(p_job_id,p_approval_id,policy_row.id,p_owner_id,j.project_id,provider_name,model_name,currency_value,p_reserved_amount) returning id into budget_id;
 insert into executive_visuals.billing_credit_reservations(owner_id,job_id,idempotency_key,reserved_credits)
 values(p_owner_id,p_job_id,p_credit_idempotency_key,p_reserved_credits) returning id into credit_id;
 insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description)
 values(p_owner_id,-p_reserved_credits,'generation_reserve',p_job_id,'credit-reserve:'||p_credit_idempotency_key,'Video generation credit reservation');
 insert into executive_visuals.video_generation_usage_reservations(job_id,owner_id,provider,model) values(p_job_id,p_owner_id,provider_name,model_name);
 update executive_visuals.video_generation_budget_policies set reserved_amount=reserved_amount+p_reserved_amount,updated_at=clock_timestamp() where id=policy_row.id;
 update executive_visuals.video_generation_budget_approvals set consumed_at=clock_timestamp() where id=approval_row.id;
 return query select budget_id,credit_id,balance_now-reserved_now-p_reserved_credits,false;
end $$;

create or replace function executive_visuals.finalize_video_generation_financials_v1(
 p_job_id uuid,p_owner_id uuid,p_terminal_status text,p_actual_amount numeric,p_actual_credits bigint,p_evidence jsonb
) returns table(balance bigint,credit_adjustment bigint,replayed boolean)
language plpgsql security definer set search_path=pg_catalog,executive_visuals as $$
declare budget_row executive_visuals.video_generation_budget_reservations; credit_row executive_visuals.billing_credit_reservations; policy_row executive_visuals.video_generation_budget_policies;
 j executive_visuals.jobs; delta bigint; current_balance bigint; held bigint; provider_task text; evidence_ref text; evidence_type text;
begin
 if p_job_id is null or p_owner_id is null or p_terminal_status not in ('succeeded','partial','failed','cancelled') or jsonb_typeof(coalesce(p_evidence,'{}'::jsonb))<>'object' then raise exception 'VIDEO_FINANCIAL_FINALIZATION_ARGUMENTS_INVALID'; end if;
 select * into j from executive_visuals.jobs where id=p_job_id and owner_id=p_owner_id and job_type='video.generate' for update;
 if j.id is null then raise exception 'VIDEO_FINANCIAL_JOB_OWNER_MISMATCH'; end if;
 select * into budget_row from executive_visuals.video_generation_budget_reservations where job_id=p_job_id for update;
 select * into credit_row from executive_visuals.billing_credit_reservations where job_id=p_job_id for update;
 if budget_row.id is null and credit_row.id is null then return query select 0::bigint,0::bigint,false; return; end if;
 if budget_row.id is null or credit_row.id is null or budget_row.owner_id<>p_owner_id or credit_row.owner_id<>p_owner_id then raise exception 'VIDEO_FINANCIAL_RESERVATION_INCOMPLETE'; end if;
 perform 1 from executive_visuals.billing_credit_accounts where owner_id=p_owner_id and status='active' for update;
 if not found then raise exception 'BILLING_ACCOUNT_NOT_ACTIVE'; end if;
 if budget_row.state in ('settled','released') or credit_row.state in ('settled','released') then
  if budget_row.state<>credit_row.state then raise exception 'VIDEO_FINANCIAL_FINALIZATION_STATE_CONFLICT'; end if;
  select coalesce(sum(amount),0) into current_balance from executive_visuals.billing_credit_ledger where owner_id=p_owner_id;
  return query select current_balance,coalesce(credit_row.reserved_credits-credit_row.actual_credits,0),true; return;
 end if;
 if budget_row.state<>'reserved' or credit_row.state<>'reserved' then raise exception 'VIDEO_FINANCIAL_RESERVATION_NOT_ACTIVE'; end if;
 if p_terminal_status in ('succeeded','partial') then
  if p_actual_amount is null or p_actual_amount<0 or p_actual_amount>budget_row.reserved_amount or p_actual_credits is null or p_actual_credits<0 or p_actual_credits>credit_row.reserved_credits then raise exception 'VIDEO_ACTUAL_COST_EXCEEDS_RESERVATION'; end if;
  provider_task:=coalesce(p_evidence->>'providerTaskId',''); evidence_ref:=coalesce(p_evidence->>'evidenceReference',''); evidence_type:=coalesce(p_evidence->>'evidenceType','');
  if coalesce(p_evidence->>'provider','')<>budget_row.provider or coalesce(p_evidence->>'model','')<>budget_row.model or provider_task='' or evidence_ref='' or evidence_type not in ('provider_task_receipt','provider_invoice','provider_usage_reconciliation') then raise exception 'VIDEO_COST_EVIDENCE_INVALID'; end if;
  insert into executive_visuals.video_generation_cost_ledger(job_id,owner_id,project_id,provider,model,provider_task_id,currency,reserved_amount,actual_amount,evidence_reference,idempotency_key)
  values(p_job_id,p_owner_id,budget_row.project_id,budget_row.provider,budget_row.model,provider_task,budget_row.currency,budget_row.reserved_amount,p_actual_amount,evidence_ref,'video-generation-cost:'||p_job_id::text);
  delta:=credit_row.reserved_credits-p_actual_credits;
  if delta<>0 then
   insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description,evidence)
   values(p_owner_id,delta,case when delta>0 then 'generation_refund' else 'generation_settlement' end,p_job_id,'credit-finalize:'||credit_row.id::text,'Provider verified credit settlement',p_evidence);
  end if;
  update executive_visuals.billing_credit_reservations set actual_credits=p_actual_credits,state='settled',evidence=p_evidence,settled_at=clock_timestamp() where id=credit_row.id;
  update executive_visuals.video_generation_budget_reservations set actual_amount=p_actual_amount,state='settled',updated_at=clock_timestamp() where id=budget_row.id;
  update executive_visuals.video_generation_budget_policies set reserved_amount=reserved_amount-budget_row.reserved_amount,spent_amount=spent_amount+p_actual_amount,updated_at=clock_timestamp() where id=budget_row.policy_id;
 else
  if coalesce(p_evidence->>'provider','')<>budget_row.provider
     or coalesce(p_evidence->>'evidenceType','') not in ('verified_no_charge_cancellation','verified_no_submission')
     or coalesce(p_evidence->>'evidenceId','')=''
     or coalesce(p_evidence->>'evidenceReference','')='' then
    raise exception 'VIDEO_FAILURE_REQUIRES_VERIFIED_NO_CHARGE_EVIDENCE';
  end if;
  insert into executive_visuals.billing_credit_ledger(owner_id,amount,event_type,reference_id,idempotency_key,description,evidence)
  values(p_owner_id,credit_row.reserved_credits,'generation_refund',p_job_id,'credit-release:'||credit_row.id::text,'Video generation reservation released after verified non-billable failure',p_evidence);
  update executive_visuals.billing_credit_reservations set state='released',actual_credits=0,evidence=p_evidence||jsonb_build_object('terminalStatus',p_terminal_status),settled_at=clock_timestamp() where id=credit_row.id;
  update executive_visuals.video_generation_budget_reservations set state='released',actual_amount=0,updated_at=clock_timestamp() where id=budget_row.id;
  update executive_visuals.video_generation_budget_policies set reserved_amount=reserved_amount-budget_row.reserved_amount,updated_at=clock_timestamp() where id=budget_row.policy_id;
 end if;
 select coalesce(sum(amount),0) into current_balance from executive_visuals.billing_credit_ledger where owner_id=p_owner_id;
 return query select current_balance,case when p_terminal_status in ('succeeded','partial') then delta else credit_row.reserved_credits end,false;
end $$;


create or replace function executive_visuals.finish_video_generation_job_v1(
 p_job_id uuid,p_owner_id uuid,p_worker_id text,p_lease_token uuid,p_status text,
 p_output jsonb default null,p_error jsonb default null,p_actual_amount numeric default null,
 p_actual_credits bigint default null,p_financial_evidence jsonb default '{}'::jsonb
) returns boolean language plpgsql security definer set search_path=pg_catalog,executive_visuals as $finish_video_generation_job_v1$
declare job_row executive_visuals.jobs; financial_receipt record;
begin
 if p_job_id is null or p_owner_id is null or p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 128 or p_lease_token is null or p_status is null or p_status not in ('succeeded','partial','failed','cancelled') or (p_output is not null and jsonb_typeof(p_output)<>'object') or (p_error is not null and jsonb_typeof(p_error)<>'object') then raise exception 'VIDEO_JOB_FINALIZATION_ARGUMENTS_INVALID'; end if;
 select * into job_row from executive_visuals.jobs where id=p_job_id and owner_id=p_owner_id and job_type='video.generate' and status='processing' and lease_owner=p_worker_id and lease_token=p_lease_token and lease_expires_at>clock_timestamp() for update;
 if job_row.id is null then return false; end if;
 if p_status in ('succeeded','partial') then
  if p_output is null or coalesce(p_output->>'provider','')='' or coalesce(p_output->>'model','')='' or coalesce(p_output->>'providerTaskId','')='' or coalesce(p_output->>'costEvidenceReference','')='' or p_actual_amount is null or p_actual_credits is null then raise exception 'VIDEO_JOB_SUCCESS_REQUIRES_COST_EVIDENCE'; end if;
  if coalesce(p_financial_evidence->>'provider','')<>p_output->>'provider'
     or coalesce(p_financial_evidence->>'model','')<>p_output->>'model'
     or coalesce(p_financial_evidence->>'providerTaskId','')<>p_output->>'providerTaskId'
     or coalesce(p_financial_evidence->>'evidenceReference','')<>p_output->>'costEvidenceReference'
     or coalesce(p_financial_evidence->>'evidenceId','')=''
     or coalesce(p_output->>'currency','')<>(select currency from executive_visuals.video_generation_budget_reservations where job_id=p_job_id)
     or coalesce((p_output->>'actualAmount')::numeric,-1)<>p_actual_amount
     or not exists(select 1 from executive_visuals.video_generation_budget_reservations where job_id=p_job_id)
     or not exists(select 1 from executive_visuals.billing_credit_reservations where job_id=p_job_id) then
    raise exception 'VIDEO_JOB_FINANCIAL_SCOPE_MISMATCH';
  end if;
 end if;
 select * into financial_receipt from executive_visuals.finalize_video_generation_financials_v1(p_job_id,p_owner_id,p_status,p_actual_amount,p_actual_credits,p_financial_evidence);
 update executive_visuals.jobs set status=p_status,progress=case when p_status in ('succeeded','partial') then 100 else progress end,
 output=p_output,error=p_error,completed_at=clock_timestamp(),updated_at=clock_timestamp(),
 lease_owner=null,lease_token=null,lease_expires_at=null,lease_heartbeat_at=null
 where id=p_job_id;
 insert into executive_visuals.job_events(job_id,owner_id,event_type,event_data)
 values(p_job_id,p_owner_id,'job.'||p_status,jsonb_build_object('status',p_status,'financialFinalized',true,'creditAdjustment',coalesce(financial_receipt.credit_adjustment,0)));
 return true;
end;
$finish_video_generation_job_v1$;

create or replace function executive_visuals.get_video_financial_readiness_v1()
returns table(schema_ready boolean,credit_ledger_ready boolean,budget_ready boolean,cost_ledger_ready boolean)
language sql security definer set search_path=pg_catalog,executive_visuals as $$
 select to_regclass('executive_visuals.jobs') is not null,
 to_regclass('executive_visuals.billing_credit_ledger') is not null and to_regclass('executive_visuals.billing_credit_reservations') is not null,
 to_regclass('executive_visuals.video_generation_budget_policies') is not null and to_regclass('executive_visuals.video_generation_budget_approvals') is not null and to_regclass('executive_visuals.video_generation_budget_reservations') is not null,
 to_regclass('executive_visuals.video_generation_cost_ledger') is not null;
$$;

-- Explicitly server-only. Browser roles receive no table or function privileges.
revoke all on executive_visuals.billing_credit_accounts,executive_visuals.billing_credit_ledger,executive_visuals.billing_credit_reservations,
 executive_visuals.video_generation_budget_policies,executive_visuals.video_generation_budget_approvals,
 executive_visuals.video_generation_budget_reservations,executive_visuals.video_generation_usage_reservations,
 executive_visuals.video_generation_cost_ledger from public;
revoke all on function executive_visuals.reject_financial_ledger_mutation_v1() from public;
revoke all on function executive_visuals.grant_generation_credits_v1(uuid,bigint,text,jsonb) from public;
revoke all on function executive_visuals.configure_video_budget_policy_v1(uuid,uuid,text,text,text,numeric,numeric,integer,boolean) from public;
revoke all on function executive_visuals.issue_video_budget_approval_v1(uuid,uuid,text,text,text,text,numeric,text,integer) from public;
revoke all on function executive_visuals.reserve_video_generation_financials_v1(uuid,uuid,uuid,numeric,bigint,text) from public;
revoke all on function executive_visuals.finalize_video_generation_financials_v1(uuid,uuid,text,numeric,bigint,jsonb) from public;
revoke all on function executive_visuals.finish_video_generation_job_v1(uuid,uuid,text,uuid,text,jsonb,jsonb,numeric,bigint,jsonb) from public;
revoke all on function executive_visuals.get_video_financial_readiness_v1() from public;
commit;
