-- Batch 59: durable, role-verified subscription allowance approval workflow.
-- Proposals and approval decisions are immutable. All writes occur through
-- service-role-only RPCs that append to the existing hash-chained audit ledger.

grant usage on schema executive_visuals to service_role;

alter table executive_visuals.financial_audit_events
 drop constraint if exists financial_audit_events_event_type_check;
alter table executive_visuals.financial_audit_events
 add constraint financial_audit_events_event_type_check check(event_type in(
  'close_period.created','close_period.submitted','close_period.locked','close_period.reopened',
  'close_task.assigned','close_task.completed','close_task.waived',
  'close_approval.assigned','close_approval.recorded',
  'reconciliation.recorded','reconciliation.reviewed',
  'evidence.attached','evidence.retention_changed',
  'subscription_allowance.proposal_created','subscription_allowance.approval_recorded'
 ));

create table if not exists executive_visuals.subscription_allowance_proposals(
 id uuid primary key default gen_random_uuid(),
 proposal_hash text not null unique check(proposal_hash ~ '^[a-f0-9]{64}$'),
 plan_code text not null check(plan_code ~ '^[a-z][a-z0-9_-]{1,63}$'),
 plan_version integer not null check(plan_version>0),
 currency text not null check(currency='USD'),
 monthly_price_minor bigint not null check(monthly_price_minor>0),
 included_credits bigint not null check(included_credits>0),
 provider_cost_per_credit_minor bigint not null check(provider_cost_per_credit_minor>0),
 proposal jsonb not null check(jsonb_typeof(proposal)='object'),
 canonical_proposal text not null check(octet_length(canonical_proposal)<=16384),
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 unique(plan_code,plan_version,proposal_hash),
 check((proposal->>'planCode')=plan_code),
 check((proposal->>'planVersion')::integer=plan_version),
 check((proposal->>'currency')=currency),
 check((proposal->>'monthlyPriceMinor')::bigint=monthly_price_minor),
 check((proposal->>'includedCredits')::bigint=included_credits),
 check((proposal->>'providerCostPerCustomerCreditMinor')::bigint=provider_cost_per_credit_minor)
);
create index if not exists subscription_allowance_proposals_created_idx
 on executive_visuals.subscription_allowance_proposals(created_at desc);

create table if not exists executive_visuals.subscription_allowance_approvals(
 id uuid primary key default gen_random_uuid(),
 proposal_id uuid not null references executive_visuals.subscription_allowance_proposals(id) on delete restrict,
 stage text not null check(stage in('finance','product')),
 actor_id uuid not null references auth.users(id) on delete restrict,
 actor_role text not null check(actor_role in('billing_admin','platform_admin')),
 decision text not null check(decision in('approved','rejected')),
 decision_note text,
 audit_event_id uuid not null unique references executive_visuals.financial_audit_events(event_id) on delete restrict,
 created_at timestamptz not null default now(),
 unique(proposal_id,stage),
 check((stage='finance' and actor_role='billing_admin') or (stage='product' and actor_role='platform_admin'))
);
create index if not exists subscription_allowance_approvals_proposal_idx
 on executive_visuals.subscription_allowance_approvals(proposal_id,created_at);

alter table executive_visuals.subscription_allowance_proposals enable row level security;
alter table executive_visuals.subscription_allowance_approvals enable row level security;
revoke all on executive_visuals.subscription_allowance_proposals,
 executive_visuals.subscription_allowance_approvals from public,anon,authenticated,service_role;
grant select on executive_visuals.subscription_allowance_proposals,
 executive_visuals.subscription_allowance_approvals to service_role;

create or replace function executive_visuals.reject_subscription_allowance_approval_mutation()
returns trigger language plpgsql
set search_path=pg_catalog,executive_visuals
as $$
begin
 raise exception using errcode='55000',message='subscription_allowance_approval_records_are_immutable';
