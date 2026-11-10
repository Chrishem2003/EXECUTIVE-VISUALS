-- Batch 30: persistent append-only financial audit ledger.
-- Hash-chain integrity is computed by the application and independently checked by this database function.
create table if not exists executive_visuals.financial_audit_events(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete restrict,
 actor_id uuid not null references auth.users(id) on delete restrict,
 sequence_number bigint not null check(sequence_number>0),
 event_id uuid not null unique,
 event_type text not null check(event_type in(
  'close_period.created','close_task.assigned','close_task.completed',
  'close_task.waived','reconciliation.reviewed','close_approval.recorded',
  'close_period.reopened','evidence.attached','evidence.retention_changed'
 )),
 occurred_at timestamptz not null,
 idempotency_key text not null check(length(idempotency_key) between 8 and 160),
 event_envelope jsonb not null check(jsonb_typeof(event_envelope)='object'),
 canonicalization_version smallint not null check(canonicalization_version=1),
 hash_algorithm text not null check(hash_algorithm='SHA-256'),
 previous_hash text not null check(previous_hash ~ '^[a-f0-9]{64}$'),
 event_hash text not null check(event_hash ~ '^[a-f0-9]{64}$'),
 canonical_event_bytes text not null check(octet_length(canonical_event_bytes)<=16384),
 created_at timestamptz not null default now(),
 unique(owner_id,sequence_number),
 unique(owner_id,idempotency_key),
 check((event_envelope->>'ownerId')::uuid=owner_id),
 check((event_envelope->>'actorId')::uuid=actor_id),
 check((event_envelope->>'eventId')::uuid=event_id),
 check((event_envelope->>'sequence')::bigint=sequence_number),
 check(event_envelope->>'eventType'=event_type),
 check(event_envelope->>'idempotencyKey'=idempotency_key),
 check(event_envelope->>'previousHash'=previous_hash)
);
create index if not exists financial_audit_events_owner_sequence_idx
 on executive_visuals.financial_audit_events(owner_id,sequence_number desc);
create index if not exists financial_audit_events_owner_time_idx
 on executive_visuals.financial_audit_events(owner_id,occurred_at desc);
alter table executive_visuals.financial_audit_events enable row level security;
revoke all on executive_visuals.financial_audit_events from public,anon,authenticated;
grant select on executive_visuals.financial_audit_events to service_role;
create trigger financial_audit_events_immutable before update or delete
 on executive_visuals.financial_audit_events for each row
 execute function executive_visuals.reject_revenue_intelligence_mutation();

create table if not exists executive_visuals.financial_audit_heads(
 owner_id uuid primary key references auth.users(id) on delete restrict,
 last_sequence bigint not null default 0 check(last_sequence>=0),
 head_hash text not null default repeat('0',64) check(head_hash ~ '^[a-f0-9]{64}$'),
 updated_at timestamptz not null default now()
);
alter table executive_visuals.financial_audit_heads enable row level security;
revoke all on executive_visuals.financial_audit_heads from public,anon,authenticated,service_role;

