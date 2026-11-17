-- Verify the guarded direct Runway model migration against the disposable CI database.
-- The application tests exercise quote/reservation/enqueue inputs; this checks that the
-- deployed PostgreSQL function was actually patched and retains exact model boundaries.
do $runway_direct_model_contract$
declare
  function_oid regprocedure;
  function_sql text;
begin
  function_oid := to_regprocedure(
    'executive_visuals.enqueue_video_generation_job(uuid,uuid,text,text,text,text,jsonb,uuid,numeric,text)'
  );
  if function_oid is null then
    raise exception 'RUNWAY_DIRECT_ENQUEUE_FUNCTION_NOT_FOUND';
  end if;
  function_sql := pg_get_functiondef(function_oid);

  if position('kling_4_flash' in function_sql) = 0 then
    raise exception 'KLING_FLASH_MODEL_NOT_ALLOWLISTED';
  end if;
  if position('p_model = ''kling_4_flash''' in function_sql) = 0 then
    raise exception 'KLING_FLASH_MODEL_POLICY_BRANCH_MISSING';
  end if;
  if position('durationSeconds' in function_sql) = 0
     or position('VIDEO_PRICE_DURATION_INVALID' in function_sql) = 0 then
    raise exception 'KLING_FLASH_DURATION_POLICY_MISSING';
  end if;
  if position('p_input ->> ''resolution''' in function_sql) = 0
     or position('''720p''' in function_sql) = 0 then
    raise exception 'KLING_FLASH_RESOLUTION_POLICY_MISSING';
  end if;
  if position('VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED' in function_sql) = 0
     or position('sourceVideoAssetId' in function_sql) = 0 then
    raise exception 'KLING_FLASH_SOURCE_ASSET_POLICY_MISSING';
  end if;
  if position('VIDEO_DRAFT_CONFIGURATION_INVALID' in function_sql) = 0
     or position('VIDEO_DRAFT_FLAG_INVALID' in function_sql) = 0
     or position('p_input ->> ''draft''' in function_sql) = 0
     or position('draftTargetResolution' in function_sql) = 0
     or position('''480p''' in function_sql) = 0
     or position('''1080p''' in function_sql) = 0
     or position('draftTaskId' in function_sql) = 0
     or position('sourceDraftJobId' in function_sql) = 0
     or position('draftEnhancement' in function_sql) = 0
     or position('VIDEO_DRAFT_ENHANCEMENT_INVALID' in function_sql) = 0 then
    raise exception 'SEEDANCE_DRAFT_PRICE_POLICY_MISSING';
  end if;
end
$runway_direct_model_contract$;

select 'Runway direct-model PostgreSQL contract passed' as result;