end $$;
revoke all on function executive_visuals.reject_subscription_allowance_approval_mutation() from public,anon,authenticated,service_role;

drop trigger if exists subscription_allowance_proposals_immutable on executive_visuals.subscription_allowance_proposals;
create trigger subscription_allowance_proposals_immutable
 before update or delete on executive_visuals.subscription_allowance_proposals
 for each row execute function executive_visuals.reject_subscription_allowance_approval_mutation();
drop trigger if exists subscription_allowance_approvals_immutable on executive_visuals.subscription_allowance_approvals;
create trigger subscription_allowance_approvals_immutable
 before update or delete on executive_visuals.subscription_allowance_approvals
 for each row execute function executive_visuals.reject_subscription_allowance_approval_mutation();

create or replace function executive_visuals.create_subscription_allowance_proposal(
 p_actor_id uuid,p_proposal jsonb,p_canonical_proposal text,p_proposal_hash text,
 p_event_envelope jsonb,p_canonical_event text,p_event_hash text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,public
as $$
declare
 v_role text;
 v_existing executive_visuals.subscription_allowance_proposals%rowtype;
 v_event jsonb;
 v_id uuid;
begin
 if p_actor_id is null or jsonb_typeof(p_proposal)<>'object'
  or p_canonical_proposal is null or octet_length(p_canonical_proposal)>16384
  or p_canonical_proposal::jsonb is distinct from p_proposal
  or p_proposal_hash is null or p_proposal_hash !~ '^[a-f0-9]{64}$'
  or encode(digest(convert_to(p_canonical_proposal,'UTF8'),'sha256'),'hex')<>p_proposal_hash then
  raise exception using errcode='22023',message='subscription_allowance_proposal_hash_invalid';
 end if;
 select role into v_role from executive_visuals.platform_admins where user_id=p_actor_id;
 if v_role not in('owner','billing_admin','platform_admin') then
  raise exception using errcode='42501',message='subscription_allowance_proposal_admin_required';
 end if;
 if p_proposal->>'currency' is distinct from 'USD'
  or coalesce((p_proposal->>'planVersion')::integer,0)<1
  or coalesce((p_proposal->>'monthlyPriceMinor')::bigint,0)<1
  or coalesce((p_proposal->>'includedCredits')::bigint,0)<1
  or coalesce((p_proposal->>'providerCostPerCustomerCreditMinor')::bigint,0)<1
  or p_proposal->'costEvidence'->>'status' is distinct from 'verified_measured'
  or coalesce((p_proposal->'costEvidence'->>'sampleJobs')::integer,0)<5
  or coalesce((p_proposal->'costEvidence'->>'sampleCredits')::bigint,0)<1
  or coalesce((p_proposal->'costEvidence'->>'totalProviderCostMinor')::bigint,0)<1
  or p_proposal->'costEvidence'->>'evidenceDigest' !~ '^[a-f0-9]{64}
  or nullif(p_proposal->'costEvidence'->>'rateCardVersion','') is null
  or nullif(p_proposal->'costEvidence'->>'periodStart','') is null
  or nullif(p_proposal->'costEvidence'->>'periodEnd','') is null
  or (p_proposal->'costEvidence'->>'periodEnd')::timestamptz <= (p_proposal->'costEvidence'->>'periodStart')::timestamptz then
  raise exception using errcode='22023',message='subscription_allowance_invoice_evidence_required';
 end if;
 select * into v_existing from executive_visuals.subscription_allowance_proposals
  where proposal_hash=p_proposal_hash;
 if found then
  if v_existing.canonical_proposal<>p_canonical_proposal then
   raise exception using errcode='23505',message='subscription_allowance_proposal_hash_conflict';
  end if;
  return jsonb_build_object('duplicate',true,'proposalId',v_existing.id,'proposalHash',v_existing.proposal_hash);
 end if;
 if p_event_envelope->>'eventType' is distinct from 'subscription_allowance.proposal_created'
  or p_event_envelope->>'actorId' is distinct from p_actor_id::text
  or p_event_envelope->'payload'->>'proposalHash' is distinct from p_proposal_hash then
  raise exception using errcode='22023',message='subscription_allowance_proposal_audit_mismatch';
 end if;
 v_event:=executive_visuals.append_financial_audit_event(
  p_actor_id,p_actor_id,p_event_envelope->>'idempotencyKey',
  p_event_envelope,p_canonical_event,p_event_hash
 );
 if coalesce((v_event->>'duplicate')::boolean,false) then
  return jsonb_build_object('duplicate',true,'audit',v_event);
 end if;
 insert into executive_visuals.subscription_allowance_proposals(
  proposal_hash,plan_code,plan_version,currency,monthly_price_minor,
  included_credits,provider_cost_per_credit_minor,proposal,canonical_proposal,created_by
 ) values(
  p_proposal_hash,p_proposal->>'planCode',(p_proposal->>'planVersion')::integer,
  p_proposal->>'currency',(p_proposal->>'monthlyPriceMinor')::bigint,
  (p_proposal->>'includedCredits')::bigint,
  (p_proposal->>'providerCostPerCustomerCreditMinor')::bigint,
  p_proposal,p_canonical_proposal,p_actor_id
 ) returning id into v_id;
 return jsonb_build_object('duplicate',false,'proposalId',v_id,'proposalHash',p_proposal_hash,
  'status','awaiting_dual_approval','publishable',false,'audit',v_event);
end $$;
revoke all on function executive_visuals.create_subscription_allowance_proposal(uuid,jsonb,text,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function executive_visuals.create_subscription_allowance_proposal(uuid,jsonb,text,text,jsonb,text,text) to service_role;

create or replace function executive_visuals.record_subscription_allowance_approval(
 p_actor_id uuid,p_proposal_id uuid,p_stage text,p_decision text,p_decision_note text,
 p_event_envelope jsonb,p_canonical_event text,p_event_hash text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,public
as $$
declare
 v_role text;
 v_expected_role text;
 v_proposal executive_visuals.subscription_allowance_proposals%rowtype;
 v_other executive_visuals.subscription_allowance_approvals%rowtype;
 v_event jsonb;
 v_approval executive_visuals.subscription_allowance_approvals%rowtype;
 v_status text;
begin
 if p_actor_id is null or p_proposal_id is null
  or p_stage not in('finance','product') or p_decision not in('approved','rejected')
  or length(coalesce(p_decision_note,''))>1000 then
  raise exception using errcode='22023',message='subscription_allowance_approval_input_invalid';
 end if;
 v_expected_role:=case p_stage when 'finance' then 'billing_admin' when 'product' then 'platform_admin' end;
 select role into v_role from executive_visuals.platform_admins where user_id=p_actor_id;
 if v_role is distinct from v_expected_role then
  raise exception using errcode='42501',message='subscription_allowance_approval_role_required';
 end if;
 select * into v_proposal from executive_visuals.subscription_allowance_proposals
  where id=p_proposal_id for update;
 if not found then raise exception using errcode='P0002',message='subscription_allowance_proposal_not_found'; end if;
 if p_actor_id=v_proposal.created_by then
  raise exception using errcode='42501',message='subscription_allowance_creator_cannot_approve';
 end if;
 if p_event_envelope->>'eventType' is distinct from 'subscription_allowance.approval_recorded'
  or p_event_envelope->>'actorId' is distinct from p_actor_id::text
  or p_event_envelope->'payload'->>'proposalId' is distinct from p_proposal_id::text
  or p_event_envelope->'payload'->>'stage' is distinct from p_stage
  or p_event_envelope->'payload'->>'decision' is distinct from p_decision then
  raise exception using errcode='22023',message='subscription_allowance_approval_audit_mismatch';
 end if;
 v_event:=executive_visuals.append_financial_audit_event(
  p_actor_id,p_actor_id,p_event_envelope->>'idempotencyKey',
  p_event_envelope,p_canonical_event,p_event_hash
 );
 if coalesce((v_event->>'duplicate')::boolean,false) then
  return jsonb_build_object('duplicate',true,'audit',v_event);
 end if;
 select * into v_other from executive_visuals.subscription_allowance_approvals
  where proposal_id=p_proposal_id and stage<>p_stage;
 if found and v_other.actor_id=p_actor_id then
  raise exception using errcode='42501',message='subscription_allowance_approvers_must_be_distinct';
 end if;
 if exists(select 1 from executive_visuals.subscription_allowance_approvals
  where proposal_id=p_proposal_id and decision='rejected') then
  raise exception using errcode='22023',message='subscription_allowance_proposal_already_rejected';
 end if;
 if exists(select 1 from executive_visuals.subscription_allowance_approvals
  where proposal_id=p_proposal_id and stage=p_stage) then
  raise exception using errcode='23505',message='subscription_allowance_stage_already_decided';
 end if;
 insert into executive_visuals.subscription_allowance_approvals(
  proposal_id,stage,actor_id,actor_role,decision,decision_note,audit_event_id
 ) values(p_proposal_id,p_stage,p_actor_id,v_role,p_decision,
  nullif(btrim(p_decision_note),''),(v_event->>'eventId')::uuid)
 returning * into v_approval;
 select case
  when bool_or(decision='rejected') then 'rejected'
  when count(*)=2 and count(distinct actor_id)=2 then 'approved'
  else 'awaiting_dual_approval' end into v_status
 from executive_visuals.subscription_allowance_approvals where proposal_id=p_proposal_id;
 return jsonb_build_object('duplicate',false,'approval',to_jsonb(v_approval),
  'status',v_status,'eligibleToPublish',v_status='approved','publishable',false,'audit',v_event);
end $$;
revoke all on function executive_visuals.record_subscription_allowance_approval(uuid,uuid,text,text,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function executive_visuals.record_subscription_allowance_approval(uuid,uuid,text,text,text,jsonb,text,text) to service_role;

create or replace function executive_visuals.get_subscription_allowance_approval_status(p_proposal_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,executive_visuals
as $$
declare v_proposal executive_visuals.subscription_allowance_proposals%rowtype; v_approvals jsonb; v_status text;
begin
 select * into v_proposal from executive_visuals.subscription_allowance_proposals where id=p_proposal_id;
 if not found then return null; end if;
 select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at),'[]'::jsonb) into v_approvals
 from executive_visuals.subscription_allowance_approvals a where a.proposal_id=p_proposal_id;
 select case
  when bool_or(decision='rejected') then 'rejected'
  when count(*)=2 and count(distinct actor_id)=2 then 'approved'
  else 'awaiting_dual_approval' end into v_status
 from executive_visuals.subscription_allowance_approvals where proposal_id=p_proposal_id;
 return jsonb_build_object('proposal',to_jsonb(v_proposal),'approvals',v_approvals,
  'status',coalesce(v_status,'awaiting_dual_approval'),'eligibleToPublish',coalesce(v_status='approved',false),
  'publishable',false);
end $$;
revoke all on function executive_visuals.get_subscription_allowance_approval_status(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.get_subscription_allowance_approval_status(uuid) to service_role;

  or p_proposal->'costEvidence'->>'approved' is distinct from 'false'
  or nullif(p_proposal->'costEvidence'->>'source','') is null
  or nullif(p_proposal->'costEvidence'->>'rateCardVersion','') is null
  or nullif(p_proposal->'costEvidence'->>'periodStart','') is null
  or nullif(p_proposal->'costEvidence'->>'periodEnd','') is null
  or (p_proposal->'costEvidence'->>'periodEnd')::timestamptz <= (p_proposal->'costEvidence'->>'periodStart')::timestamptz then
  raise exception using errcode='22023',message='subscription_allowance_invoice_evidence_required';
 end if;
 select * into v_existing from executive_visuals.subscription_allowance_proposals
  where proposal_hash=p_proposal_hash;
 if found then
  if v_existing.canonical_proposal<>p_canonical_proposal then
   raise exception using errcode='23505',message='subscription_allowance_proposal_hash_conflict';
  end if;
  return jsonb_build_object('duplicate',true,'proposalId',v_existing.id,'proposalHash',v_existing.proposal_hash);
 end if;
 if p_event_envelope->>'eventType' is distinct from 'subscription_allowance.proposal_created'
  or p_event_envelope->>'actorId' is distinct from p_actor_id::text
  or p_event_envelope->'payload'->>'proposalHash' is distinct from p_proposal_hash then
  raise exception using errcode='22023',message='subscription_allowance_proposal_audit_mismatch';
 end if;
 v_event:=executive_visuals.append_financial_audit_event(
  p_actor_id,p_actor_id,p_event_envelope->>'idempotencyKey',
  p_event_envelope,p_canonical_event,p_event_hash
 );
 if coalesce((v_event->>'duplicate')::boolean,false) then
  return jsonb_build_object('duplicate',true,'audit',v_event);
 end if;
 insert into executive_visuals.subscription_allowance_proposals(
  proposal_hash,plan_code,plan_version,currency,monthly_price_minor,
  included_credits,provider_cost_per_credit_minor,proposal,canonical_proposal,created_by
 ) values(
  p_proposal_hash,p_proposal->>'planCode',(p_proposal->>'planVersion')::integer,
  p_proposal->>'currency',(p_proposal->>'monthlyPriceMinor')::bigint,
  (p_proposal->>'includedCredits')::bigint,
  (p_proposal->>'providerCostPerCustomerCreditMinor')::bigint,
  p_proposal,p_canonical_proposal,p_actor_id
 ) returning id into v_id;
 return jsonb_build_object('duplicate',false,'proposalId',v_id,'proposalHash',p_proposal_hash,
  'status','awaiting_dual_approval','publishable',false,'audit',v_event);
end $$;
revoke all on function executive_visuals.create_subscription_allowance_proposal(uuid,jsonb,text,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function executive_visuals.create_subscription_allowance_proposal(uuid,jsonb,text,text,jsonb,text,text) to service_role;

create or replace function executive_visuals.record_subscription_allowance_approval(
 p_actor_id uuid,p_proposal_id uuid,p_stage text,p_decision text,p_decision_note text,
 p_event_envelope jsonb,p_canonical_event text,p_event_hash text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,public
as $$
declare
 v_role text;
 v_expected_role text;
 v_proposal executive_visuals.subscription_allowance_proposals%rowtype;
 v_other executive_visuals.subscription_allowance_approvals%rowtype;
 v_event jsonb;
 v_approval executive_visuals.subscription_allowance_approvals%rowtype;
 v_status text;
begin
 if p_actor_id is null or p_proposal_id is null
  or p_stage not in('finance','product') or p_decision not in('approved','rejected')
  or length(coalesce(p_decision_note,''))>1000 then
  raise exception using errcode='22023',message='subscription_allowance_approval_input_invalid';
 end if;
 v_expected_role:=case p_stage when 'finance' then 'billing_admin' when 'product' then 'platform_admin' end;
 select role into v_role from executive_visuals.platform_admins where user_id=p_actor_id;
 if v_role is distinct from v_expected_role then
  raise exception using errcode='42501',message='subscription_allowance_approval_role_required';
 end if;
 select * into v_proposal from executive_visuals.subscription_allowance_proposals
  where id=p_proposal_id for update;
 if not found then raise exception using errcode='P0002',message='subscription_allowance_proposal_not_found'; end if;
 if p_actor_id=v_proposal.created_by then
  raise exception using errcode='42501',message='subscription_allowance_creator_cannot_approve';
 end if;
 if p_event_envelope->>'eventType' is distinct from 'subscription_allowance.approval_recorded'
  or p_event_envelope->>'actorId' is distinct from p_actor_id::text
  or p_event_envelope->'payload'->>'proposalId' is distinct from p_proposal_id::text
  or p_event_envelope->'payload'->>'stage' is distinct from p_stage
  or p_event_envelope->'payload'->>'decision' is distinct from p_decision then
  raise exception using errcode='22023',message='subscription_allowance_approval_audit_mismatch';
 end if;
 v_event:=executive_visuals.append_financial_audit_event(
  p_actor_id,p_actor_id,p_event_envelope->>'idempotencyKey',
  p_event_envelope,p_canonical_event,p_event_hash
 );
 if coalesce((v_event->>'duplicate')::boolean,false) then
  return jsonb_build_object('duplicate',true,'audit',v_event);
 end if;
 select * into v_other from executive_visuals.subscription_allowance_approvals
  where proposal_id=p_proposal_id and stage<>p_stage;
 if found and v_other.actor_id=p_actor_id then
  raise exception using errcode='42501',message='subscription_allowance_approvers_must_be_distinct';
 end if;
 if exists(select 1 from executive_visuals.subscription_allowance_approvals
  where proposal_id=p_proposal_id and decision='rejected') then
  raise exception using errcode='22023',message='subscription_allowance_proposal_already_rejected';
 end if;
 if exists(select 1 from executive_visuals.subscription_allowance_approvals
  where proposal_id=p_proposal_id and stage=p_stage) then
  raise exception using errcode='23505',message='subscription_allowance_stage_already_decided';
 end if;
 insert into executive_visuals.subscription_allowance_approvals(
  proposal_id,stage,actor_id,actor_role,decision,decision_note,audit_event_id
 ) values(p_proposal_id,p_stage,p_actor_id,v_role,p_decision,
  nullif(btrim(p_decision_note),''),(v_event->>'eventId')::uuid)
 returning * into v_approval;
 select case
  when bool_or(decision='rejected') then 'rejected'
  when count(*)=2 and count(distinct actor_id)=2 then 'approved'
  else 'awaiting_dual_approval' end into v_status
 from executive_visuals.subscription_allowance_approvals where proposal_id=p_proposal_id;
 return jsonb_build_object('duplicate',false,'approval',to_jsonb(v_approval),
  'status',v_status,'eligibleToPublish',v_status='approved','publishable',false,'audit',v_event);
end $$;
revoke all on function executive_visuals.record_subscription_allowance_approval(uuid,uuid,text,text,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function executive_visuals.record_subscription_allowance_approval(uuid,uuid,text,text,text,jsonb,text,text) to service_role;

create or replace function executive_visuals.get_subscription_allowance_approval_status(p_proposal_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,executive_visuals
as $$
declare v_proposal executive_visuals.subscription_allowance_proposals%rowtype; v_approvals jsonb; v_status text;
begin
 select * into v_proposal from executive_visuals.subscription_allowance_proposals where id=p_proposal_id;
 if not found then return null; end if;
 select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at),'[]'::jsonb) into v_approvals
 from executive_visuals.subscription_allowance_approvals a where a.proposal_id=p_proposal_id;
 select case
  when bool_or(decision='rejected') then 'rejected'
  when count(*)=2 and count(distinct actor_id)=2 then 'approved'
  else 'awaiting_dual_approval' end into v_status
 from executive_visuals.subscription_allowance_approvals where proposal_id=p_proposal_id;
 return jsonb_build_object('proposal',to_jsonb(v_proposal),'approvals',v_approvals,
  'status',coalesce(v_status,'awaiting_dual_approval'),'eligibleToPublish',coalesce(v_status='approved',false),
  'publishable',false);
end $$;
revoke all on function executive_visuals.get_subscription_allowance_approval_status(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.get_subscription_allowance_approval_status(uuid) to service_role;
