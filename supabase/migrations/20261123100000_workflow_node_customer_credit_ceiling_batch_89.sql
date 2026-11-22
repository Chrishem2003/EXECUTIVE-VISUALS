-- Batch 89: require an explicit customer-credit ceiling and a server-priced
-- reservation amount for workflow-node approvals. The caller is the authenticated
-- application server; browser-supplied credit quantities are never trusted.
-- The old 10-argument RPC is revoked so stale callers cannot bypass the new gate.

create or replace function executive_visuals.approve_and_enqueue_video_workflow(
  p_quote_id uuid,
  p_approval_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_request_hash text,
  p_config_id text,
  p_idempotency_key text,
  p_input jsonb,
  p_approved_max_amount numeric,
  p_approval_note text,
  p_customer_credit_budget_credits bigint,
  p_required_customer_credits bigint
)
returns table(
  job_id uuid,
  job_status text,
  idempotent_replay boolean,
  budget_reservation_id uuid,
  approval_id uuid
)
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $approve_and_enqueue_video_workflow$
declare
  quote_row executive_visuals.video_workflow_quotes;
  existing executive_visuals.jobs;
  policy executive_visuals.video_generation_budget_policies;
  enqueued record;
  reservation_id uuid;
  consumed_approval_id uuid;
  reservation_amount numeric;
  credit_reservation record;
