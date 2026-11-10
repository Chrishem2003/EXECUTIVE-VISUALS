-- Immutable timeline revision snapshots. This migration is additive and is not applied automatically.
create table if not exists executive_visuals.timeline_revisions (
  timeline_id uuid not null references executive_visuals.timelines(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  revision integer not null check (revision > 0),
  name text not null check (char_length(name) between 1 and 160),
  timeline jsonb not null check (jsonb_typeof(timeline)='object'),
  otio jsonb check (otio is null or jsonb_typeof(otio)='object'),
  created_at timestamptz not null default now(),
  primary key (timeline_id, revision)
);

create index if not exists ev_timeline_revisions_owner_created
  on executive_visuals.timeline_revisions(owner_id, created_at desc);
create index if not exists ev_timeline_revisions_project_created
  on executive_visuals.timeline_revisions(project_id, created_at desc);

alter table executive_visuals.timeline_revisions enable row level security;

create policy ev_timeline_revisions_read
  on executive_visuals.timeline_revisions for select to authenticated
  using (
    owner_id=(select auth.uid())
    or exists (
      select 1 from executive_visuals.projects p
      where p.id=timeline_revisions.project_id and p.owner_id=(select auth.uid())
    )
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id=timeline_revisions.project_id and m.member_id=(select auth.uid())
    )
  );

create or replace function executive_visuals.capture_timeline_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
begin
  insert into executive_visuals.timeline_revisions
    (timeline_id, owner_id, project_id, revision, name, timeline, otio, created_at)
  values
    (new.id, new.owner_id, new.project_id, new.revision, new.name, new.timeline, new.otio, coalesce(new.updated_at, now()))
  on conflict (timeline_id, revision) do nothing;
  return new;
end;
$$;

drop trigger if exists ev_capture_timeline_revision on executive_visuals.timelines;
create trigger ev_capture_timeline_revision
  after insert or update of revision on executive_visuals.timelines
  for each row execute function executive_visuals.capture_timeline_revision();

-- Backfill each currently retained timeline's present revision exactly once.
insert into executive_visuals.timeline_revisions
  (timeline_id, owner_id, project_id, revision, name, timeline, otio, created_at)
select id, owner_id, project_id, revision, name, timeline, otio, coalesce(updated_at, now())
from executive_visuals.timelines
where archived_at is null
on conflict (timeline_id, revision) do nothing;

revoke all on table executive_visuals.timeline_revisions from public, anon, authenticated, service_role;
grant select on table executive_visuals.timeline_revisions to authenticated, service_role;

create or replace function executive_visuals.prevent_timeline_revision_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'Timeline revision snapshots are immutable.' using errcode = '55000';
end;
$;

drop trigger if exists ev_timeline_revisions_immutable on executive_visuals.timeline_revisions;
create trigger ev_timeline_revisions_immutable
  before update or delete on executive_visuals.timeline_revisions
  for each row execute function executive_visuals.prevent_timeline_revision_mutation();
