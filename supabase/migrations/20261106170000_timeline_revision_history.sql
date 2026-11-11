-- Durable, immutable snapshots for every saved cloud timeline revision.
-- Each successful revision change is captured by a database trigger so API clients
-- cannot skip history by bypassing the application server.
create table if not exists executive_visuals.timeline_versions (
  id bigint generated always as identity primary key,
  timeline_id uuid not null references executive_visuals.timelines(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  revision integer not null check (revision > 0),
  name text not null check (char_length(name) between 1 and 160),
  timeline jsonb not null check (jsonb_typeof(timeline)='object'),
  otio jsonb check (otio is null or jsonb_typeof(otio)='object'),
  created_at timestamptz not null default now(),
  unique(timeline_id,revision)
);

create index if not exists ev_timeline_versions_history
  on executive_visuals.timeline_versions(timeline_id,revision desc);

-- Backfill the currently saved revision for timelines that predate this feature.
insert into executive_visuals.timeline_versions(
  timeline_id,owner_id,project_id,revision,name,timeline,otio,created_at
)
select id,owner_id,project_id,revision,name,timeline,otio,updated_at
from executive_visuals.timelines
on conflict(timeline_id,revision) do nothing;

create or replace function executive_visuals.capture_timeline_version()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
begin
  if tg_op='INSERT' or new.revision is distinct from old.revision then
    insert into executive_visuals.timeline_versions(
      timeline_id,owner_id,project_id,revision,name,timeline,otio
    ) values (
      new.id,new.owner_id,new.project_id,new.revision,new.name,new.timeline,new.otio
    )
    on conflict(timeline_id,revision) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists ev_timelines_capture_version on executive_visuals.timelines;
create trigger ev_timelines_capture_version
after insert or update of revision on executive_visuals.timelines
for each row execute function executive_visuals.capture_timeline_version();

alter table executive_visuals.timeline_versions enable row level security;
revoke all on executive_visuals.timeline_versions from public,anon,authenticated;
grant select on executive_visuals.timeline_versions to service_role;
revoke insert,update,delete on executive_visuals.timeline_versions from service_role;
revoke all on function executive_visuals.capture_timeline_version() from public,anon,authenticated,service_role;
