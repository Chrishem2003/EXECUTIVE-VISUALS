-- Batch 139 PostgreSQL integration tests. Run after the webhook lease migration.
begin;

insert into executive_visuals.payment_webhook_events
  (provider,event_key,event_type,payload_hash,signature_verified,processing_status,payload)
values
  ('paddle',repeat('a',64),'transaction.completed',repeat('b',64),true,'received','{}'::jsonb),
  ('pesapal',repeat('c',64),'payment.completed',repeat('d',64),true,'failed','{}'::jsonb),
  ('flutterwave',repeat('e',64),'payment.completed',repeat('f',64),false,'received','{}'::jsonb);

do $$
declare
  first_claim jsonb;
  concurrent_claim jsonb;
  recovered_claim jsonb;
  terminal_claim jsonb;
  failed_claim jsonb;
  first_lease uuid;
begin
  first_claim:=executive_visuals.claim_payment_webhook_event('paddle',repeat('a',64),repeat('b',64),300);
  if (first_claim->>'claimed')::boolean is not true
     or first_claim->>'processingStatus'<>'processing'
     or (first_claim->>'attempt')::integer<>1 then
    raise exception 'First webhook claim did not acquire attempt 1';
  end if;
  first_lease:=(first_claim->>'leaseId')::uuid;

  begin
    perform executive_visuals.claim_payment_webhook_event('paddle',repeat('a',64),repeat('9',64),300);
    raise exception 'Payload hash conflict was accepted';
  exception when unique_violation then
    null;
  end;

  begin
    perform executive_visuals.claim_payment_webhook_event('flutterwave',repeat('e',64),repeat('f',64),300);
    raise exception 'Unverified provider event was accepted';
  exception when insufficient_privilege then
    null;
  end;

  concurrent_claim:=executive_visuals.claim_payment_webhook_event('paddle',repeat('a',64),repeat('b',64),300);
  if (concurrent_claim->>'claimed')::boolean is not false
     or concurrent_claim->>'processingStatus'<>'processing' then
    raise exception 'Concurrent duplicate webhook claim was not blocked';
  end if;

  update executive_visuals.payment_webhook_events
     set processing_started_at=now()-interval '10 minutes'
   where provider='paddle' and event_key=repeat('a',64);
  recovered_claim:=executive_visuals.claim_payment_webhook_event('paddle',repeat('a',64),repeat('b',64),300);
  if (recovered_claim->>'claimed')::boolean is not true
     or (recovered_claim->>'attempt')::integer<>2
     or (recovered_claim->>'leaseId')::uuid=first_lease then
    raise exception 'Expired webhook lease was not safely recovered';
  end if;

  update executive_visuals.payment_webhook_events
     set processing_status='processed',processing_started_at=null,processing_lease_id=null
   where provider='paddle' and event_key=repeat('a',64);
  terminal_claim:=executive_visuals.claim_payment_webhook_event('paddle',repeat('a',64),repeat('b',64),300);
  if (terminal_claim->>'claimed')::boolean is not false
     or terminal_claim->>'processingStatus'<>'processed' then
    raise exception 'Processed webhook event was incorrectly reclaimed';
  end if;

  failed_claim:=executive_visuals.claim_payment_webhook_event('pesapal',repeat('c',64),repeat('d',64),300);
  if (failed_claim->>'claimed')::boolean is not true
     or (failed_claim->>'attempt')::integer<>1 then
    raise exception 'Failed webhook event was not retryable';
  end if;
end;
$$;

rollback;