create or replace function executive_visuals.append_financial_audit_event(
 p_owner_id uuid,p_actor_id uuid,p_idempotency_key text,
 p_event_envelope jsonb,p_canonical_event text,p_event_hash text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals,public
as $$
declare
 v_head executive_visuals.financial_audit_heads%rowtype;
 v_existing executive_visuals.financial_audit_events%rowtype;
 v_sequence bigint;
 v_previous text;
 v_digest text;
 v_id uuid;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception using errcode='42501',message='service_role_required';
 end if;
 if p_owner_id is null or p_actor_id is null or p_idempotency_key is null
  or length(p_idempotency_key)<8 or length(p_idempotency_key)>160 then
  raise exception using errcode='22023',message='audit_event_input_invalid';
 end if;
 if p_event_envelope is null or jsonb_typeof(p_event_envelope)<>'object'
  or p_canonical_event is null or octet_length(p_canonical_event)>16384
  or p_event_hash !~ '^[a-f0-9]{64}$' then
  raise exception using errcode='22023',message='audit_event_envelope_invalid';
 end if;
 if p_event_envelope::text is null or p_canonical_event::jsonb<>p_event_envelope then
  raise exception using errcode='22023',message='audit_event_canonical_mismatch';
 end if;
 v_digest:=encode(digest(convert_to(p_canonical_event,'UTF8'),'sha256'),'hex');
 if v_digest<>p_event_hash then
  raise exception using errcode='22000',message='audit_event_hash_mismatch';
 end if;
 if (p_event_envelope->>'ownerId')::uuid<>p_owner_id
  or (p_event_envelope->>'actorId')::uuid<>p_actor_id
  or p_event_envelope->>'idempotencyKey'<>p_idempotency_key
  or p_event_envelope->>'hashAlgorithm'<>'SHA-256'
  or (p_event_envelope->>'canonicalizationVersion')::integer<>1 then
  raise exception using errcode='22023',message='audit_event_identity_mismatch';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text,30));
 select * into v_existing from executive_visuals.financial_audit_events
  where owner_id=p_owner_id and idempotency_key=p_idempotency_key;
 if found then
  if v_existing.actor_id<>p_actor_id or v_existing.event_type<>p_event_envelope->>'eventType'
   or v_existing.event_envelope->'payload'<>p_event_envelope->'payload' then
   raise exception using errcode='23505',message='audit_idempotency_payload_conflict';
  end if;
  return jsonb_build_object('duplicate',true,'eventId',v_existing.event_id,
   'sequence',v_existing.sequence_number,'eventHash',v_existing.event_hash);
 end if;
 insert into executive_visuals.financial_audit_heads(owner_id)
 values(p_owner_id) on conflict(owner_id) do nothing;
 select * into v_head from executive_visuals.financial_audit_heads
  where owner_id=p_owner_id for update;
 v_sequence:=v_head.last_sequence+1;
 v_previous:=v_head.head_hash;
 if (p_event_envelope->>'sequence')::bigint<>v_sequence
  or p_event_envelope->>'previousHash'<>v_previous then
  raise exception using errcode='40001',message='audit_chain_head_conflict';
 end if;
 insert into executive_visuals.financial_audit_events(
  owner_id,actor_id,sequence_number,event_id,event_type,occurred_at,
  idempotency_key,event_envelope,canonicalization_version,hash_algorithm,
  previous_hash,event_hash,canonical_event_bytes
 ) values(
  p_owner_id,p_actor_id,v_sequence,(p_event_envelope->>'eventId')::uuid,
  p_event_envelope->>'eventType',(p_event_envelope->>'occurredAt')::timestamptz,
  p_idempotency_key,p_event_envelope,1,'SHA-256',v_previous,p_event_hash,p_canonical_event
 ) returning id into v_id;
 update executive_visuals.financial_audit_heads
  set last_sequence=v_sequence,head_hash=p_event_hash,updated_at=now()
  where owner_id=p_owner_id;
 return jsonb_build_object('duplicate',false,'eventId',(p_event_envelope->>'eventId')::uuid,
  'sequence',v_sequence,'eventHash',p_event_hash,'recordId',v_id);
end $$;
revoke all on function executive_visuals.append_financial_audit_event(uuid,uuid,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function executive_visuals.append_financial_audit_event(uuid,uuid,text,jsonb,text,text) to service_role;

create or replace function executive_visuals.get_financial_audit_head(p_owner_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare v_head executive_visuals.financial_audit_heads%rowtype;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='service_role_required'; end if;
 select * into v_head from executive_visuals.financial_audit_heads where owner_id=p_owner_id;
 if not found then return jsonb_build_object('sequence',0,'headHash',repeat('0',64)); end if;
 return jsonb_build_object('sequence',v_head.last_sequence,'headHash',v_head.head_hash,'updatedAt',v_head.updated_at);
end $$;
revoke all on function executive_visuals.get_financial_audit_head(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.get_financial_audit_head(uuid) to service_role;
