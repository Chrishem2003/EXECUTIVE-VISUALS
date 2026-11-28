-- Batch 150: fail-closed runtime schema capability check for Paddle/Pesapal billing.
-- Read-only diagnostics; no payment, subscription, entitlement or credit mutations.

-- Keep subscription and payment records behind the verified server-side API.
-- The browser does not need direct table grants; server routes use service_role.
alter table executive_visuals.customer_subscriptions enable row level security;
alter table executive_visuals.payment_transactions enable row level security;
revoke all on executive_visuals.customer_subscriptions,
  executive_visuals.payment_transactions from public, anon, authenticated;
grant all privileges on executive_visuals.customer_subscriptions,
  executive_visuals.payment_transactions to service_role;

create or replace function executive_visuals.check_subscription_billing_runtime_schema()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $function$
declare
  v_missing text[] := array[]::text[];
  v_table text;
  v_function text;
  v_table_oid oid;
  v_function_oid oid;
  v_tables constant text[] := array[
    'subscription_plan_provider_prices',
    'customer_subscriptions',
    'payment_transactions',
    'payment_webhook_events',
    'subscription_financial_reconciliation_runs',
    'subscription_financial_remediation_requests',
    'subscription_financial_remediation_events'
  ];
  v_functions constant text[] := array[
    'reserve_subscription_purchase_for_provider',
    'finalize_subscription_purchase_for_provider',
    'reserve_paddle_subscription_renewal',
    'finalize_paddle_subscription_renewal',
    'apply_paddle_subscription_lifecycle',
    'reserve_pesapal_subscription_renewal',
    'finalize_subscription_renewal_for_provider',
    'claim_payment_webhook_event',
    'run_subscription_financial_reconciliation',
    'get_subscription_financial_liability_summary',
    'request_subscription_financial_remediation',
    'decide_subscription_financial_remediation'
  ];
begin
  if to_regnamespace('executive_visuals') is null then
    return jsonb_build_object(
      'ready', false,
      'schema', 'executive_visuals',
      'schemaVersion', 'batch-150',
      'missing', jsonb_build_array('schema_missing')
    );
  end if;

  foreach v_table in array v_tables loop
    v_table_oid := to_regclass(format('%I.%I', 'executive_visuals', v_table));
    if v_table_oid is null then
      v_missing := array_append(v_missing, 'table_missing:' || v_table);
      continue;
    end if;

    if not exists(select 1 from pg_class where oid=v_table_oid and relrowsecurity) then
      v_missing := array_append(v_missing, 'rls_disabled:' || v_table);
    end if;

    if has_table_privilege('anon', v_table_oid, 'SELECT')
       or has_table_privilege('anon', v_table_oid, 'INSERT')
       or has_table_privilege('anon', v_table_oid, 'UPDATE')
       or has_table_privilege('anon', v_table_oid, 'DELETE')
       or has_table_privilege('authenticated', v_table_oid, 'SELECT')
       or has_table_privilege('authenticated', v_table_oid, 'INSERT')
       or has_table_privilege('authenticated', v_table_oid, 'UPDATE')
       or has_table_privilege('authenticated', v_table_oid, 'DELETE') then
      v_missing := array_append(v_missing, 'client_table_grant:' || v_table);
    end if;

    if not has_table_privilege('service_role', v_table_oid, 'SELECT') then
      v_missing := array_append(v_missing, 'service_role_select_missing:' || v_table);
    end if;
  end loop;

  foreach v_function in array v_functions loop
    select p.oid into v_function_oid
      from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='executive_visuals' and p.proname=v_function
     order by p.oid
     limit 1;

    if v_function_oid is null then
      v_missing := array_append(v_missing, 'function_missing:' || v_function);
      continue;
    end if;

    if not has_function_privilege('service_role', v_function_oid, 'EXECUTE') then
      v_missing := array_append(v_missing, 'service_role_execute_missing:' || v_function);
    end if;

    if has_function_privilege('anon', v_function_oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_function_oid, 'EXECUTE') then
      v_missing := array_append(v_missing, 'client_function_execute:' || v_function);
    end if;
  end loop;

  return jsonb_build_object(
    'ready', cardinality(v_missing)=0,
    'schema', 'executive_visuals',
    'schemaVersion', 'batch-150',
    'missing', to_jsonb(v_missing)
  );
end;
$function$;

revoke all on function executive_visuals.check_subscription_billing_runtime_schema() from public, anon, authenticated;
grant execute on function executive_visuals.check_subscription_billing_runtime_schema() to service_role;
