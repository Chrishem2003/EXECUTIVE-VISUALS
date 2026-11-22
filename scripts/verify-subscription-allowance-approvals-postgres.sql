-- Execute after prepare script, Batch 30 audit migration and Batch 59 migration.
\set ON_ERROR_STOP on
insert into auth.users(id) values
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222'),
 ('33333333-3333-4333-8333-333333333333')
 on conflict do nothing;
insert into executive_visuals.platform_admins(user_id,role,granted_by,reason) values
 ('11111111-1111-4111-8111-111111111111','billing_admin','11111111-1111-4111-8111-111111111111','disposable integration fixture'),
 ('22222222-2222-4222-8222-222222222222','billing_admin','11111111-1111-4111-8111-111111111111','disposable integration fixture'),
 ('33333333-3333-4333-8333-333333333333','platform_admin','11111111-1111-4111-8111-111111111111','disposable integration fixture')
 on conflict(user_id) do update set role=excluded.role;

do $$
declare
 v_creator uuid:='11111111-1111-4111-8111-111111111111';
 v_finance uuid:='22222222-2222-4222-8222-222222222222';
 v_product uuid:='33333333-3333-4333-8333-333333333333';
 v_proposal jsonb;
 v_proposal_canonical text;
 v_proposal_hash text;
 v_proposal_id uuid;
 v_envelope jsonb;
 v_canonical text;
 v_hash text;
 v_result jsonb;
 v_status jsonb;
 v_event_id uuid;
 v_occurred text;
