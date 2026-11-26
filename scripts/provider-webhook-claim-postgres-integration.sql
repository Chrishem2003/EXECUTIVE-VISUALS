-- Batch 139: webhook claim concurrency and lease-recovery integration.
-- Run against the disposable PostgreSQL fixture created by the CI bootstrap.

do $$
declare
  provider_name constant text := 'paddle';
  event_key_value constant text := repeat('a',64);
  payload_hash_value constant text := repeat('b',64);
  event_id_value uuid;
  result jsonb;
begin
  insert into executive_visuals.payment_webhook_events(
    provider,event_key,event_type,payload_hash,signature_verified,
    processing_status,payload
  ) values (
    provider_name,event_key_value,'transaction.completed',payload_hash_value,
    true,'received','{"test":true}'::jsonb
  )
  returning id into event_id_value;

  result:=executive_visuals.claim_payment_webhook_event(
    provider_name,event_key_value,payload_hash_value,300
  );
  if result->>'claimed'<>'true' or (result->>'attempt')::integer<>1 then
    raise exception 'First webhook claim did not acquire attempt one';
  end if;

  result:=executive_visuals.claim_payment_webhook_event(
    provider_name,event_key_value,payload_hash_value,300
  );
  if result->>'claimed'<>'false' or result->>'inProgress'<>'true' then
    raise exception 'Concurrent webhook delivery was not held behind the active lease';
  end if;

  update executive_visuals.payment_webhook_events
     set processing_started_at=now()-interval '10 minutes'
   where id=event_id_value;
  result:=executive_visuals.claim_payment_webhook_event(
    provider_name,event_key_value,payload_hash_value,300
  );
  if result->>'claimed'<>'true' or (result->>'attempt')::integer<>2 then
    raise exception 'Expired webhook processing lease was not recovered';
  end if;

  update executive_visuals.payment_webhook_events
     set processing_status='processed',processing_started_at=null,
         processed_at=now()
   where id=event_id_value;
  result:=executive_visuals.claim_payment_webhook_event(
    provider_name,event_key_value,payload_hash_value,300
  );
  if result->>'claimed'<>'false' or result->>'processingStatus'<>'processed' then
    raise exception 'Processed webhook was not treated as an idempotent duplicate';
  end if;

  begin
    perform executive_visuals.claim_payment_webhook_event(
      provider_name,event_key_value,repeat('c',64),300
    );
    raise exception 'Payload hash conflict unexpectedly acquired a claim';
  exception when unique_violation then
    null;
  end;

  delete from executive_visuals.payment_webhook_events where id=event_id_value;
end;
$$;
