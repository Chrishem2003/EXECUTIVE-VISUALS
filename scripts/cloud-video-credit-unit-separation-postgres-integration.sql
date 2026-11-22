-- Runs after cloud-video-postgres-integration.sql and the unit-separation migration.
set role service_role;

select executive_visuals.record_video_workflow_quote_with_customer_credits(
 '723e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'pg-workflow-credit-separation-001',repeat('f',64),
 'runway','model-router','text-to-video','runway','gen4.5',
 10,4321,0.10,'USD','studio-video',
 'runway_model_router_dry_run',clock_timestamp()+interval '4 minutes'
);

do $credit_unit_quote_assertion$
declare q executive_visuals.video_workflow_quotes;
begin
 select * into q from executive_visuals.video_workflow_quotes
 where id='723e4567-e89b-42d3-a456-426614174001';
 if q.estimated_credits<>10 or q.estimated_customer_credits<>4321
    or q.estimated_amount<>0.10 or q.currency<>'USD' then
  raise exception 'provider and customer credit units were not persisted independently';
 end if;
end
$credit_unit_quote_assertion$;

create temporary table customer_credit_separation_result as
select * from executive_visuals.approve_and_enqueue_video_workflow(
 '723e4567-e89b-42d3-a456-426614174001',
 'e23e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 repeat('f',64),'studio-video','pg-workflow-credit-separation-001',
 jsonb_build_object(
  'projectId','323e4567-e89b-42d3-a456-426614174000',
  'provider','runway','model','model-router','requestHash',repeat('f',64),
  'operation','text-to-video','durationSeconds',5,'outputFormat','mp4',
  'workflowQuoteId','723e4567-e89b-42d3-a456-426614174001',
  'workflowRequestId','pg-workflow-credit-separation-001'
 ),0.10,'Approve customer-credit unit separation integration test'
);

do $credit_unit_reservation_assertion$
declare r record; cr executive_visuals.billing_credit_reservations; q executive_visuals.video_workflow_quotes; wallet record;
begin
 select * into r from customer_credit_separation_result;
 select * into q from executive_visuals.video_workflow_quotes
  where id='723e4567-e89b-42d3-a456-426614174001';
 select * into cr from executive_visuals.billing_credit_reservations
  where job_id=r.job_id;
 select * into wallet from executive_visuals.get_generation_credit_balance('123e4567-e89b-42d3-a456-426614174000');
 if r.job_id is null or r.job_status<>'queued' or cr.id is null
    or cr.reserved_credits<>4321 or cr.reserved_credits=q.estimated_credits
    or wallet.reserved_credits<4321
    or wallet.available_credits<>wallet.ledger_balance-wallet.reserved_credits then
  raise exception 'customer reservation or wallet balance did not use the customer quote';
 end if;
end
$credit_unit_reservation_assertion$;

create temporary table customer_credit_separation_replay as
select * from executive_visuals.approve_and_enqueue_video_workflow(
 '723e4567-e89b-42d3-a456-426614174001',
 'e23e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 repeat('f',64),'studio-video','pg-workflow-credit-separation-001',
 jsonb_build_object(
  'projectId','323e4567-e89b-42d3-a456-426614174000',
  'provider','runway','model','model-router','requestHash',repeat('f',64),
  'operation','text-to-video','durationSeconds',5,'outputFormat','mp4',
  'workflowQuoteId','723e4567-e89b-42d3-a456-426614174001',
  'workflowRequestId','pg-workflow-credit-separation-001'
 ),0.10,'Approve customer-credit unit separation integration test'
);

do $credit_unit_replay_assertion$
declare first_row record; replay_row record;
begin
 select * into first_row from customer_credit_separation_result;
 select * into replay_row from customer_credit_separation_replay;
 if not replay_row.idempotent_replay or replay_row.job_id<>first_row.job_id
    or (select count(*) from executive_visuals.billing_credit_reservations
        where job_id=first_row.job_id)<>1 then
  raise exception 'customer credit reservation was not idempotent';
 end if;
end
$credit_unit_replay_assertion$;

select executive_visuals.record_video_workflow_quote(
 '823e4567-e89b-42d3-a456-426614174001',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'legacy-unpriced-quote-001',repeat('a',64),
 'runway','model-router','text-to-video','runway','gen4.5',
 10,0.10,'USD','studio-video',
 'runway_model_router_dry_run',clock_timestamp()+interval '4 minutes'
);

do $legacy_quote_fail_closed$
begin
 begin
  perform * from executive_visuals.approve_and_enqueue_video_workflow(
   '823e4567-e89b-42d3-a456-426614174001',
   'f23e4567-e89b-42d3-a456-426614174001',
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   repeat('a',64),'studio-video','legacy-unpriced-quote-001',
   jsonb_build_object(
    'projectId','323e4567-e89b-42d3-a456-426614174000',
    'provider','runway','model','model-router','requestHash',repeat('a',64),
    'operation','text-to-video','durationSeconds',5,'outputFormat','mp4',
    'workflowQuoteId','823e4567-e89b-42d3-a456-426614174001',
    'workflowRequestId','legacy-unpriced-quote-001'
   ),0.10,'Legacy quote without customer credit pricing must not enqueue'
  );
  raise exception 'legacy provider-only quote unexpectedly approved';
 exception when others then
  if sqlerrm='legacy provider-only quote unexpectedly approved' then raise; end if;
  if sqlerrm<>'VIDEO_WORKFLOW_CUSTOMER_CREDIT_PRICING_REQUIRED' then raise; end if;
 end;
end
$legacy_quote_fail_closed$;

reset role;
select 'provider/customer credit separation PostgreSQL checks passed' as result;
