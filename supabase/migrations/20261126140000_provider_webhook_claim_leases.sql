-- Batch 139: serialize provider webhook processing and recover abandoned claims.
-- Additive only; existing event identity and payload hashes remain authoritative.

alter table executive_visuals.payment_webhook_events
  add column if not exists processing_started_at timestamptz,
  add column if not exists attempt_count integer not null default 0
    check (attempt_count between 0 and 100);

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
  lease_interval interval;
begin
  if lower(coalesce(p_provider,'')) not in ('flutterwave','paddle','pesapal')
     or p_event_key is null or char_length(p_event_key)<>64
     or p_event_key !~ '^[a-f0-9]{64}$'
     or p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$'
     or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'Invalid provider webhook claim input' using errcode='22023';
  end if;

  select * into event_row
    from executive_visuals.payment_webhook_events
   where provider=lower(p_provider) and event_key=p_event_key
   for update;
  if not found then
    raise exception 'Provider webhook event was not persisted before claim' using errcode='P0002';
  end if;
  if event_row.payload_hash<>p_payload_hash then
    raise exception 'Provider event ID was replayed with different payload content' using errcode='23505';
  end if;
  if event_row.signature_verified is not true then
    raise exception 'Unverified provider event cannot be claimed' using errcode='42501';
  end if;

  if event_row.processing_status in ('processed','ignored','needs_review') then
    return jsonb_build_object(
      'claimed',false,'duplicate',true,
      'processingStatus',event_row.processing_status,
      'attempt',event_row.attempt_count
    );
  end if;

  lease_interval:=make_interval(secs=>p_lease_seconds);
  if event_row.processing_status='processing'
     and event_row.processing_started_at is not null
     and event_row.processing_started_at>now()-lease_interval then
    return jsonb_build_object(
      'claimed',false,'duplicate',true,'inProgress',true,
      'processingStatus','processing','attempt',event_row.attempt_count
    );
  end if;

  update executive_visuals.payment_webhook_events
     set processing_status='processing',
         processing_started_at=now(),
         attempt_count=attempt_count+1,
         error_message=null
   where id=event_row.id;

  return jsonb_build_object(
    'claimed',true,'duplicate',false,
    'processingStatus','processing',
    'attempt',event_row.attempt_count+1
  );
end;
$$;

revoke all on function executive_visuals.claim_payment_webhook_event(text,text,text,integer)
  from public,anon,authenticated;
grant execute on function executive_visuals.claim_payment_webhook_event(text,text,text,integer)
  to service_role;
