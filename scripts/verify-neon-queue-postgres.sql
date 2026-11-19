-- Disposable PostgreSQL integration for idempotent queue admission and fenced recovery.
-- Run only after migrations 0001-0004 against a throwaway CI database.
\set ON_ERROR_STOP on

select job_id as queue_job_id
from executive_visuals.enqueue_job_v1(
 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',null,'test.neon.queue','{"task":"queue-lifecycle"}'::jsonb,
 'ci-neon-queue-lifecycle',3
) \gset

do $$
declare first_result record; replay_result record;
begin
 select * into first_result from executive_visuals.enqueue_job_v1(
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',null,'test.neon.queue','{"task":"queue-lifecycle"}'::jsonb,
  'ci-neon-queue-lifecycle',3
 );
 if first_result.replayed is not true then raise exception 'same idempotency key was not replayed'; end if;
 if first_result.job_id<>''cccccccc-cccc-4ccc-8ccc-cccccccccccc''::uuid then raise exception 'idempotent replay returned another job'; end if;
 begin
  perform * from executive_visuals.enqueue_job_v1(
   'cccccccc-cccc-4ccc-8ccc-cccccccccccc',null,'test.neon.queue','{"task":"different-payload"}'::jsonb,
   'ci-neon-queue-lifecycle',3
  );
  raise exception 'idempotency payload conflict was accepted';
 exception when others then
  if sqlerrm<>'QUEUE_IDEMPOTENCY_CONFLICT' then raise; end if;
 end;
end $$;

select lease_token as first_lease
from executive_visuals.claim_next_job_v2('ci-neon-queue-worker',90,array['test.neon.queue'])
where id=''cccccccc-cccc-4ccc-8ccc-cccccccccccc''::uuid \gset

select executive_visuals.defer_job_v1(
 ''cccccccc-cccc-4ccc-8ccc-cccccccccccc''::uuid,'ci-neon-queue-worker',:'first_lease',30,
 '{"code":"CI_DEFER_TEST"}'::jsonb
) as deferred \gset

do $$
declare current_job executive_visuals.jobs;
begin
 select * into current_job from executive_visuals.jobs where id=''cccccccc-cccc-4ccc-8ccc-cccccccccccc''::uuid;
 if current_job.status<>'queued' or current_job.lease_token is not null or current_job.available_at<=clock_timestamp() then
  raise exception 'deferred job did not release its lease and delay availability';
 end if;
end $$;

update executive_visuals.jobs set available_at=clock_timestamp()
where id=''cccccccc-cccc-4ccc-8ccc-cccccccccccc''::uuid and status='queued';

select lease_token as second_lease
from executive_visuals.claim_next_job_v2('ci-neon-queue-worker',90,array['test.neon.queue'])
where id=''cccccccc-cccc-4ccc-8ccc-cccccccccccc''::uuid \gset

select executive_visuals.quarantine_job_v1(
 ''cccccccc-cccc-4ccc-8ccc-cccccccccccc''::uuid,'ci-neon-queue-worker',:'second_lease',
 '{"code":"CI_QUARANTINE_TEST"}'::jsonb
) as quarantined \gset

do $$
declare current_job executive_visuals.jobs; event_count integer;
begin
 select * into current_job from executive_visuals.jobs where id=''cccccccc-cccc-4ccc-8ccc-cccccccccccc''::uuid;
 select count(*) into event_count from executive_visuals.job_events
  where job_id=current_job.id and event_type in ('job.enqueued','job.deferred','job.quarantined');
 if current_job.status<>'blocked' or current_job.lease_token is not null or current_job.completed_at is not null or event_count<>3 then
  raise exception 'quarantine state or lifecycle event trail is inconsistent';
 end if;
end $$;

select 'NEON_QUEUE_POSTGRES_INTEGRATION_OK' as result;
