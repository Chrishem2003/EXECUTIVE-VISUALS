-- Enforce account-wide team seat entitlements for agency/studio workspaces.
-- One seat is consumed by the account owner; a collaborator shared across multiple
-- projects owned by the same account consumes only one additional seat.

create or replace function executive_visuals.resolve_project_team_seat_entitlement(
 p_owner_id uuid,p_lock boolean default false
) returns table(seat_limit bigint)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $resolve_project_team_seat_entitlement$
declare active_count integer; subscription_id uuid; snapshot jsonb;
 seat_text text; resolved_limit bigint;
begin
 if p_owner_id is null then
  raise exception 'SUBSCRIPTION_REQUIRED_FOR_TEAM_SEATS' using errcode='42501';
 end if;
 select count(*) into active_count
 from customer_subscriptions s
 where s.owner_id=p_owner_id
  and s.status in ('active','trialing')
  and s.current_period_start<=clock_timestamp()
  and s.current_period_end>clock_timestamp();
 if active_count=0 then
  raise exception 'SUBSCRIPTION_REQUIRED_FOR_TEAM_SEATS' using errcode='42501';
 end if;
 if active_count<>1 then
  raise exception 'SUBSCRIPTION_RECORD_AMBIGUOUS' using errcode='P0001';
 end if;
 if p_lock then
  select s.id,s.entitlements_snapshot into subscription_id,snapshot
  from customer_subscriptions s
  where s.owner_id=p_owner_id
   and s.status in ('active','trialing')
   and s.current_period_start<=clock_timestamp()
   and s.current_period_end>clock_timestamp()
  for update;
 else
  select s.id,s.entitlements_snapshot into subscription_id,snapshot
  from customer_subscriptions s
  where s.owner_id=p_owner_id
   and s.status in ('active','trialing')
   and s.current_period_start<=clock_timestamp()
   and s.current_period_end>clock_timestamp();
 end if;
 if subscription_id is null or jsonb_typeof(snapshot)<>'object' then
  raise exception 'SUBSCRIPTION_TEAM_SEAT_ENTITLEMENT_REQUIRED' using errcode='42501';
 end if;
 seat_text:=snapshot #>> '{limits,teamSeats}';
 if jsonb_typeof(snapshot #> '{limits,teamSeats}')<>'number'
    or seat_text is null or seat_text !~ '^[1-9][0-9]{0,5}$' then
  raise exception 'SUBSCRIPTION_TEAM_SEAT_ENTITLEMENT_REQUIRED' using errcode='42501';
 end if;
 resolved_limit:=seat_text::bigint;
 if resolved_limit<1 or resolved_limit>100000 then
  raise exception 'SUBSCRIPTION_TEAM_SEAT_ENTITLEMENT_REQUIRED' using errcode='42501';
 end if;
 return query select resolved_limit;
end;
$resolve_project_team_seat_entitlement$;

create or replace function executive_visuals.enforce_project_team_seat_entitlement()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $enforce_project_team_seat_entitlement$
declare project_owner uuid; seat_limit bigint; used_seats bigint; already_has_seat boolean;
begin
 select p.owner_id into project_owner from projects p where p.id=new.project_id;
 if project_owner is null then raise exception 'PROJECT_NOT_FOUND'; end if;
 if new.member_id=project_owner then return new; end if;
 if tg_op='UPDATE' then
  if old.project_id=new.project_id and old.member_id=new.member_id then return new; end if;
 end if;

 -- Lock the one active subscription row. Concurrent adds in different projects
 -- serialize here, then count distinct account members after the preceding commit.
 select e.seat_limit into seat_limit
 from resolve_project_team_seat_entitlement(project_owner,true) e;

 select exists(
  select 1 from project_members pm
  join projects p on p.id=pm.project_id
  where p.owner_id=project_owner and pm.member_id=new.member_id
 ) into already_has_seat;
 if already_has_seat then return new; end if;

 select 1+count(distinct pm.member_id) into used_seats
 from project_members pm
 join projects p on p.id=pm.project_id
 where p.owner_id=project_owner and pm.member_id<>project_owner;
 if used_seats>=seat_limit then
  raise exception 'SUBSCRIPTION_TEAM_SEAT_LIMIT_REACHED' using errcode='P0001';
 end if;
 return new;
end;
$enforce_project_team_seat_entitlement$;

drop trigger if exists ev_project_team_seat_entitlement on executive_visuals.project_members;
create trigger ev_project_team_seat_entitlement
before insert or update of project_id,member_id
on executive_visuals.project_members
for each row execute function executive_visuals.enforce_project_team_seat_entitlement();

create or replace function executive_visuals.get_project_team_seat_summary(
 p_owner_id uuid,p_project_id uuid
) returns table(seat_limit bigint,used_seats bigint,available_seats bigint)
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $get_project_team_seat_summary$
declare resolved_limit bigint; current_seats bigint;
begin
 if p_owner_id is null or p_project_id is null then
  raise exception 'PROJECT_MEMBER_ARGUMENTS_INVALID' using errcode='22023';
 end if;
 if not exists(select 1 from projects p where p.id=p_project_id and p.owner_id=p_owner_id) then
  raise exception 'PROJECT_CREDIT_POOL_OWNER_REQUIRED' using errcode='42501';
 end if;
 select e.seat_limit into resolved_limit
 from resolve_project_team_seat_entitlement(p_owner_id,false) e;
 select 1+count(distinct pm.member_id) into current_seats
 from project_members pm
 join projects p on p.id=pm.project_id
 where p.owner_id=p_owner_id and pm.member_id<>p_owner_id;
 return query select resolved_limit,current_seats,greatest(0,resolved_limit-current_seats);
end;
$get_project_team_seat_summary$;

revoke all on function executive_visuals.resolve_project_team_seat_entitlement(uuid,boolean)
 from public,anon,authenticated;
revoke all on function executive_visuals.enforce_project_team_seat_entitlement()
 from public,anon,authenticated,service_role;
revoke all on function executive_visuals.get_project_team_seat_summary(uuid,uuid)
 from public,anon,authenticated;
grant execute on function executive_visuals.resolve_project_team_seat_entitlement(uuid,boolean)
 to service_role;
grant execute on function executive_visuals.get_project_team_seat_summary(uuid,uuid)
 to service_role;

comment on function executive_visuals.get_project_team_seat_summary(uuid,uuid) is
 'Returns account-wide team seat usage. The owner counts as one seat; each distinct collaborator across all owner projects counts once.';
