-- Neon-native retry transition for provider responses explicitly documented
-- as safe to retry (e.g. Runway Dev 429, 502, 503 and 504).
-- This never retries ambiguous transport outcomes or undocumented responses.
begin;

create or replace function executive_visuals.retry_video_generation_submission_v1(
 p_job_id uuid,
 p_worker_id text,
 p_lease_token uuid,
 p_error_code text
) returns boolean
language plpgsql security definer
set search_path=pg_catalog,executive_visuals as $$
declare changed integer;
begin
 if p_error_code is null or p_error_code !~ '^[A-Z0-9_]{1,100}$' then
  raise exception 'VIDEO_SUBMISSION_RETRY_ERROR_CODE_INVALID';
 end if;
 if not executive_visuals.assert_current_video_worker_lease_v1(p_job_id,p_worker_id,p_lease_token) then
  return false;
 end if;
 update executive_visuals.video_generation_submissions
 set state='prepared',
     submission_started_at=null,
     updated_at=clock_timestamp(),
     last_error_code=p_error_code
 where job_id=p_job_id
   and state='submitting'
   and provider_task_id is null;
 get diagnostics changed=row_count;
 return changed=1;
end $$;

revoke all on function executive_visuals.retry_video_generation_submission_v1(uuid,text,uuid,text) from public;
commit;