begin
 v_proposal:=jsonb_build_object(
  'planCode','starter_creator','name','Starter Creator','planVersion',1,'currency','USD',
  'monthlyPriceMinor',900,'includedCredits',80,'providerCostPerCustomerCreditMinor',2,
  'costEvidence',jsonb_build_object('status','verified_measured','approved',false,
   'source','posted provider invoices','rateCardVersion','invoice-attribution-v1',
   'sampleJobs',5,'periodStart','2026-10-01T00:00:00.000Z','periodEnd','2026-11-01T00:00:00.000Z'),
  'assumptions',jsonb_build_object('targetGrossMarginBps',7000,'paymentFeeBps',350,
   'refundReserveBps',200,'fixedPaymentFeeMinor',30,'supportReserveMinor',20,'infrastructureReserveMinor',30)
 );
 v_proposal_canonical:=v_proposal::text;
 v_proposal_hash:=encode(digest(convert_to(v_proposal_canonical,'UTF8'),'sha256'),'hex');
 v_event_id:=gen_random_uuid();
 v_occurred:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 v_envelope:=jsonb_build_object(
  'canonicalizationVersion',1,'hashAlgorithm','SHA-256','eventId',v_event_id,
  'sequence',1,'ownerId',v_creator,'actorId',v_creator,
  'eventType','subscription_allowance.proposal_created','occurredAt',v_occurred,
  'payload',jsonb_build_object('proposalHash',v_proposal_hash,'planCode','starter_creator','planVersion',1),
  'idempotencyKey','batch59-proposal-01','previousHash',repeat('0',64)
 );
 v_canonical:=v_envelope::text;
 v_hash:=encode(digest(convert_to(v_canonical,'UTF8'),'sha256'),'hex');
 v_result:=executive_visuals.create_subscription_allowance_proposal(
  v_creator,v_proposal,v_proposal_canonical,v_proposal_hash,
  v_envelope,v_canonical,v_hash
 );
 v_proposal_id:=(v_result->>'proposalId')::uuid;
 if v_proposal_id is null or v_result->>'publishable'<>'false' then
  raise exception 'proposal creation did not return a non-publishable durable proposal: %',v_result;
 end if;

 -- The proposal creator cannot approve their own allowance.
 v_event_id:=gen_random_uuid();
 v_occurred:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 v_envelope:=jsonb_build_object('canonicalizationVersion',1,'hashAlgorithm','SHA-256',
  'eventId',v_event_id,'sequence',1,'ownerId',v_creator,'actorId',v_creator,
  'eventType','subscription_allowance.approval_recorded','occurredAt',v_occurred,
  'payload',jsonb_build_object('proposalId',v_proposal_id,'proposalHash',v_proposal_hash,'stage','finance','decision','approved'),
  'idempotencyKey','batch59-self-approve','previousHash',repeat('0',64));
 v_canonical:=v_envelope::text;v_hash:=encode(digest(convert_to(v_canonical,'UTF8'),'sha256'),'hex');
 begin
  perform executive_visuals.record_subscription_allowance_approval(
   v_creator,v_proposal_id,'finance','approved',null,v_envelope,v_canonical,v_hash);
  raise exception 'creator self-approval unexpectedly succeeded';
 exception when insufficient_privilege then
  if sqlerrm not like '%creator_cannot_approve%' then raise; end if;
 end;

 -- Finance stage must be performed by billing_admin and remains pending.
 v_event_id:=gen_random_uuid();
 v_occurred:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 v_envelope:=jsonb_build_object('canonicalizationVersion',1,'hashAlgorithm','SHA-256',
  'eventId',v_event_id,'sequence',1,'ownerId',v_finance,'actorId',v_finance,
  'eventType','subscription_allowance.approval_recorded','occurredAt',v_occurred,
  'payload',jsonb_build_object('proposalId',v_proposal_id,'proposalHash',v_proposal_hash,'stage','finance','decision','approved'),
  'idempotencyKey','batch59-finance-01','previousHash',repeat('0',64));
 v_canonical:=v_envelope::text;v_hash:=encode(digest(convert_to(v_canonical,'UTF8'),'sha256'),'hex');
 v_result:=executive_visuals.record_subscription_allowance_approval(
  v_finance,v_proposal_id,'finance','approved','Invoice sample checked.',v_envelope,v_canonical,v_hash);
 if v_result->>'status'<>'awaiting_dual_approval' or v_result->>'publishable'<>'false' then
  raise exception 'single finance approval must not approve or publish: %',v_result;
 end if;

 -- Replaying the same idempotency key must not create a second approval.
 v_result:=executive_visuals.record_subscription_allowance_approval(
  v_finance,v_proposal_id,'finance','approved','Invoice sample checked.',v_envelope,v_canonical,v_hash);
 if v_result->>'duplicate'<>'true' then raise exception 'approval replay was not idempotent: %',v_result; end if;

 -- Product approval requires a different, platform_admin actor.
 v_event_id:=gen_random_uuid();
 v_occurred:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 v_envelope:=jsonb_build_object('canonicalizationVersion',1,'hashAlgorithm','SHA-256',
  'eventId',v_event_id,'sequence',1,'ownerId',v_product,'actorId',v_product,
  'eventType','subscription_allowance.approval_recorded','occurredAt',v_occurred,
  'payload',jsonb_build_object('proposalId',v_proposal_id,'proposalHash',v_proposal_hash,'stage','product','decision','approved'),
  'idempotencyKey','batch59-product-01','previousHash',repeat('0',64));
 v_canonical:=v_envelope::text;v_hash:=encode(digest(convert_to(v_canonical,'UTF8'),'sha256'),'hex');
 v_result:=executive_visuals.record_subscription_allowance_approval(
  v_product,v_proposal_id,'product','approved','Plan and credit offer reviewed.',v_envelope,v_canonical,v_hash);
 if v_result->>'status'<>'approved' or v_result->>'eligibleToPublish'<>'true'
  or v_result->>'publishable'<>'false' then
  raise exception 'dual approval must be eligible only for a separate publication gate: %',v_result;
 end if;
 v_status:=executive_visuals.get_subscription_allowance_approval_status(v_proposal_id);
 if v_status->>'status'<>'approved' or v_status->>'publishable'<>'false'
  or jsonb_array_length(v_status->'approvals')<>2 then
  raise exception 'durable status read did not return both immutable approvals: %',v_status;
 end if;

 -- Both proposal and decision rows are append-only, including for service-role writers.
 begin
  update executive_visuals.subscription_allowance_proposals set included_credits=81 where id=v_proposal_id;
  raise exception 'immutable proposal update unexpectedly succeeded';
 exception when object_not_in_prerequisite_state then
  if sqlerrm not like '%immutable%' then raise; end if;
 end;
 begin
  delete from executive_visuals.subscription_allowance_approvals where proposal_id=v_proposal_id;
  raise exception 'immutable approval delete unexpectedly succeeded';
 exception when object_not_in_prerequisite_state then
  if sqlerrm not like '%immutable%' then raise; end if;
 end;
 raise notice 'Batch 59 persistent subscription allowance approval integration passed: proposal %, hash %',v_proposal_id,v_proposal_hash;
end $$;
