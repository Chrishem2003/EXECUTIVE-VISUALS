do $workflow_node_customer_credit_ceiling_contract$
declare
  new_rpc regprocedure := to_regprocedure(
    'executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text,bigint,bigint)'
  );
  legacy_rpc regprocedure := to_regprocedure(
    'executive_visuals.approve_and_enqueue_video_workflow(uuid,uuid,uuid,uuid,text,text,text,jsonb,numeric,text)'
  );
begin
  if new_rpc is null then
    raise exception 'BATCH89_CREDIT_CEILING_RPC_MISSING';
  end if;
  if not has_function_privilege('service_role',new_rpc,'EXECUTE') then
    raise exception 'BATCH89_SERVICE_ROLE_CANNOT_EXECUTE_CREDIT_CEILING_RPC';
  end if;
  if has_function_privilege('authenticated',new_rpc,'EXECUTE')
     or has_function_privilege('anon',new_rpc,'EXECUTE')
     or has_function_privilege('public',new_rpc,'EXECUTE') then
    raise exception 'BATCH89_CREDIT_CEILING_RPC_EXPOSED_TO_UNTRUSTED_ROLE';
  end if;
  if legacy_rpc is not null and has_function_privilege('service_role',legacy_rpc,'EXECUTE') then
    raise exception 'BATCH89_LEGACY_WORKFLOW_RPC_CAN_BYPASS_CUSTOMER_CREDIT_CEILING';
  end if;
  if (select prosecdef from pg_proc where oid=new_rpc) then
    raise exception 'BATCH89_WORKFLOW_RPC_SECURITY_MODE_CHANGED';
  end if;
end
$workflow_node_customer_credit_ceiling_contract$;
