-- Batch 33: persisted reconciliation register and evidence-backed close gate.
grant usage on schema executive_visuals to service_role;

alter table executive_visuals.financial_audit_events
 drop constraint if exists financial_audit_events_event_type_check;
alter table executive_visuals.financial_audit_events
 add constraint financial_audit_events_event_type_check check(event_type in(
  'close_period.created','close_period.submitted','close_period.locked','close_period.reopened',
  'close_task.assigned','close_task.completed','close_task.waived',
  'close_approval.assigned','close_approval.recorded',
  'reconciliation.recorded','reconciliation.reviewed',
  'evidence.attached','evidence.retention_changed'
 ));

create table if not exists executive_visuals.financial_close_reconciliations(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete restrict,
 period_id uuid not null references executive_visuals.financial_close_periods(id) on delete restrict,
 reconciliation_key text not null check(reconciliation_key ~ '^[a-z][a-z0-9_-]{1,63}$'),
 account_name text not null check(length(account_name) between 2 and 180),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 ledger_balance_minor bigint not null,
 statement_balance_minor bigint not null,
 variance_minor bigint generated always as(statement_balance_minor-ledger_balance_minor) stored,
 evidence_reference text not null check(length(evidence_reference) between 4 and 1024),
 evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 prepared_by uuid not null references auth.users(id) on delete restrict,
 reviewer_id uuid not null references auth.users(id) on delete restrict,
 status text not null default 'pending' check(status in('pending','approved','exception')),
 decision_note text,
 reviewed_by uuid references auth.users(id) on delete restrict,
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(period_id,reconciliation_key),
 check(prepared_by<>reviewer_id),
 check((status='pending')=(reviewed_at is null and reviewed_by is null)),
 check((status='exception')=(decision_note is not null))
);
create index if not exists financial_close_reconciliations_owner_period_idx
 on executive_visuals.financial_close_reconciliations(owner_id,period_id,status);
alter table executive_visuals.financial_close_reconciliations enable row level security;
revoke all on executive_visuals.financial_close_reconciliations from public,anon,authenticated,service_role;

create or replace function executive_visuals.assert_financial_close_reconciliations_complete()
returns trigger language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $function$
declare v_total integer; v_blocked integer;
begin
 if new.status='locked' and old.status is distinct from new.status then
  select count(*),count(*) filter(where status<>'approved' or variance_minor<>0)
   into v_total,v_blocked
   from executive_visuals.financial_close_reconciliations
   where owner_id=new.owner_id and period_id=new.id;
  if v_total=0 then
   raise exception using errcode='23514',message='financial_close_reconciliation_required';
  end if;
  if v_blocked>0 then
   raise exception using errcode='23514',message='financial_close_reconciliation_incomplete';
  end if;
 end if;
 return new;
end
$function$;
revoke all on function executive_visuals.assert_financial_close_reconciliations_complete() from public,anon,authenticated,service_role;
drop trigger if exists financial_close_reconciliation_lock_gate on executive_visuals.financial_close_periods;
create trigger financial_close_reconciliation_lock_gate
 before update of status on executive_visuals.financial_close_periods
 for each row execute function executive_visuals.assert_financial_close_reconciliations_complete();

