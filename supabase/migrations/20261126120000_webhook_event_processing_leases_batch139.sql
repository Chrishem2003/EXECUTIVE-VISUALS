-- Batch 139: durable, fenced webhook event processing claims.
-- Allows safe recovery after a process crash without concurrent duplicate settlement.

alter table executive_visuals.payment_webhook_events
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_lease_id uuid,
  add column if not exists processing_attempts integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid='executive_visuals.payment_webhook_events'::regclass
       and conname='payment_webhook_events_processing_attempts_check'
  ) then
    alter table executive_visuals.payment_webhook_events
      add constraint payment_webhook_events_processing_attempts_check
      check (processing_attempts >= 0);
  end if;
end;
$$;

create index if not exists payment_webhook_events_processing_lease_idx
  on executive_visuals.payment_webhook_events(processing_status,processing_started_at)
  where processing_status in ('received','processing','failed');

create or replace function executive_visuals.claim_payment_webhook_event(
  p_provider text,
  p_event_key text,
  p_payload_hash text,
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
  event_row executive_visuals.payment_webhook_events%rowtype;
  next_lease uuid;
begin
  if p_provider not in ('flutterwave','paddle','pesapal')
     or p_event_key !~ '^[a-f0-9]{64}$'
     or p_payload_hash !~ '^[a-f0-9]{64}$'
     or p_lease_seconds not between 30 and 900 then
    raise exception 'Invalid payment webhook claim input' using errcode='22023';
  end if;

  select * into event_row
    from payment_webhook_events
   where provider=p_provider and event_key=p_event_key
   for update;

  if not found then
    return jsonb_build_object('claimed',false,'processingStatus','missing');
  end if;

  if event_row.payload_hash<>p_payload_hash then
    raise exception 'Provider event payload hash conflict' using errcode='23505';
  end if;

  if event_row.processing_status in ('processed','ignored','needs_review') then
    return jsonb_build_object('claimed',false,'processingStatus',event_row.processing_status);
  end if;

  if event_row.processing_status='processing'
     and event_row.processing_started_at is not null
     and event_row.processing_started_at > now()-make_interval(secs=>p_lease_seconds) then
    return jsonb_build_object('claimed',false,'processingStatus','processing');
  end if;

  next_lease:=gen_random_uuid();
  update payment_webhook_events
     set processing_status='processing',
         processing_started_at=now(),
         processing_lease_id=next_lease,
         processing_attempts=processing_attempts+1,
         error_message=null
   where id=event_row.id;

  return jsonb_build_object(
    'claimed',true,
    'processingStatus','processing',
    'leaseId',next_lease,
    'attempt',event_row.processing_attempts+1
  );
end;
$$;

revoke all on function executive_visuals.claim_payment_webhook_event(text,text,text,integer)
  from public,anon,authenticated;
grant execute on function executive_visuals.claim_payment_webhook_event(text,text,text,integer)
  to service_role;
