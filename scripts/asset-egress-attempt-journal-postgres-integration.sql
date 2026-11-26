\\set ON_ERROR_STOP on
set role service_role;
do $egress_attempt_journal$
declare
 v_actor uuid := '44444444-4444-4444-8444-444444444444';
 v_asset uuid := '33333333-3333-4333-8333-333333333333';
 v_owner uuid := '11111111-1111-4111-8111-111111111111';
 v_project uuid := '22222222-2222-4222-8222-222222222222';
 v_transfer uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 v_abandoned uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 v_result jsonb; v_status text; v_bytes bigint;
begin
 v_result := executive_visuals.begin_asset_egress_transfer_attempt(v_actor,v_transfer,v_asset,v_owner,v_project);
 if v_result->>'status' <> 'started' then raise exception 'transfer intent was not persisted'; end if;
 v_result := executive_visuals.finish_asset_egress_transfer_attempt(
  v_actor,v_transfer,'partial',1234,206,'asset-egress:'||v_transfer::text,null
 );
 if v_result->>'status' <> 'partial' then raise exception 'partial outcome was not persisted'; end if;
 select status,transferred_bytes into v_status,v_bytes
 from executive_visuals.asset_egress_transfer_attempts where transfer_id=v_transfer;
 if v_status<>'partial' or v_bytes<>1234 then raise exception 'actual byte outcome mismatch'; end if;
 v_result := executive_visuals.finish_asset_egress_transfer_attempt(
  v_actor,v_transfer,'partial',1234,206,'asset-egress:'||v_transfer::text,null
 );
 if v_result->>'idempotentReplay'<>'true' then raise exception 'identical terminal replay was not idempotent'; end if;
 perform executive_visuals.begin_asset_egress_transfer_attempt(v_actor,v_abandoned,v_asset,v_owner,v_project);
 select status into v_status from executive_visuals.asset_egress_transfer_attempts where transfer_id=v_abandoned;
 if v_status<>'started' then raise exception 'abandoned attempt must remain unknown, not billable'; end if;
 if has_table_privilege('service_role','executive_visuals.asset_egress_transfer_attempts','SELECT') then
  raise exception 'service role must not read journal table directly';
 end if;
 if has_function_privilege('anon',
  'executive_visuals.begin_asset_egress_transfer_attempt(uuid,uuid,uuid,uuid,uuid)','EXECUTE') then
  raise exception 'anonymous role must not begin transfer attempts';
 end if;
end
$egress_attempt_journal$;
reset role;
select 'asset egress attempt journal integration passed' as result;