create or replace function executive_visuals.execute_financial_reconciliation_command(
 p_owner_id uuid,p_actor_id uuid,p_command text,p_payload jsonb,
 p_event_envelope jsonb,p_canonical_event text,p_event_hash text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,public
as $function$
declare
 v_expected_event text;
 v_audit jsonb;
 v_period executive_visuals.financial_close_periods%rowtype;
 v_reconciliation executive_visuals.financial_close_reconciliations%rowtype;
 v_period_id uuid;
 v_reconciliation_id uuid;
 v_reviewer uuid;
 v_decision text;
 v_note text;
begin
 if p_owner_id is null or p_actor_id is null or jsonb_typeof(p_payload)<>'object' then
  raise exception using errcode='22023',message='financial_reconciliation_command_invalid';
 end if;
 v_expected_event:=case p_command
  when 'record_reconciliation' then 'reconciliation.recorded'
  when 'review_reconciliation' then 'reconciliation.reviewed'
  else null end;
 if v_expected_event is null
  or p_event_envelope->>'eventType' is distinct from v_expected_event
  or p_event_envelope->>'ownerId' is distinct from p_owner_id::text
  or p_event_envelope->>'actorId' is distinct from p_actor_id::text
  or p_event_envelope->'payload' is distinct from p_payload then
  raise exception using errcode='22023',message='financial_reconciliation_event_mismatch';
 end if;

 v_audit:=executive_visuals.append_financial_audit_event(
  p_owner_id,p_actor_id,p_event_envelope->>'idempotencyKey',
  p_event_envelope,p_canonical_event,p_event_hash
 );
 if coalesce((v_audit->>'duplicate')::boolean,false) then
  return jsonb_build_object('duplicate',true,'audit',v_audit);
 end if;

 v_period_id:=nullif(p_payload->>'periodId','')::uuid;
 if v_period_id is null then raise exception using errcode='22023',message='financial_reconciliation_period_required'; end if;
 select * into v_period from executive_visuals.financial_close_periods
  where id=v_period_id and owner_id=p_owner_id for update;
 if not found then raise exception using errcode='P0002',message='financial_reconciliation_period_not_found'; end if;

 if p_command='record_reconciliation' then
  if v_period.status<>'open'
   or nullif(btrim(p_payload->>'reconciliationKey'),'') is null
   or nullif(btrim(p_payload->>'accountName'),'') is null
   or p_payload->>'currency' is distinct from v_period.currency
   or coalesce(p_payload->>'ledgerBalanceMinor','') !~ '^-?[0-9]+$'
   or coalesce(p_payload->>'statementBalanceMinor','') !~ '^-?[0-9]+$'
   or nullif(btrim(p_payload->>'evidenceReference'),'') is null
   or coalesce(p_payload->>'evidenceSha256','') !~ '^[a-f0-9]{64}$'
   or nullif(p_payload->>'reviewerId','') is null then
   raise exception using errcode='22023',message='financial_reconciliation_input_invalid';
  end if;
  v_reviewer:=(p_payload->>'reviewerId')::uuid;
  if v_reviewer=p_actor_id then raise exception using errcode='22023',message='financial_reconciliation_self_review_forbidden'; end if;
  insert into executive_visuals.financial_close_reconciliations(
   owner_id,period_id,reconciliation_key,account_name,currency,ledger_balance_minor,
   statement_balance_minor,evidence_reference,evidence_sha256,prepared_by,reviewer_id,status,
   decision_note,reviewed_by,reviewed_at,updated_at
  ) values(
   p_owner_id,v_period_id,p_payload->>'reconciliationKey',p_payload->>'accountName',
   p_payload->>'currency',(p_payload->>'ledgerBalanceMinor')::bigint,
   (p_payload->>'statementBalanceMinor')::bigint,p_payload->>'evidenceReference',
   p_payload->>'evidenceSha256',p_actor_id,v_reviewer,'pending',null,null,null,now()
  )
  on conflict(period_id,reconciliation_key) do update set
   account_name=excluded.account_name,currency=excluded.currency,
   ledger_balance_minor=excluded.ledger_balance_minor,
   statement_balance_minor=excluded.statement_balance_minor,
   evidence_reference=excluded.evidence_reference,evidence_sha256=excluded.evidence_sha256,
   prepared_by=excluded.prepared_by,reviewer_id=excluded.reviewer_id,status='pending',
   decision_note=null,reviewed_by=null,reviewed_at=null,updated_at=now()
  returning * into v_reconciliation;
  return jsonb_build_object('duplicate',false,'reconciliation',to_jsonb(v_reconciliation),'audit',v_audit);
 end if;

 if v_period.status<>'in_review' then raise exception using errcode='22023',message='financial_reconciliation_review_state_invalid'; end if;
 v_reconciliation_id:=nullif(p_payload->>'reconciliationId','')::uuid;
 select * into v_reconciliation from executive_visuals.financial_close_reconciliations
  where id=v_reconciliation_id and owner_id=p_owner_id and period_id=v_period_id for update;
 if not found or v_reconciliation.status<>'pending'
  or v_reconciliation.reviewer_id<>p_actor_id or v_reconciliation.prepared_by=p_actor_id then
  raise exception using errcode='42501',message='financial_reconciliation_reviewer_not_authorized';
 end if;
 v_decision:=p_payload->>'decision';
 v_note:=nullif(btrim(p_payload->>'note'),'');
 if v_decision not in('approved','exception') then
  raise exception using errcode='22023',message='financial_reconciliation_decision_invalid';
 end if;
 if v_decision='approved' and v_reconciliation.variance_minor<>0 then
  raise exception using errcode='22023',message='financial_reconciliation_variance_must_be_zero';
 end if;
 if v_decision='exception' and (v_note is null or length(v_note)<8) then
  raise exception using errcode='22023',message='financial_reconciliation_exception_note_required';
 end if;
 update executive_visuals.financial_close_reconciliations set status=v_decision,
  decision_note=v_note,reviewed_by=p_actor_id,reviewed_at=now(),updated_at=now()
  where id=v_reconciliation.id returning * into v_reconciliation;
 return jsonb_build_object('duplicate',false,'reconciliation',to_jsonb(v_reconciliation),'audit',v_audit);
end
$function$;
revoke all on function executive_visuals.execute_financial_reconciliation_command(uuid,uuid,text,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function executive_visuals.execute_financial_reconciliation_command(uuid,uuid,text,jsonb,jsonb,text,text) to service_role;

create or replace function executive_visuals.get_financial_close_overview(p_owner_id uuid)
returns jsonb language sql stable security definer
set search_path=pg_catalog,executive_visuals
as $function$
 select jsonb_build_object(
  'periods',coalesce((select jsonb_agg(to_jsonb(p) order by p.period_start desc)
   from executive_visuals.financial_close_periods p where p.owner_id=p_owner_id),'[]'::jsonb),
  'tasks',coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at)
   from executive_visuals.financial_close_tasks t where t.owner_id=p_owner_id),'[]'::jsonb),
  'approvals',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at)
   from executive_visuals.financial_close_approvals a where a.owner_id=p_owner_id),'[]'::jsonb),
  'reconciliations',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at)
   from executive_visuals.financial_close_reconciliations r where r.owner_id=p_owner_id),'[]'::jsonb)
 )
$function$;
revoke all on function executive_visuals.get_financial_close_overview(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.get_financial_close_overview(uuid) to service_role;
