-- Batch 60: publish only an exact, dual-approved subscription allowance proposal.
-- Publication exposes the approved plan in the catalogue but deliberately does not
-- configure provider prices, enable checkout, charge customers or grant credits.

alter table executive_visuals.subscription_plans
  add column if not exists credit_allowance_published boolean not null default false;

alter table executive_visuals.financial_audit_events
  drop constraint if exists financial_audit_events_event_type_check;
alter table executive_visuals.financial_audit_events
  add constraint financial_audit_events_event_type_check check(event_type in(
    'close_period.created','close_period.submitted','close_period.locked','close_period.reopened',
    'close_task.assigned','close_task.completed','close_task.waived',
    'close_approval.assigned','close_approval.recorded',
    'reconciliation.recorded','reconciliation.reviewed',
    'evidence.attached','evidence.retention_changed',
    'subscription_allowance.proposal_created','subscription_allowance.approval_recorded',
    'subscription_allowance.published'
  ));

create table if not exists executive_visuals.subscription_allowance_publications(
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null unique references executive_visuals.subscription_allowance_proposals(id) on delete restrict,
  proposal_hash text not null unique check(proposal_hash ~ '^[a-f0-9]{64}$'),
  plan_id uuid not null references executive_visuals.subscription_plans(id) on delete restrict,
  plan_code text not null,
  source_plan_version integer not null check(source_plan_version>0),
  published_plan_version integer not null check(published_plan_version>source_plan_version),
  published_by uuid not null references auth.users(id) on delete restrict,
  finance_approval_id uuid not null references executive_visuals.subscription_allowance_approvals(id) on delete restrict,
  product_approval_id uuid not null references executive_visuals.subscription_allowance_approvals(id) on delete restrict,
  audit_event_id uuid not null unique references executive_visuals.financial_audit_events(event_id) on delete restrict,
  created_at timestamptz not null default now(),
  check(finance_approval_id<>product_approval_id)
);
create index if not exists subscription_allowance_publications_plan_idx
  on executive_visuals.subscription_allowance_publications(plan_code,published_plan_version);

alter table executive_visuals.subscription_allowance_publications enable row level security;
revoke all on executive_visuals.subscription_allowance_publications from public,anon,authenticated,service_role;
grant select on executive_visuals.subscription_allowance_publications to service_role;

create or replace function executive_visuals.reject_subscription_allowance_publication_mutation()
returns trigger language plpgsql
set search_path=pg_catalog,executive_visuals
as $$
begin
  raise exception using errcode='55000',message='subscription_allowance_publications_are_immutable';
end $$;
revoke all on function executive_visuals.reject_subscription_allowance_publication_mutation() from public,anon,authenticated,service_role;
drop trigger if exists subscription_allowance_publications_immutable on executive_visuals.subscription_allowance_publications;
create trigger subscription_allowance_publications_immutable
  before update or delete on executive_visuals.subscription_allowance_publications
  for each row execute function executive_visuals.reject_subscription_allowance_publication_mutation();

