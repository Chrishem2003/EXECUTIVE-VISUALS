-- Batch 150 PostgreSQL acceptance. Disposable CI database only; transaction is rolled back.
begin;

grant usage on schema executive_visuals to service_role;
set role service_role;
set search_path=executive_visuals,public;

do $batch150$
declare
  v_report jsonb;
  v_function oid;
  v_is_security_definer boolean;
  v_search_path text[];
begin
  v_report:=check_subscription_billing_runtime_schema();
  if v_report->>'ready'<>'true'
     or v_report->>'schema'<>'executive_visuals'
     or v_report->>'schemaVersion'<>'batch-150'
     or jsonb_array_length(v_report->'missing')<>0 then
    raise exception 'Subscription billing schema capability gate did not pass: %',v_report;
  end if;

  v_function:=to_regprocedure('executive_visuals.check_subscription_billing_runtime_schema()');
  if v_function is null then raise exception 'Batch 150 schema capability function is missing'; end if;

  select prosecdef,proconfig into v_is_security_definer,v_search_path
    from pg_proc where oid=v_function;
  if not v_is_security_definer then raise exception 'Batch 150 schema capability function must be SECURITY DEFINER'; end if;
  if not coalesce(v_search_path @> array['search_path=pg_catalog, executive_visuals'],false) then
    raise exception 'Batch 150 schema capability function must use a fixed search_path';
  end if;

  if not has_function_privilege('service_role',v_function,'EXECUTE') then
    raise exception 'service_role cannot execute the Batch 150 schema capability function';
  end if;
  if has_function_privilege('anon',v_function,'EXECUTE')
     or has_function_privilege('authenticated',v_function,'EXECUTE') then
    raise exception 'Client roles must not execute the Batch 150 schema capability function';
  end if;

  raise notice 'Batch 150 subscription billing runtime schema gate passed';
end;
$batch150$;

reset role;
rollback;
