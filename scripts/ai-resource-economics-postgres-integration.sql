-- Disposable PostgreSQL integration checks for Batch 23.
set role service_role;
do $$
declare
 v_actor uuid:='11111111-1111-4111-8111-111111111111';
 v_owner uuid:='11111111-1111-4111-8111-111111111111';
 v_rate jsonb;v_resource jsonb;v_resource_replay jsonb;v_unpriced jsonb;v_overview jsonb;
 v_usage jsonb;v_performance jsonb;v_route jsonb;v_route_replay jsonb;
 v_usage_id uuid;v_index integer;v_model text;v_provider text;v_key text;
begin
 v_rate:=executive_visuals.add_ai_resource_rate_card(
  v_actor,'executive-visuals-worker','ffmpeg_second','second','USD',2,
  now()-interval '1 day',null,'admin_verified','batch23-test-rate-card'
 );
 v_resource:=executive_visuals.record_ai_resource_usage_event(
  v_actor,now()-interval '1 hour',v_owner,null,null,'batch23-render-job-001',
  'executive-visuals-worker','timeline.render','ffmpeg_second',45.25,'second','USD',
  null,'batch23-resource-event-0001','{"measurement":"ffmpeg_process_wall_clock"}'::jsonb
 );
 if v_resource->>'costBasis'<>'catalog_estimate' or (v_resource->>'costMinor')::bigint<>91
  or v_resource->>'currency'<>'USD' then
  raise exception 'Measured FFmpeg time did not resolve through its effective-dated rate card: %',v_resource;
 end if;
 v_resource_replay:=executive_visuals.record_ai_resource_usage_event(
  v_actor,now()-interval '1 hour',v_owner,null,null,'batch23-render-job-001',
  'executive-visuals-worker','timeline.render','ffmpeg_second',45.25,'second','USD',
  null,'batch23-resource-event-0001','{"measurement":"ffmpeg_process_wall_clock"}'::jsonb
 );
 if v_resource_replay->>'idempotentReplay'<>'true' then
  raise exception 'Resource event replay was not idempotent: %',v_resource_replay;
 end if;
 v_unpriced:=executive_visuals.record_ai_resource_usage_event(
  v_actor,now(),v_owner,null,null,'batch23-gpu-unmeasured',
  'local-gpu-worker','realesrgan-x4plus','gpu_second',1,'second',null,
  null,'batch23-resource-gpu-unpriced','{"measurement":"gpu_telemetry_not_configured"}'::jsonb
 );
 if v_unpriced->>'costBasis'<>'unpriced' or v_unpriced->>'currency' is not null then
  raise exception 'Unpriced GPU telemetry must remain unpriced without currency/rate evidence: %',v_unpriced;
 end if;
 v_overview:=executive_visuals.ai_resource_economics_overview(v_actor,date_trunc('month',now())::date);
 if (v_overview->>'unpricedEvents')::integer<1 or jsonb_array_length(v_overview->'byResource')<1 then
  raise exception 'Resource economics overview did not include measured and unpriced events: %',v_overview;
 end if;

 for v_index in 1..20 loop
  foreach v_provider,v_model in array array['route-provider-a','model-a','route-provider-b','model-b'] loop
   null;
  end loop;
  v_provider:='route-provider-a';v_model:='model-a';
  v_key:='batch23-route-a-'||lpad(v_index::text,2,'0');
  v_usage:=executive_visuals.record_ai_usage_cost_event(
   v_actor,now()-interval '1 day',v_owner,null,null,v_key,v_provider,v_model,v_model,
   'text','succeeded',100,100,0,0,0,'USD',50,'','batch23-route-trace-a-'||v_index,v_key||'-usage'
  );
  v_usage_id:=(v_usage->>'id')::uuid;
  v_performance:=executive_visuals.record_ai_model_performance_event(
   v_actor,v_usage_id,v_provider,v_model,'text',500,0.90,'human_review','batch23-quality-v1',v_key||'-quality'
  );
  v_provider:='route-provider-b';v_model:='model-b';
  v_key:='batch23-route-b-'||lpad(v_index::text,2,'0');
  v_usage:=executive_visuals.record_ai_usage_cost_event(
   v_actor,now()-interval '1 day',v_owner,null,null,v_key,v_provider,v_model,v_model,
   'text','succeeded',100,100,0,0,0,'USD',80,'','batch23-route-trace-b-'||v_index,v_key||'-usage'
  );
  v_usage_id:=(v_usage->>'id')::uuid;
  v_performance:=executive_visuals.record_ai_model_performance_event(
   v_actor,v_usage_id,v_provider,v_model,'text',300,0.95,'human_review','batch23-quality-v1',v_key||'-quality'
  );
 end loop;
 v_route:=executive_visuals.recommend_ai_model_route_shadow(
  v_actor,'text','USD',90,400,0.85,'batch23-shadow-route-request-001'
 );
 if v_route->>'decisionStatus'<>'recommended' or v_route->>'recommendedProvider'<>'route-provider-b'
  or v_route->>'recommendedModel'<>'model-b' or v_route->>'decisionMode'<>'shadow_only'
  or v_route->>'executionChanged'<>'false' then
  raise exception 'Shadow routing did not select the evidence-backed candidate without changing execution: %',v_route;
 end if;
 v_route_replay:=executive_visuals.recommend_ai_model_route_shadow(
  v_actor,'text','USD',90,400,0.85,'batch23-shadow-route-request-001'
 );
 if v_route_replay->>'idempotentReplay'<>'true' then
  raise exception 'Shadow route decision replay was not idempotent: %',v_route_replay;
 end if;
end $$;
reset role;
