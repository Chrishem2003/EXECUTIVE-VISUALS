-- Batch 13: chargeback evidence readiness and deadline-aware dispute operations.
create table if not exists executive_visuals.financial_dispute_evidence_items(
 id uuid primary key default gen_random_uuid(),
 case_id uuid not null references executive_visuals.chargeback_cases(id) on delete cascade,
 owner_id uuid not null references auth.users(id),
 evidence_type text not null check(evidence_type in (
  'payment_receipt','service_delivery','customer_communication','refund_record','terms_acceptance','other'
 )),
 status text not null default 'missing' check(status in ('missing','uploaded','verified','rejected')),
 storage_object_path text,
 note text not null default '',
 created_by uuid not null references auth.users(id),
 reviewed_by uuid references auth.users(id),
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(case_id,evidence_type),
 check(char_length(note)<=1000),
 check(storage_object_path is null or (
  length(storage_object_path) between 1 and 500
  and storage_object_path !~ '^(https?:)?//'
  and position('..' in storage_object_path)=0
  and left(storage_object_path,1)<>'/'
 ))
);
create index if not exists financial_dispute_evidence_owner_idx
 on executive_visuals.financial_dispute_evidence_items(owner_id,case_id);
create index if not exists chargeback_response_deadline_idx
 on executive_visuals.chargeback_cases(status,response_due_at)
 where status in ('open','under_review');

revoke all on executive_visuals.financial_dispute_evidence_items from public,anon,authenticated;
grant select,insert,update on executive_visuals.financial_dispute_evidence_items to service_role;
revoke delete,truncate on executive_visuals.financial_dispute_evidence_items from service_role;

create or replace function executive_visuals.upsert_financial_dispute_evidence(
 p_actor_id uuid,p_case_id uuid,p_evidence_type text,p_status text,
 p_storage_object_path text,p_note text,p_reason text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare actor_role text; case_owner uuid; evidence_row financial_dispute_evidence_items;
begin
 select role into actor_role from platform_admins where user_id=p_actor_id;
 if coalesce(actor_role,'') not in ('owner','platform_admin','billing_admin') then
  raise exception 'Finance administrator role required' using errcode='42501';
 end if;
 if p_evidence_type not in ('payment_receipt','service_delivery','customer_communication','refund_record','terms_acceptance','other')
  or p_status not in ('missing','uploaded','verified','rejected')
  or char_length(coalesce(p_note,''))>1000
  or char_length(coalesce(p_reason,'')) not between 3 and 500 then
  raise exception 'Invalid dispute evidence update' using errcode='22023';
 end if;
 if p_status in ('uploaded','verified') and (
  p_storage_object_path is null or length(p_storage_object_path) not between 1 and 500
  or p_storage_object_path ~ '^(https?:)?//'
  or position('..' in p_storage_object_path)>0
  or left(p_storage_object_path,1)='/'
 ) then
  raise exception 'Evidence must reference a private relative object path' using errcode='22023';
 end if;
 select owner_id into case_owner from chargeback_cases where id=p_case_id;
 if case_owner is null then raise exception 'Dispute case not found' using errcode='P0002'; end if;
 insert into financial_dispute_evidence_items(case_id,owner_id,evidence_type,status,storage_object_path,note,created_by,reviewed_by,reviewed_at)
 values(p_case_id,case_owner,p_evidence_type,p_status,p_storage_object_path,btrim(coalesce(p_note,'')),p_actor_id,
  case when p_status in ('verified','rejected') then p_actor_id else null end,
  case when p_status in ('verified','rejected') then now() else null end)
 on conflict(case_id,evidence_type) do update set
  status=excluded.status,storage_object_path=excluded.storage_object_path,note=excluded.note,
  reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,updated_at=now()
 returning * into evidence_row;
 perform write_financial_admin_audit(
  p_actor_id,'finance.dispute.evidence.update','chargeback_evidence',evidence_row.id::text,
  p_reason,gen_random_uuid()::text,
  jsonb_build_object('caseId',p_case_id,'evidenceType',p_evidence_type,'status',p_status,'ownerId',case_owner)
 );
 return to_jsonb(evidence_row);
end $$;

revoke all on function executive_visuals.upsert_financial_dispute_evidence(uuid,uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function executive_visuals.upsert_financial_dispute_evidence(uuid,uuid,text,text,text,text,text) to service_role;
