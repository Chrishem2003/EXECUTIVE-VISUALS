\set ON_ERROR_STOP on
do $$
declare
 approvals regclass:=to_regclass('executive_visuals.video_generation_approvals');
 shots regclass:=to_regclass('executive_visuals.video_generation_approval_shots');
 enqueue_fn regprocedure:=to_regprocedure('executive_visuals.enqueue_video_generation_job_v1(uuid,uuid,text,jsonb,uuid,numeric,bigint,integer)');
 budget_fn regprocedure:=to_regprocedure('executive_visuals.issue_video_budget_approval_v1(uuid,uuid,text,text,text,text,numeric,text,integer)');
begin
 if approvals is null or shots is null then raise exception 'NEON_VIDEO_APPROVAL_BRIDGE_TABLES_MISSING'; end if;
 if enqueue_fn is null or budget_fn is null then raise exception 'NEON_VIDEO_APPROVAL_BRIDGE_FINANCIAL_FUNCTIONS_MISSING'; end if;
 if not exists(select 1 from pg_indexes where schemaname='executive_visuals' and indexname='ev_neon_approval_owner_created') then raise exception 'NEON_VIDEO_APPROVAL_OWNER_INDEX_MISSING'; end if;
 if not exists(select 1 from pg_indexes where schemaname='executive_visuals' and indexname='ev_neon_approval_shots_owner') then raise exception 'NEON_VIDEO_APPROVAL_SHOT_SCOPE_INDEX_MISSING'; end if;
 if not exists(select 1 from information_schema.table_constraints where table_schema='executive_visuals' and table_name='video_generation_approval_shots' and constraint_type='FOREIGN KEY') then raise exception 'NEON_VIDEO_APPROVAL_SHOT_FOREIGN_KEY_MISSING'; end if;
end $$;
select 'NEON_VIDEO_APPROVAL_BRIDGE_POSTGRES_SCHEMA_OK' as verification;
