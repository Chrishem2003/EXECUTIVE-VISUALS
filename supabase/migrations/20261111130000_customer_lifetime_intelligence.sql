-- Batch 16: customer lifetime intelligence, activation milestones and explainable health scoring.
-- Signals are product-usage events, not surveillance. No prompts, media, filenames or creative content are stored.

create table if not exists executive_visuals.customer_success_activity_events(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete restrict,
 event_type text not null check(event_type in (
  'session_started','workspace_opened','project_created','render_completed',
  'asset_uploaded','workflow_completed','tutorial_completed','billing_viewed'
 )),
 event_key text not null,
 occurred_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 unique(owner_id,event_key)
);
create index if not exists customer_success_events_owner_time_idx
 on executive_visuals.customer_success_activity_events(owner_id,occurred_at desc);
create index if not exists customer_success_events_type_time_idx
 on executive_visuals.customer_success_activity_events(event_type,occurred_at desc);

create table if not exists executive_visuals.customer_success_milestone_catalog(
 milestone_code text primary key,
 title text not null,
 description text not null,
 points integer not null default 0 check(points between 0 and 1000),
 display_order integer not null default 0,
 active boolean not null default true
);
insert into executive_visuals.customer_success_milestone_catalog(milestone_code,title,description,points,display_order)
values
 ('first_project','First project created','You turned an idea into a real production project.',10,10),
 ('first_render','First render completed','You completed your first production render.',25,20),
 ('first_asset','First asset uploaded','Your private creative library has its first asset.',10,30),
 ('first_workflow','First workflow completed','You completed an end-to-end creative workflow.',25,40),
 ('five_sessions','Returning creator','You came back for five separate creative sessions.',15,50),
 ('creator_streak_7','Seven-day creator rhythm','You created on seven different days within a 14-day period.',30,60)
on conflict(milestone_code) do update set title=excluded.title,description=excluded.description,
 points=excluded.points,display_order=excluded.display_order,active=true;

create table if not exists executive_visuals.customer_success_milestone_awards(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete restrict,
 milestone_code text not null references executive_visuals.customer_success_milestone_catalog(milestone_code),
 achieved_at timestamptz not null default now(),
 unique(owner_id,milestone_code)
);
create index if not exists customer_success_awards_owner_idx
 on executive_visuals.customer_success_milestone_awards(owner_id,achieved_at desc);

