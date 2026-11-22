-- Disposable PostgreSQL integration for account-wide agency team seats.
-- Run after cloud-video, shared project wallet and project member spend-control checks.
set role service_role;

-- The subscription is active, but a missing teamSeats allowance must fail closed.
do $seat_entitlement_required$
begin
 begin
  perform executive_visuals.add_project_member(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'editor@example.test','editor'
  );
  raise exception 'Member add unexpectedly succeeded without a teamSeats entitlement';
 exception when others then
  if sqlerrm='Member add unexpectedly succeeded without a teamSeats entitlement' then raise; end if;
  if sqlerrm<>'SUBSCRIPTION_TEAM_SEAT_ENTITLEMENT_REQUIRED' then raise; end if;
 end;
end
$seat_entitlement_required$;

update executive_visuals.customer_subscriptions
set entitlements_snapshot=entitlements_snapshot || '{"limits":{"teamSeats":2}}'::jsonb
where owner_id='123e4567-e89b-42d3-a456-426614174000'
 and status='active';
insert into executive_visuals.projects(id,owner_id,name)
values('423e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000','Second agency workspace');
insert into auth.users(id,email)
values('333e4567-e89b-42d3-a456-426614174000','second@example.test');

-- Owner + one collaborator consumes two seats across the whole account.
select executive_visuals.add_project_member(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'editor@example.test','editor'
);
-- The same collaborator in another workspace reuses their existing account seat.
select executive_visuals.add_project_member(
 '123e4567-e89b-42d3-a456-426614174000',
 '423e4567-e89b-42d3-a456-426614174000',
 'editor@example.test','reviewer'
);

do $seat_limit_blocks_new_member$
begin
 begin
  perform executive_visuals.add_project_member(
   '123e4567-e89b-42d3-a456-426614174000',
   '323e4567-e89b-42d3-a456-426614174000',
   'second@example.test','viewer'
  );
  raise exception 'A third account seat unexpectedly exceeded the two-seat plan';
 exception when others then
  if sqlerrm='A third account seat unexpectedly exceeded the two-seat plan' then raise; end if;
  if sqlerrm<>'SUBSCRIPTION_TEAM_SEAT_LIMIT_REACHED' then raise; end if;
 end;
end
$seat_limit_blocks_new_member$;

do $seat_summary$
declare summary record;
begin
 select * into summary from executive_visuals.get_project_team_seat_summary(
  '123e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000'
 );
 if summary.seat_limit<>2 or summary.used_seats<>2 or summary.available_seats<>0 then
  raise exception 'Account-wide seat summary did not include the owner and unique collaborator';
 end if;
end
$seat_summary$;

-- Increase the trusted plan entitlement and confirm the second distinct member can join.
update executive_visuals.customer_subscriptions
set entitlements_snapshot=entitlements_snapshot || '{"limits":{"teamSeats":3}}'::jsonb
where owner_id='123e4567-e89b-42d3-a456-426614174000'
 and status='active';
select executive_visuals.add_project_member(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'second@example.test','viewer'
);

do $seat_increase$
declare summary record;
begin
 select * into summary from executive_visuals.get_project_team_seat_summary(
  '123e4567-e89b-42d3-a456-426614174000',
  '423e4567-e89b-42d3-a456-426614174000'
 );
 if summary.seat_limit<>3 or summary.used_seats<>3 or summary.available_seats<>0 then
  raise exception 'Increasing the trusted seat entitlement did not unlock exactly one seat';
 end if;
end
$seat_increase$;

-- Removing one workspace membership does not free the seat while the collaborator
-- still belongs to another workspace owned by the same account.
select executive_visuals.remove_project_member(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 '223e4567-e89b-42d3-a456-426614174000'
);
do $seat_reuse$
declare summary record;
begin
 select * into summary from executive_visuals.get_project_team_seat_summary(
  '123e4567-e89b-42d3-a456-426614174000',
  '423e4567-e89b-42d3-a456-426614174000'
 );
 if summary.used_seats<>3 or summary.available_seats<>0 then
  raise exception 'Removing one project membership freed a seat still used by another workspace';
 end if;
end
$seat_reuse$;

select executive_visuals.remove_project_member(
 '123e4567-e89b-42d3-a456-426614174000',
 '423e4567-e89b-42d3-a456-426614174000',
 '223e4567-e89b-42d3-a456-426614174000'
);
select executive_visuals.remove_project_member(
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 '333e4567-e89b-42d3-a456-426614174000'
);

do $seat_release$
declare summary record;
begin
 select * into summary from executive_visuals.get_project_team_seat_summary(
  '123e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000'
 );
 if summary.used_seats<>1 or summary.available_seats<>2 then
  raise exception 'Removing the final workspace memberships did not release account seats';
 end if;
end
$seat_release$;

reset role;
select 'agency team seat entitlement PostgreSQL integration checks passed' as result;