create or replace function executive_visuals.publish_subscription_allowance_proposal(
  p_actor_id uuid,
  p_proposal_id uuid,
  p_expected_proposal_hash text,
  p_expected_plan_version integer,
  p_event_envelope jsonb,
  p_canonical_event text,
  p_event_hash text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,public
as $$
declare
  v_role text;
  v_proposal executive_visuals.subscription_allowance_proposals%rowtype;
  v_plan executive_visuals.subscription_plans%rowtype;
  v_finance executive_visuals.subscription_allowance_approvals%rowtype;
  v_product executive_visuals.subscription_allowance_approvals%rowtype;
  v_existing executive_visuals.subscription_allowance_publications%rowtype;
  v_event jsonb;
  v_publication_id uuid;
  v_published_version integer;
begin
  if p_actor_id is null or p_proposal_id is null
    or coalesce(p_expected_proposal_hash,'') !~ '^[a-f0-9]{64}$'
    or p_expected_plan_version is null or p_expected_plan_version<1
    or p_canonical_event is null or octet_length(p_canonical_event)>16384
    or p_canonical_event::jsonb is distinct from p_event_envelope
    or p_event_hash is null or p_event_hash !~ '^[a-f0-9]{64}$'
    or encode(digest(convert_to(p_canonical_event,'UTF8'),'sha256'),'hex')<>p_event_hash then
    raise exception using errcode='22023',message='subscription_allowance_publication_input_invalid';
  end if;

  select role into v_role from executive_visuals.platform_admins where user_id=p_actor_id;
  if v_role is distinct from 'owner' and v_role is distinct from 'platform_admin' then
    raise exception using errcode='42501',message='subscription_allowance_publisher_role_required';
  end if;

  select * into v_proposal
    from executive_visuals.subscription_allowance_proposals
    where id=p_proposal_id for update;
  if not found then
    raise exception using errcode='P0002',message='subscription_allowance_proposal_not_found';
  end if;
  if v_proposal.proposal_hash<>p_expected_proposal_hash
    or v_proposal.plan_version<>p_expected_plan_version then
    raise exception using errcode='40001',message='subscription_allowance_proposal_stale';
  end if;

  select * into v_existing from executive_visuals.subscription_allowance_publications
    where proposal_id=p_proposal_id;
  if found then
    if v_existing.proposal_hash<>p_expected_proposal_hash then
      raise exception using errcode='40001',message='subscription_allowance_publication_hash_conflict';
    end if;
    return jsonb_build_object(
      'duplicate',true,'publicationId',v_existing.id,'proposalHash',v_existing.proposal_hash,
      'planCode',v_existing.plan_code,'sourcePlanVersion',v_existing.source_plan_version,
      'publishedPlanVersion',v_existing.published_plan_version,
      'cataloguePublished',true,'checkoutEnabled',false,'creditsGranted',false
    );
  end if;

  select * into v_finance from executive_visuals.subscription_allowance_approvals
    where proposal_id=p_proposal_id and stage='finance' and decision='approved';
  select * into v_product from executive_visuals.subscription_allowance_approvals
    where proposal_id=p_proposal_id and stage='product' and decision='approved';
  if v_finance.id is null or v_product.id is null
    or v_finance.actor_role<>'billing_admin' or v_product.actor_role<>'platform_admin'
    or v_finance.actor_id=v_product.actor_id then
    raise exception using errcode='42501',message='subscription_allowance_dual_approval_required';
  end if;
  if p_actor_id in(v_proposal.created_by,v_finance.actor_id,v_product.actor_id) then
    raise exception using errcode='42501',message='subscription_allowance_publisher_must_be_independent';
  end if;

  select * into v_plan from executive_visuals.subscription_plans
    where plan_code=v_proposal.plan_code for update;
  if not found or v_plan.version<>v_proposal.plan_version
    or v_plan.status<>'draft' or v_plan.is_public
    or v_plan.amount_minor<>v_proposal.monthly_price_minor
    or v_plan.currency<>v_proposal.currency
    or v_plan.name<>(v_proposal.proposal->>'name')
    or v_plan.credit_allowance_published then
    raise exception using errcode='40001',message='subscription_allowance_plan_version_or_draft_state_changed';
  end if;

  if exists(select 1 from executive_visuals.subscription_plan_provider_prices
    where plan_id=v_plan.id and active=true) then
    raise exception using errcode='55000',message='subscription_allowance_active_provider_price_requires_review';
  end if;

  if p_event_envelope->>'eventType' is distinct from 'subscription_allowance.published'
    or p_event_envelope->>'actorId' is distinct from p_actor_id::text
    or p_event_envelope->'payload'->>'proposalId' is distinct from p_proposal_id::text
    or p_event_envelope->'payload'->>'proposalHash' is distinct from p_expected_proposal_hash
    or p_event_envelope->'payload'->>'planCode' is distinct from v_proposal.plan_code
    or coalesce((p_event_envelope->'payload'->>'sourcePlanVersion')::integer,0)<>v_proposal.plan_version then
    raise exception using errcode='22023',message='subscription_allowance_publication_audit_mismatch';
  end if;

  v_event:=executive_visuals.append_financial_audit_event(
    p_actor_id,p_actor_id,p_event_envelope->>'idempotencyKey',
    p_event_envelope,p_canonical_event,p_event_hash
  );
  if coalesce((v_event->>'duplicate')::boolean,false) then
    raise exception using errcode='23505',message='subscription_allowance_publication_audit_replay_without_publication';
  end if;

  update executive_visuals.subscription_plans
    set status='active',is_public=true,
        included_credits=v_proposal.included_credits,
        credit_allowance_published=true,
        version=version+1,updated_at=now()
    where id=v_plan.id and version=v_proposal.plan_version
    returning version into v_published_version;
  if v_published_version is null then
    raise exception using errcode='40001',message='subscription_allowance_plan_version_changed_during_publication';
  end if;

  insert into executive_visuals.subscription_allowance_publications(
    proposal_id,proposal_hash,plan_id,plan_code,source_plan_version,published_plan_version,
    published_by,finance_approval_id,product_approval_id,audit_event_id
  ) values(
    p_proposal_id,p_expected_proposal_hash,v_plan.id,v_plan.plan_code,v_proposal.plan_version,
    v_published_version,p_actor_id,v_finance.id,v_product.id,(v_event->>'eventId')::uuid
  ) returning id into v_publication_id;

  return jsonb_build_object(
    'duplicate',false,'publicationId',v_publication_id,'proposalHash',p_expected_proposal_hash,
    'planCode',v_plan.plan_code,'sourcePlanVersion',v_proposal.plan_version,
    'publishedPlanVersion',v_published_version,'cataloguePublished',true,
    'checkoutEnabled',false,'creditsGranted',false,'audit',v_event
  );
end $$;
revoke all on function executive_visuals.publish_subscription_allowance_proposal(uuid,uuid,text,integer,jsonb,text,text) from public,anon,authenticated;
grant execute on function executive_visuals.publish_subscription_allowance_proposal(uuid,uuid,text,integer,jsonb,text,text) to service_role;
