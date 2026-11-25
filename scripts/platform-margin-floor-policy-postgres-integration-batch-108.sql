-- Batch 108: verify platform owner margin policy configuration and immutable history.
begin;

do $batch108_user$
declare v_actor uuid:=gen_random_uuid();
begin
 insert into auth.users(id) values(v_actor);
 perform set_config('batch108.actor_id',v_actor::text,true);
end;
$batch108_user$;

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $batch108_policy$
declare
 v_actor uuid:=current_setting('batch108.actor_id')::uuid;
 v_result record;
 v_policy executive_visuals.platform_financial_policies%rowtype;
begin
 select * into v_result from executive_visuals.configure_platform_video_margin_policy(
  v_actor,true,3500,900,86400,'batch108-policy-config-001'
 );
 if v_result.policy_version<>1 or v_result.replayed then
  raise exception 'BATCH108_FIRST_POLICY_WRITE_INVALID';
 end if;

 select * into v_result from executive_visuals.configure_platform_video_margin_policy(
  v_actor,true,3500,900,86400,'batch108-policy-config-001'
 );
 if v_result.policy_version<>1 or not v_result.replayed then
  raise exception 'BATCH108_POLICY_REPLAY_NOT_IDEMPOTENT';
 end if;

 begin
  perform * from executive_visuals.configure_platform_video_margin_policy(
   v_actor,true,4000,900,86400,'batch108-policy-config-001'
  );
  raise exception 'BATCH108_POLICY_IDEMPOTENCY_CONFLICT_ACCEPTED';
 exception when sqlstate '23505' then
  if sqlerrm<>'PLATFORM_FINANCIAL_POLICY_IDEMPOTENCY_CONFLICT' then raise; end if;
 end;

 select * into v_result from executive_visuals.configure_platform_video_margin_policy(
  v_actor,true,4000,600,43200,'batch108-policy-config-002'
 );
 if v_result.policy_version<>2 or v_result.replayed then
  raise exception 'BATCH108_POLICY_VERSION_DID_NOT_ADVANCE';
 end if;

 select * into v_policy from executive_visuals.platform_financial_policies
  where policy_key='video_generation';
 if not found or not v_policy.enabled or v_policy.minimum_gross_margin_bps<>4000
    or v_policy.quote_max_age_seconds<>600 or v_policy.rate_card_max_age_seconds<>43200
    or v_policy.version<>2 or v_policy.updated_by<>v_actor then
  raise exception 'BATCH108_CURRENT_POLICY_SNAPSHOT_INVALID';
 end if;
 if (select count(*) from executive_visuals.platform_financial_policy_history
     where policy_key='video_generation')<>2 then
  raise exception 'BATCH108_POLICY_HISTORY_MISSING_VERSION';
 end if;

 begin
  perform * from executive_visuals.configure_platform_video_margin_policy(
   v_actor,true,0,900,86400,'batch108-policy-invalid-margin'
  );
  raise exception 'BATCH108_INVALID_MARGIN_FLOOR_ACCEPTED';
 exception when sqlstate '22023' then
  if sqlerrm<>'PLATFORM_FINANCIAL_POLICY_ARGUMENTS_INVALID' then raise; end if;
 end;

 begin
  update executive_visuals.platform_financial_policy_history set enabled=false
   where policy_key='video_generation' and version=1;
  raise exception 'BATCH108_POLICY_HISTORY_MUTATION_ACCEPTED';
 exception when sqlstate '55000' then
  if sqlerrm<>'PLATFORM_FINANCIAL_POLICY_HISTORY_IS_APPEND_ONLY' then raise; end if;
 end;

 -- Direct writes to the active policy are not granted to service_role.
 begin
  update executive_visuals.platform_financial_policies
   set minimum_gross_margin_bps=1 where policy_key='video_generation';
  raise exception 'BATCH108_DIRECT_POLICY_MUTATION_ACCEPTED';
 exception when sqlstate '42501' then
  null;
 end;
end;
$batch108_policy$;

reset role;
rollback;
select 'PLATFORM_MARGIN_FLOOR_POLICY_BATCH_108_OK' as result;