create table if not exists executive_visuals.customer_success_interventions(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete restrict,
 intervention_type text not null check(intervention_type in (
  'onboarding_help','first_value_nudge','usage_guidance','renewal_checkin','payment_recovery','winback'
 )),
 status text not null default 'suggested' check(status in ('suggested','approved','dismissed','completed')),
 reason text not null check(length(reason) between 3 and 500),
 created_by uuid references auth.users(id) on delete restrict,
 updated_by uuid references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists customer_success_interventions_queue_idx
 on executive_visuals.customer_success_interventions(status,created_at desc);

create or replace function executive_visuals.customer_success_health_for_owner(p_owner_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
 last_seen timestamptz;
 sessions_7d integer:=0;
 sessions_30d integer:=0;
 projects_30d integer:=0;
 renders_30d integer:=0;
 workflows_30d integer:=0;
 milestones_count integer:=0;
 subscription_status text;
 health_score integer:=0;
 risk_level text;
 recommendation text;
begin
 if p_owner_id is null then raise exception 'Customer identity required' using errcode='22023'; end if;
 select max(occurred_at) into last_seen from customer_success_activity_events where owner_id=p_owner_id;
 select count(*) filter(where occurred_at>=now()-interval '7 days'),
        count(*) filter(where occurred_at>=now()-interval '30 days'),
        count(*) filter(where event_type='project_created' and occurred_at>=now()-interval '30 days'),
        count(*) filter(where event_type='render_completed' and occurred_at>=now()-interval '30 days'),
        count(*) filter(where event_type='workflow_completed' and occurred_at>=now()-interval '30 days')
 into sessions_7d,sessions_30d,projects_30d,renders_30d,workflows_30d
 from customer_success_activity_events
 where owner_id=p_owner_id and event_type in('session_started','workspace_opened','project_created','render_completed','asset_uploaded','workflow_completed','tutorial_completed','billing_viewed');
 select count(*) into milestones_count from customer_success_milestone_awards where owner_id=p_owner_id;
 select status into subscription_status from customer_subscriptions
 where owner_id=p_owner_id order by created_at desc limit 1;
 health_score:=case
  when last_seen is null then 0
  when last_seen>=now()-interval '2 days' then 30
  when last_seen>=now()-interval '7 days' then 23
  when last_seen>=now()-interval '14 days' then 14
  when last_seen>=now()-interval '30 days' then 7
  else 2 end;
 health_score:=health_score+least(25,sessions_7d*5);
 health_score:=health_score+least(20,projects_30d*5+renders_30d*7+workflows_30d*8);
 health_score:=health_score+least(15,milestones_count*3);
 health_score:=health_score+case when subscription_status in('active','trialing') then 10 when subscription_status='past_due' then 2 else 0 end;
 health_score:=least(100,health_score);
 risk_level:=case when health_score>=75 then 'healthy' when health_score>=50 then 'watch' when health_score>=25 then 'at_risk' else 'critical' end;
 recommendation:=case
  when last_seen is null then 'onboarding_help'
  when last_seen<now()-interval '14 days' then 'winback'
  when subscription_status='past_due' then 'payment_recovery'
  when subscription_status in('active','trialing') and coalesce(renders_30d,0)=0 then 'first_value_nudge'
  when last_seen<now()-interval '7 days' then 'usage_guidance'
  else 'renewal_checkin' end;
 return jsonb_build_object('ownerId',p_owner_id,'score',health_score,'riskLevel',risk_level,
  'lastSeenAt',last_seen,'sessions7d',sessions_7d,'sessions30d',sessions_30d,
  'projects30d',projects_30d,'renders30d',renders_30d,'workflows30d',workflows_30d,
  'milestones',milestones_count,'subscriptionStatus',subscription_status,
  'recommendedIntervention',recommendation);
end $$;

create or replace function executive_visuals.record_customer_success_event(
 p_owner_id uuid,p_event_type text,p_event_key text
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare inserted_id uuid; distinct_sessions integer; active_days integer; awarded integer:=0;
begin
 if p_owner_id is null or p_event_type not in(
  'session_started','workspace_opened','project_created','render_completed',
  'asset_uploaded','workflow_completed','tutorial_completed','billing_viewed'
 ) or p_event_key is null or length(p_event_key)<8 or length(p_event_key)>120 then
  raise exception 'Invalid customer-success event' using errcode='22023';
 end if;
 insert into customer_success_activity_events(owner_id,event_type,event_key)
 values(p_owner_id,p_event_type,p_event_key)
 on conflict(owner_id,event_key) do nothing returning id into inserted_id;
 if inserted_id is null then
  return jsonb_build_object('recorded',false,'duplicate',true,'milestonesAwarded',0);
 end if;
 if p_event_type='project_created' then
  insert into customer_success_milestone_awards(owner_id,milestone_code)
  values(p_owner_id,'first_project') on conflict do nothing;
  get diagnostics awarded=row_count;
 elsif p_event_type='render_completed' then
  insert into customer_success_milestone_awards(owner_id,milestone_code)
  values(p_owner_id,'first_render') on conflict do nothing;
  get diagnostics awarded=row_count;
 elsif p_event_type='asset_uploaded' then
  insert into customer_success_milestone_awards(owner_id,milestone_code)
  values(p_owner_id,'first_asset') on conflict do nothing;
  get diagnostics awarded=row_count;
 elsif p_event_type='workflow_completed' then
  insert into customer_success_milestone_awards(owner_id,milestone_code)
  values(p_owner_id,'first_workflow') on conflict do nothing;
  get diagnostics awarded=row_count;
 end if;
 select count(*) into distinct_sessions from customer_success_activity_events
 where owner_id=p_owner_id and event_type='session_started';
 if distinct_sessions>=5 then
  insert into customer_success_milestone_awards(owner_id,milestone_code)
  values(p_owner_id,'five_sessions') on conflict do nothing;
  get diagnostics distinct_sessions=row_count;
  awarded:=awarded+distinct_sessions;
 end if;
 select count(distinct occurred_at::date) into active_days
 from customer_success_activity_events
 where owner_id=p_owner_id and occurred_at>=now()-interval '14 days';
 if active_days>=7 then
  insert into customer_success_milestone_awards(owner_id,milestone_code)
  values(p_owner_id,'creator_streak_7') on conflict do nothing;
  get diagnostics distinct_sessions=row_count;
  awarded:=awarded+distinct_sessions;
 end if;
 return jsonb_build_object('recorded',true,'duplicate',false,'milestonesAwarded',awarded);
end $$;

create or replace function executive_visuals.customer_success_summary(p_owner_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare milestone_rows jsonb; progress_rows jsonb; points_total integer;
begin
 if p_owner_id is null then raise exception 'Customer identity required' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('code',c.milestone_code,'title',c.title,
  'description',c.description,'points',c.points,'achievedAt',a.achieved_at)
  order by c.display_order),'[]'::jsonb),coalesce(sum(c.points),0)
 into milestone_rows,points_total
 from customer_success_milestone_catalog c
 left join customer_success_milestone_awards a on a.milestone_code=c.milestone_code and a.owner_id=p_owner_id
 where c.active and a.id is not null;
 select coalesce(jsonb_agg(jsonb_build_object('code',c.milestone_code,'title',c.title,
  'description',c.description,'points',c.points,'completed',a.id is not null)
  order by c.display_order),'[]'::jsonb)
 into progress_rows
 from customer_success_milestone_catalog c
 left join customer_success_milestone_awards a on a.milestone_code=c.milestone_code and a.owner_id=p_owner_id
 where c.active;
 return jsonb_build_object('milestones',milestone_rows,'progress',progress_rows,
  'points',points_total,'completedCount',jsonb_array_length(milestone_rows),
  'totalCount',jsonb_array_length(progress_rows));
end $$;

create or replace function executive_visuals.customer_success_admin_overview()
returns jsonb
language sql security definer
set search_path=pg_catalog,executive_visuals,auth
as $$
 with customer_rows as(
  select u.id,u.email,u.created_at,
   executive_visuals.customer_success_health_for_owner(u.id) as health
  from auth.users u
  where not exists(select 1 from executive_visuals.platform_admins a where a.user_id=u.id)
 ), ranked as(
  select *,coalesce((health->>'score')::integer,0) as score,
   health->>'riskLevel' as risk
  from customer_rows
 ), selected as(
  select * from ranked order by score asc,created_at desc limit 100
 )
 select jsonb_build_object(
  'generatedAt',now(),
  'totalCustomers',(select count(*) from ranked),
  'averageHealthScore',coalesce((select round(avg(score)) from ranked),0),
  'healthy',(select count(*) from ranked where risk='healthy'),
  'watch',(select count(*) from ranked where risk='watch'),
  'atRisk',(select count(*) from ranked where risk='at_risk'),
  'critical',(select count(*) from ranked where risk='critical'),
  'customers',coalesce((select jsonb_agg(jsonb_build_object('ownerId',id,'email',email,
    'createdAt',created_at,'health',health) order by score asc,created_at desc) from selected),'[]'::jsonb)
 )
$$;

revoke all on executive_visuals.customer_success_activity_events,executive_visuals.customer_success_milestone_catalog,
 executive_visuals.customer_success_milestone_awards,executive_visuals.customer_success_interventions
 from public,anon,authenticated;
grant select,insert,update on executive_visuals.customer_success_activity_events,
 executive_visuals.customer_success_milestone_catalog,executive_visuals.customer_success_milestone_awards,
 executive_visuals.customer_success_interventions to service_role;
revoke delete,truncate on executive_visuals.customer_success_activity_events,
 executive_visuals.customer_success_milestone_catalog,executive_visuals.customer_success_milestone_awards,
 executive_visuals.customer_success_interventions from service_role;

revoke all on function executive_visuals.customer_success_health_for_owner(uuid) from public,anon,authenticated;
revoke all on function executive_visuals.record_customer_success_event(uuid,text,text) from public,anon,authenticated;
revoke all on function executive_visuals.customer_success_summary(uuid) from public,anon,authenticated;
revoke all on function executive_visuals.customer_success_admin_overview() from public,anon,authenticated;
grant execute on function executive_visuals.customer_success_health_for_owner(uuid) to service_role;
grant execute on function executive_visuals.record_customer_success_event(uuid,text,text) to service_role;
grant execute on function executive_visuals.customer_success_summary(uuid) to service_role;
grant execute on function executive_visuals.customer_success_admin_overview() to service_role;