begin
  if p_quote_id is null or p_approval_id is null or p_owner_id is null or p_project_id is null
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_config_id is null or p_config_id !~ '^[a-z][a-z0-9_-]{0,63}$'
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,180}$'
     or jsonb_typeof(p_input) is distinct from 'object'
     or octet_length(p_input::text) > 32000
     or p_approved_max_amount is null or p_approved_max_amount <= 0 or p_approved_max_amount > 1000000
     or p_approval_note is null or char_length(btrim(p_approval_note)) < 1
     or char_length(p_approval_note) > 1000
     or p_customer_credit_budget_credits is null or p_customer_credit_budget_credits < 1
     or p_customer_credit_budget_credits > 100000000
     or p_required_customer_credits is null or p_required_customer_credits < 1
     or p_required_customer_credits > 100000000
     or p_customer_credit_budget_credits < p_required_customer_credits
     or coalesce(p_input->>'customerCreditBudgetCredits','') !~ '^[1-9][0-9]{0,8}$'
     or coalesce(p_input->>'requiredCustomerCredits','') !~ '^[1-9][0-9]{0,8}$'
     or (p_input->>'customerCreditBudgetCredits')::bigint <> p_customer_credit_budget_credits
     or (p_input->>'requiredCustomerCredits')::bigint <> p_required_customer_credits then
    raise exception 'VIDEO_WORKFLOW_CUSTOMER_CREDIT_BUDGET_INVALID';
  end if;

  select * into quote_row
  from executive_visuals.video_workflow_quotes q
  where q.id = p_quote_id
  for update;

  if quote_row.id is null
     or quote_row.owner_id is distinct from p_owner_id
     or quote_row.project_id is distinct from p_project_id then
    raise exception 'VIDEO_WORKFLOW_QUOTE_NOT_FOUND';
  end if;

  if quote_row.estimated_customer_credits is null
     or quote_row.estimated_customer_credits < 1
     or p_required_customer_credits < quote_row.estimated_customer_credits then
    raise exception 'VIDEO_WORKFLOW_CUSTOMER_CREDIT_PRICING_REQUIRED';
  end if;

  select * into existing
  from executive_visuals.jobs j
  where j.owner_id = p_owner_id and j.idempotency_key = p_idempotency_key
  for update;

  if existing.id is not null then
    if existing.job_type <> 'video.generate'
       or existing.project_id is distinct from p_project_id
       or coalesce(existing.input ->> 'requestHash','') <> p_request_hash
       or existing.input is distinct from p_input
       or coalesce(existing.input ->> 'workflowQuoteId','') <> p_quote_id::text
       or coalesce(existing.input ->> 'workflowRequestId','') <> quote_row.request_id
       or coalesce(existing.input ->> 'provider','') <> quote_row.provider
       or coalesce(existing.input ->> 'model','') <> quote_row.model
       or quote_row.request_hash <> p_request_hash
       or quote_row.request_id <> p_idempotency_key
       or quote_row.config_id <> p_config_id
       or quote_row.state <> 'consumed' then
      raise exception 'VIDEO_WORKFLOW_APPROVAL_IDEMPOTENCY_CONFLICT';
    end if;

    select r.id, r.approval_id, r.reserved_amount into reservation_id, consumed_approval_id, reservation_amount
    from executive_visuals.video_generation_budget_reservations r
    where r.job_id = existing.id;

    if reservation_id is null or consumed_approval_id is null
       or reservation_amount is distinct from p_approved_max_amount then
      raise exception 'VIDEO_WORKFLOW_APPROVAL_RESERVATION_MISSING';
    end if;

    if not exists (
      select 1 from executive_visuals.billing_credit_reservations cr
      where cr.job_id = existing.id and cr.owner_id = p_owner_id
        and cr.reserved_credits = p_required_customer_credits
    ) then
      raise exception 'VIDEO_WORKFLOW_CUSTOMER_CREDIT_RESERVATION_MISSING';
    end if;

    return query select existing.id, existing.status, true, reservation_id, consumed_approval_id;
    return;
  end if;

  if quote_row.state <> 'quoted' or quote_row.expires_at <= clock_timestamp() then
    raise exception 'VIDEO_WORKFLOW_QUOTE_EXPIRED_OR_CONSUMED';
  end if;

  if quote_row.request_hash <> p_request_hash
     or quote_row.request_id <> p_idempotency_key
     or not ((quote_row.provider='runway' and quote_row.model in ('model-router','gen4.5','seedance2_5','kling_4','kling_4_flash','kling3.0_standard','kling3.0_pro','kling3.0_4k'))
       or (quote_row.provider='google' and quote_row.model='gemini-omni-1.1-flash')
       or (quote_row.provider='luma' and quote_row.model='ray-3.2'))
     or quote_row.config_id <> p_config_id
     or coalesce(p_input ->> 'provider','') <> quote_row.provider
     or coalesce(p_input ->> 'model','') <> quote_row.model
     or coalesce(p_input ->> 'operation','') <> quote_row.operation
     or coalesce(p_input ->> 'requestHash','') <> quote_row.request_hash
     or coalesce(p_input ->> 'projectId','') <> quote_row.project_id::text
     or coalesce(p_input ->> 'workflowQuoteId','') <> quote_row.id::text
     or coalesce(p_input ->> 'workflowRequestId','') <> quote_row.request_id then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_REQUEST_MISMATCH';
  end if;

  if p_approved_max_amount < quote_row.estimated_amount then
    raise exception 'VIDEO_WORKFLOW_APPROVAL_BELOW_QUOTE';
  end if;

  if not exists (
    select 1 from executive_visuals.projects p
    where p.id = p_project_id and p.owner_id = p_owner_id
  ) then
    raise exception 'VIDEO_JOB_PROJECT_FORBIDDEN';
  end if;

  select * into policy
  from executive_visuals.video_generation_budget_policies b
  where b.owner_id = p_owner_id
    and b.project_id = p_project_id
    and b.provider = quote_row.provider
    and b.model = quote_row.model
    and b.currency = quote_row.currency
    and b.enabled = true
  for update;

  if policy.id is null then
    raise exception 'VIDEO_JOB_BUDGET_POLICY_DISABLED';
  end if;

  if p_approved_max_amount > policy.max_per_job_amount
     or policy.reserved_amount + policy.spent_amount + p_approved_max_amount > policy.spend_limit_amount then
    raise exception 'VIDEO_JOB_BUDGET_LIMIT_REACHED';
  end if;

  insert into executive_visuals.video_generation_budget_approvals(
    id,owner_id,project_id,provider,model,request_hash,currency,
    approved_max_amount,approval_note,expires_at
  ) values (
    p_approval_id,p_owner_id,p_project_id,quote_row.provider,quote_row.model,
    quote_row.request_hash,quote_row.currency,p_approved_max_amount,
    btrim(p_approval_note),quote_row.expires_at
  );

  select * into enqueued
  from executive_visuals.enqueue_video_generation_job(
    p_owner_id,p_project_id,p_idempotency_key,quote_row.provider,quote_row.model,
    quote_row.request_hash,p_input,p_approval_id,p_approved_max_amount,quote_row.currency
  );

  if enqueued.job_id is null or enqueued.budget_reservation_id is null then
    raise exception 'VIDEO_WORKFLOW_ENQUEUE_RECEIPT_INVALID';
  end if;

  -- The customer-approved ceiling and the server-priced reservation are both
  -- bound to this transaction. Only the calculated requirement is reserved;
  -- unused headroom remains available in the customer's wallet.
  select * into credit_reservation
  from executive_visuals.reserve_generation_credits(
    p_owner_id,enqueued.job_id,p_required_customer_credits,
    'video-workflow:' || quote_row.id::text
  );
  if credit_reservation.reservation_id is null then
    raise exception 'VIDEO_WORKFLOW_CUSTOMER_CREDIT_RESERVATION_INVALID';
  end if;

  update executive_visuals.video_workflow_quotes
  set state = 'consumed'
  where id = p_quote_id and state = 'quoted';

  if not found then
    raise exception 'VIDEO_WORKFLOW_QUOTE_STATE_CONFLICT';
  end if;

  return query select enqueued.job_id,enqueued.job_status,enqueued.idempotent_replay,
    enqueued.budget_reservation_id,p_approval_id;
end;
$approve_and_enqueue_video_workflow$;

revoke all on function executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text,bigint,bigint)
  from public,anon,authenticated;
grant execute on function executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text,bigint,bigint)
  to service_role;

-- Remove the legacy overload from service-role execution. All current workflow
-- approval callers must use the credit-ceiling-aware signature.
revoke all on function executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)
  from public,anon,authenticated,service_role;
