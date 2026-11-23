-- Batch 105: verify posted-cost per-job report joins the Batch 71 revenue allocation ledger.
-- This disposable integration intentionally has no posted invoice cost for the fixture job,
-- so revenue is visible while contribution/margin remain blocked.

set role service_role;
do $batch105_job_profitability$
declare
  v_report jsonb;
  v_job jsonb;
  v_owner constant uuid:='71717171-7171-4171-8171-717171717171';
  v_job_id constant uuid:='71717171-7171-4171-8171-717171717101';
begin
  v_report:=executive_visuals.financial_job_profitability_report(v_owner,null,100);
  if coalesce((v_report->>'count')::integer,0)<1
     or jsonb_typeof(v_report->'jobs')<>'array' then
    raise exception 'Per-job profitability report did not return the settled Batch 71 fixture';
  end if;
  select value into v_job
    from jsonb_array_elements(v_report->'jobs')
   where value->>'jobId'=v_job_id::text;
  if v_job is null then
    raise exception 'Per-job profitability report omitted the settled paid-credit job';
  end if;
  if v_job#>>'{revenue,status}'<>'verified'
     or (v_job#>>'{revenue,recognizedMinor}')::bigint<>400
     or v_job#>>'{actualCost,status}'<>'missing'
     or v_job#>>'{profitability,status}'<>'cost_incomplete'
     or v_job#>>'{profitability,contributionMinor}' is not null then
    raise exception 'Per-job report failed to recognize verified revenue or failed to withhold margin without posted invoice costs: %',v_job;
  end if;

  begin
    perform executive_visuals.financial_job_profitability_report(v_owner,null,101);
    raise exception 'Per-job profitability report accepted an out-of-range limit';
  exception when others then
    if sqlerrm='Per-job profitability report accepted an out-of-range limit' then raise; end if;
    if sqlstate<>'22023' then raise; end if;
  end;

  insert into auth.users(id,email) values(
    '81818181-8181-4181-8181-818181818181','batch105-nonadmin@example.invalid'
  ) on conflict(id) do nothing;
  begin
    perform executive_visuals.financial_job_profitability_report(
      '81818181-8181-4181-8181-818181818181',null,10
    );
    raise exception 'Non-admin unexpectedly accessed job profitability';
  exception when others then
    if sqlerrm='Non-admin unexpectedly accessed job profitability' then raise; end if;
    if sqlstate<>'42501' then raise; end if;
  end;
end
$batch105_job_profitability$;
reset role;
select 'verified per-job profitability PostgreSQL integration checks passed' as result;
