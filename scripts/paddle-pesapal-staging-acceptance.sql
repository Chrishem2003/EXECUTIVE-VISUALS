do $provider_staging_acceptance$
declare
 v_oid oid;
 v_count bigint;
 v_rel record;
 v_function text;
 v_functions text[] := array[
  'reserve_subscription_purchase_for_provider(uuid,text,text,text,text,text)',
  'finalize_subscription_purchase_for_provider(uuid,text,jsonb,timestamptz)',
  'reserve_paddle_subscription_renewal(uuid,text,text,text,text)',
  'finalize_paddle_subscription_renewal(uuid,text,jsonb,timestamptz)',
  'apply_paddle_subscription_lifecycle(text,text,timestamptz,timestamptz,boolean,jsonb)',
  'reserve_pesapal_subscription_renewal(uuid,uuid,text,text)',
  'finalize_subscription_renewal_for_provider(uuid,text,jsonb,timestamptz)'
 ];
begin
 if to_regclass('executive_visuals.subscription_plan_provider_prices') is null then
  raise exception 'Provider price table missing; migration not applied';
 end if;
 select relrowsecurity into v_rel from pg_class where oid='executive_visuals.subscription_plan_provider_prices'::regclass;
 if not v_rel.relrowsecurity then raise exception 'Provider price table must have RLS enabled'; end if;
 if has_table_privilege('anon','executive_visuals.subscription_plan_provider_prices','SELECT')
    or has_table_privilege('anon','executive_visuals.subscription_plan_provider_prices','INSERT')
    or has_table_privilege('authenticated','executive_visuals.subscription_plan_provider_prices','SELECT')
    or has_table_privilege('authenticated','executive_visuals.subscription_plan_provider_prices','INSERT') then
  raise exception 'Provider price table is directly accessible to client roles';
 end if;
 if not has_table_privilege('service_role','executive_visuals.subscription_plan_provider_prices','SELECT')
    or not has_table_privilege('service_role','executive_visuals.subscription_plan_provider_prices','INSERT') then
  raise exception 'Service role lacks provider price administration privileges';
 end if;
 foreach v_function in array v_functions loop
  v_oid:=to_regprocedure('executive_visuals.'||v_function);
  if v_oid is null then raise exception 'Required provider billing RPC missing: %',v_function; end if;
  if has_function_privilege('anon',v_oid,'EXECUTE')
     or has_function_privilege('authenticated',v_oid,'EXECUTE')
     or not has_function_privilege('service_role',v_oid,'EXECUTE') then
   raise exception 'Provider billing RPC ACL invalid: %',v_function;
  end if;
 end loop;
 select count(*) into v_count from executive_visuals.subscription_plan_provider_prices where active=true;
 if v_count<>0 then raise exception 'Unexpected active provider price rows: %',v_count; end if;
 select count(*) into v_count from executive_visuals.subscription_plan_provider_prices;
 if v_count<>0 then raise exception 'Provider price rows exist before merchant acceptance: %',v_count; end if;
 select count(*) into v_count from executive_visuals.customer_subscriptions
 where provider in ('paddle','pesapal');
 if v_count<>0 then raise exception 'Unexpected Paddle/Pesapal subscriptions in staging: %',v_count; end if;
end
$provider_staging_acceptance$;
select 'paddle_pesapal_staging_database_acceptance_passed' as result;
