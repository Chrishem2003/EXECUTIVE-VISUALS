\set ON_ERROR_STOP on
set role service_role;
do $egress_attempt_calls$
declare
 v_actor uuid := '44444444-4444-4444-8444-444444444444';
 v_asset uuid := '33333333-3333-4333-8333-333333333333';
 v_owner uuid := '11111111-1111-4111-8111-111111111111';
 v_project uuid := '22222222-2222-4222-8222-222222222222';
 v_transfer uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 v_abandoned uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 v_oversized uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 v_asset_bytes bigint;
 v_result jsonb;
begin
 select byte_size into v_asset_bytes from executive_visuals.assets
 where id=v_asset and owner_id=v_owner and project_id=v_project;
 if not found then raise exception 'egress fixture asset missing'; end if;
 v_result := executive_visuals.begin_asset_egress_transfer_attempt(v_actor,v_transfer,v_asset,v_owner,v_project);
 if v_result->>'status' <> 'started' then raise exception 'transfer intent was not persisted'; end if;
 v_result := executive_visuals.finish_asset_egress_transfer_attempt(
  v_actor,v_transfer,'partial',least(1,v_asset_bytes),206,'asset-egress:'||v_transfer::text,null
 );
 if v_result->>'status' <> 'partial' then raise exception 'partial outcome was not persisted'; end if;
 v_result := executive_visuals.finish_asset_egress_transfer_attempt(
  v_actor,v_transfer,'partial',least(1,v_asset_bytes),206,'asset-egress:'||v_transfer::text,null
 );
 if v_result->>'idempotentReplay'<>'true' then raise exception 'identical terminal replay was not idempotent'; end if;
 v_result := executive_visuals.begin_asset_egress_transfer_attempt(v_actor,v_transfer,v_asset,v_owner,v_project);
 if v_result->>'status'<>'partial' or v_result->>'idempotentReplay'<>'true' then
  raise exception 'begin replay must return the persisted terminal state';
 end if;
 perform executive_visuals.begin_asset_egress_transfer_attempt(v_actor,v_abandoned,v_asset,v_owner,v_project);
 perform executive_visuals.begin_asset_egress_transfer_attempt(v_actor,v_oversized,v_asset,v_owner,v_project);
 begin
  perform executive_visuals.finish_asset_egress_transfer_attempt(
   v_actor,v_oversized,'partial',v_asset_bytes+1,206,'asset-egress:'||v_oversized::text,null
  );
  raise exception 'oversized egress unexpectedly finalized';
 exception when others then
  if sqlerrm='oversized egress unexpectedly finalized' then raise; end if;
  if sqlerrm<>'Transferred bytes exceed persisted asset size' then raise; end if;
 end;
end
$egress_attempt_calls$;
reset role;
do $egress_attempt_assertions$
declare v_status text; v_bytes bigint;
begin
 select status,transferred_bytes into v_status,v_bytes
 from executive_visuals.asset_egress_transfer_attempts
 where transfer_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 if v_status<>'partial' or v_bytes<1 then raise exception 'actual byte outcome mismatch'; end if;
 select status into v_status from executive_visuals.asset_egress_transfer_attempts
 where transfer_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 if v_status<>'started' then raise exception 'abandoned attempt must remain unknown, not billable'; end if;
 select status into v_status from executive_visuals.asset_egress_transfer_attempts
 where transfer_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 if v_status<>'started' then raise exception 'rejected oversized attempt must remain started'; end if;
 if has_table_privilege('service_role','executive_visuals.asset_egress_transfer_attempts','SELECT') then
  raise exception 'service role must not read journal table directly';
 end if;
 if has_function_privilege('anon',
  'executive_visuals.begin_asset_egress_transfer_attempt(uuid,uuid,uuid,uuid,uuid)','EXECUTE') then
  raise exception 'anonymous role must not begin transfer attempts';
 end if;
end
$egress_attempt_assertions$;
select 'asset egress attempt journal integration passed' as result;
