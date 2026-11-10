-- Batch 30 persistent financial audit ledger integration checks.
reset role;
insert into auth.users(id) values
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222')
on conflict(id) do nothing;
set role service_role;
do $batch30$
declare
 v_owner constant uuid:='11111111-1111-4111-8111-111111111111';
 v_actor constant uuid:='22222222-2222-4222-8222-222222222222';
 v_event jsonb;
 v_canonical text;
 v_hash text;
 v_first jsonb;
 v_replay jsonb;
 v_second jsonb;
 v_head jsonb;
 v_count integer;
begin
 v_event:=jsonb_build_object(
  'canonicalizationVersion',1,'hashAlgorithm','SHA-256',
  'eventId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'sequence',1,'ownerId',v_owner,'actorId',v_actor,
  'eventType','close_period.created','occurredAt','2026-11-10T12:00:00.000Z',
  'payload',jsonb_build_object('period','2026-10','currency','UGX'),
  'idempotencyKey','batch30-close-created','previousHash',repeat('0',64)
 );
 -- Canonical JSON bytes are supplied by the Node implementation and checked by the SQL RPC.
 v_canonical:='{"actorId":"22222222-2222-4222-8222-222222222222","canonicalizationVersion":1,"eventId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","eventType":"close_period.created","hashAlgorithm":"SHA-256","idempotencyKey":"batch30-close-created","occurredAt":"2026-11-10T12:00:00.000Z","ownerId":"11111111-1111-4111-8111-111111111111","payload":{"currency":"UGX","period":"2026-10"},"previousHash":"'||repeat('0',64)||'","sequence":1}';
 v_hash:=encode(digest(convert_to(v_canonical,'UTF8'),'sha256'),'hex');
 v_first:=executive_visuals.append_financial_audit_event(v_owner,v_actor,'batch30-close-created',v_event,v_canonical,v_hash);
 if v_first->>'duplicate'<>'false' or (v_first->>'sequence')::bigint<>1 then
  raise exception 'First financial audit event was not appended: %',v_first;
 end if;
 v_replay:=executive_visuals.append_financial_audit_event(v_owner,v_actor,'batch30-close-created',v_event,v_canonical,v_hash);
 if v_replay->>'duplicate'<>'true' or (v_replay->>'sequence')::bigint<>1 then
  raise exception 'Audit event retry was not idempotent: %',v_replay;
 end if;
 v_second:=jsonb_build_object(
  'canonicalizationVersion',1,'hashAlgorithm','SHA-256',
  'eventId','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'sequence',2,'ownerId',v_owner,'actorId',v_actor,
  'eventType','close_task.assigned','occurredAt','2026-11-10T12:01:00.000Z',
  'payload',jsonb_build_object('taskId','cash'),
  'idempotencyKey','batch30-task-cash','previousHash',v_hash
 );
 v_canonical:='{"actorId":"22222222-2222-4222-8222-222222222222","canonicalizationVersion":1,"eventId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","eventType":"close_task.assigned","hashAlgorithm":"SHA-256","idempotencyKey":"batch30-task-cash","occurredAt":"2026-11-10T12:01:00.000Z","ownerId":"11111111-1111-4111-8111-111111111111","payload":{"taskId":"cash"},"previousHash":"'||v_hash||'","sequence":2}';
 v_hash:=encode(digest(convert_to(v_canonical,'UTF8'),'sha256'),'hex');
 v_second:=executive_visuals.append_financial_audit_event(v_owner,v_actor,'batch30-task-cash',v_second,v_canonical,v_hash);
 if (v_second->>'sequence')::bigint<>2 then raise exception 'Second event sequence was not contiguous: %',v_second; end if;
 v_head:=executive_visuals.get_financial_audit_head(v_owner);
 if (v_head->>'sequence')::bigint<>2 or v_head->>'headHash'<>v_hash then
  raise exception 'Audit head does not match the appended event chain: %',v_head;
 end if;
 select count(*) into v_count from executive_visuals.financial_audit_events where owner_id=v_owner;
 if v_count<>2 then raise exception 'Idempotent retry created duplicate audit rows'; end if;
 begin
  update executive_visuals.financial_audit_events set event_type='evidence.attached' where owner_id=v_owner and sequence_number=1;
  raise exception 'Audit event update unexpectedly succeeded';
 exception when others then
  if sqlerrm='Audit event update unexpectedly succeeded' then raise; end if;
 end;
 begin
  delete from executive_visuals.financial_audit_events where owner_id=v_owner and sequence_number=1;
  raise exception 'Audit event delete unexpectedly succeeded';
 exception when others then
  if sqlerrm='Audit event delete unexpectedly succeeded' then raise; end if;
 end;
end
$batch30$;
reset role;
