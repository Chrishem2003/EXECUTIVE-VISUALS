-- Immutable timeline version snapshots with explicit parent and restore lineage.
-- Source-controlled only. Apply to an isolated development project after review.
-- This migration does not alter or deploy any production database.

create table if not exists executive_visuals.timeline_versions (
  id uuid primary key default gen_random_uuid(),
  timeline_id uuid not null references executive_visuals.timelines(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references executive_visuals.projects(id) on delete cascade,
  revision integer not null check (revision > 0),
  parent_version_id uuid references executive_visuals.timeline_versions(id) on delete set null,
  restored_from_version_id uuid references executive_visuals.timeline_versions(id) on delete set null,
  name text not null check (char_length(name) between 1 and 160),
  summary text not null default '' check (char_length(summary) <= 500),
  content_hash text check (content_hash is null or content_hash ~ '^[a-f0-9]{64}$'),
  timeline jsonb not null check (jsonb_typeof(timeline) = 'object'),
  otio jsonb check (otio is null or jsonb_typeof(otio) = 'object'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (timeline_id, revision),
  check (parent_version_id is distinct from id),
  check (restored_from_version_id is distinct from id)
);

create index if not exists ev_timeline_versions_timeline_revision
  on executive_visuals.timeline_versions(timeline_id, revision desc);
create index if not exists ev_timeline_versions_owner_created
  on executive_visuals.timeline_versions(owner_id, created_at desc);
create index if not exists ev_timeline_versions_parent
  on executive_visuals.timeline_versions(parent_version_id)
  where parent_version_id is not null;

alter table executive_visuals.timeline_versions enable row level security;
alter table executive_visuals.timeline_versions force row level security;
revoke all on table executive_visuals.timeline_versions from public, anon, authenticated;
revoke update, delete, truncate, references, trigger on table executive_visuals.timeline_versions from service_role;
grant select, insert on table executive_visuals.timeline_versions to service_role;
grant usage on schema executive_visuals to service_role;

-- Existing timelines receive a baseline snapshot at their current revision.
-- The hash is nullable for these legacy snapshots; new writes provide SHA-256.
insert into executive_visuals.timeline_versions(
  timeline_id, owner_id, project_id, revision, parent_version_id,
  restored_from_version_id, name, summary, content_hash, timeline, otio,
  created_by, created_at
)
select
  t.id, t.owner_id, t.project_id, t.revision, null,
  null, t.name, 'Baseline captured when version history was enabled.',
  null, t.timeline, t.otio, t.owner_id, coalesce(t.updated_at, now())
from executive_visuals.timelines t
where t.archived_at is null
on conflict (timeline_id, revision) do nothing;

create or replace function executive_visuals.ev_create_timeline_with_version(
  p_timeline_id uuid,
  p_owner_id uuid,
  p_actor_id uuid,
  p_project_id uuid,
  p_name text,
  p_timeline jsonb,
  p_otio jsonb,
  p_summary text,
  p_content_hash text
) returns setof executive_visuals.timelines
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $function$
declare
  created executive_visuals.timelines;
begin
  if p_timeline_id is null or p_owner_id is null or p_actor_id is null then
    raise exception 'Timeline identity is required.' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 160 then
    raise exception 'Timeline name is invalid.' using errcode = '22023';
  end if;
  if p_timeline is null or jsonb_typeof(p_timeline) <> 'object' then
    raise exception 'Timeline snapshot must be a JSON object.' using errcode = '22023';
  end if;
  if p_content_hash is null or p_content_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Timeline content hash must be SHA-256.' using errcode = '22023';
  end if;

  insert into executive_visuals.timelines(id, owner_id, project_id, name, revision, timeline, otio)
  values (p_timeline_id, p_owner_id, p_project_id, btrim(p_name), 1, p_timeline, p_otio)
  returning * into created;

  insert into executive_visuals.timeline_versions(
    timeline_id, owner_id, project_id, revision, name, summary,
    content_hash, timeline, otio, created_by
  ) values (
    created.id, created.owner_id, created.project_id, created.revision,
    created.name, left(coalesce(p_summary, 'Initial version'), 500),
    p_content_hash, created.timeline, created.otio, p_actor_id
  );

  return next created;
end;
$function$;

create or replace function executive_visuals.ev_update_timeline_with_version(
  p_timeline_id uuid,
  p_owner_id uuid,
  p_actor_id uuid,
  p_expected_revision integer,
  p_name text,
  p_timeline jsonb,
  p_otio jsonb,
  p_summary text,
  p_previous_content_hash text,
  p_content_hash text
) returns setof executive_visuals.timelines
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $function$
declare
  current_row executive_visuals.timelines;
  updated_row executive_visuals.timelines;
  parent_id uuid;
  next_revision integer;
begin
  if p_timeline_id is null or p_owner_id is null or p_actor_id is null
     or p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'Timeline update identity or revision is invalid.' using errcode = '22023';
  end if;
  if p_timeline is null or jsonb_typeof(p_timeline) <> 'object'
     or p_content_hash is null or p_content_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Timeline snapshot or content hash is invalid.' using errcode = '22023';
  end if;

  select * into current_row
  from executive_visuals.timelines
  where id = p_timeline_id and archived_at is null
  for update;
  if not found or current_row.owner_id <> p_owner_id then
    raise exception 'Timeline not found.' using errcode = 'P0002';
  end if;
  if current_row.revision <> p_expected_revision then
    raise exception 'Timeline revision conflict.' using errcode = '40001';
  end if;

  select id into parent_id
  from executive_visuals.timeline_versions
  where timeline_id = p_timeline_id and revision = current_row.revision
  limit 1;

  if parent_id is null then
    insert into executive_visuals.timeline_versions(
      timeline_id, owner_id, project_id, revision, name, summary,
      content_hash, timeline, otio, created_by
    ) values (
      current_row.id, current_row.owner_id, current_row.project_id,
      current_row.revision, current_row.name,
      'Baseline captured before the first versioned update.',
      p_previous_content_hash, current_row.timeline, current_row.otio, p_actor_id
    )
    on conflict (timeline_id, revision) do nothing;

    select id into parent_id
    from executive_visuals.timeline_versions
    where timeline_id = p_timeline_id and revision = current_row.revision
    limit 1;
  end if;

  next_revision := current_row.revision + 1;
  update executive_visuals.timelines
  set name = coalesce(nullif(btrim(p_name), ''), current_row.name),
      revision = next_revision,
      timeline = p_timeline,
      otio = p_otio,
      updated_at = now()
  where id = p_timeline_id
  returning * into updated_row;

  insert into executive_visuals.timeline_versions(
    timeline_id, owner_id, project_id, revision, parent_version_id,
    name, summary, content_hash, timeline, otio, created_by
  ) values (
    updated_row.id, updated_row.owner_id, updated_row.project_id,
    updated_row.revision, parent_id, updated_row.name,
    left(coalesce(p_summary, 'Saved revision ' || next_revision::text), 500),
    p_content_hash, updated_row.timeline, updated_row.otio, p_actor_id
  );

  return next updated_row;
end;
$function$;

create or replace function executive_visuals.ev_restore_timeline_version(
  p_timeline_id uuid,
  p_owner_id uuid,
  p_actor_id uuid,
  p_expected_revision integer,
  p_source_version_id uuid,
  p_summary text,
  p_previous_content_hash text,
  p_content_hash text
) returns setof executive_visuals.timelines
language plpgsql
security invoker
set search_path = pg_catalog, executive_visuals
as $function$
declare
  current_row executive_visuals.timelines;
  source_row executive_visuals.timeline_versions;
  restored_row executive_visuals.timelines;
  parent_id uuid;
  next_revision integer;
begin
  if p_timeline_id is null or p_owner_id is null or p_actor_id is null
     or p_expected_revision is null or p_expected_revision < 1
     or p_source_version_id is null or p_content_hash is null or p_content_hash !~ '^[a-f0-9]{64}
    raise exception 'Timeline restore identity or revision is invalid.' using errcode = '22023';
  end if;

  select * into current_row
  from executive_visuals.timelines
  where id = p_timeline_id and archived_at is null
  for update;
  if not found or current_row.owner_id <> p_owner_id then
    raise exception 'Timeline not found.' using errcode = 'P0002';
  end if;
  if current_row.revision <> p_expected_revision then
    raise exception 'Timeline revision conflict.' using errcode = '40001';
  end if;

  select * into source_row
  from executive_visuals.timeline_versions
  where id = p_source_version_id
    and timeline_id = p_timeline_id
    and owner_id = p_owner_id;
  if not found then
    raise exception 'Source version not found.' using errcode = 'P0002';
  end if;

  select id into parent_id
  from executive_visuals.timeline_versions
  where timeline_id = p_timeline_id and revision = current_row.revision
  limit 1;
  if parent_id is null then
    insert into executive_visuals.timeline_versions(
      timeline_id, owner_id, project_id, revision, name, summary,
      content_hash, timeline, otio, created_by
    ) values (
      current_row.id, current_row.owner_id, current_row.project_id,
      current_row.revision, current_row.name,
      'Baseline captured before version restore.',
      p_previous_content_hash, current_row.timeline, current_row.otio, p_actor_id
    )
    on conflict (timeline_id, revision) do nothing;
    select id into parent_id
    from executive_visuals.timeline_versions
    where timeline_id = p_timeline_id and revision = current_row.revision
    limit 1;
  end if;

  next_revision := current_row.revision + 1;
  update executive_visuals.timelines
  set name = source_row.name,
      revision = next_revision,
      timeline = source_row.timeline,
      otio = source_row.otio,
      updated_at = now()
  where id = p_timeline_id
  returning * into restored_row;

  insert into executive_visuals.timeline_versions(
    timeline_id, owner_id, project_id, revision, parent_version_id,
    restored_from_version_id, name, summary, content_hash, timeline, otio, created_by
  ) values (
    restored_row.id, restored_row.owner_id, restored_row.project_id,
    restored_row.revision, parent_id, source_row.id,
    restored_row.name,
    left(coalesce(p_summary, 'Restored from revision ' || source_row.revision::text), 500),
    p_content_hash, restored_row.timeline, restored_row.otio, p_actor_id
  );

  return next restored_row;
end;
$function$;

revoke all on function executive_visuals.ev_create_timeline_with_version(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,text) from public, anon, authenticated;
revoke all on function executive_visuals.ev_update_timeline_with_version(uuid,uuid,uuid,integer,text,jsonb,jsonb,text,text,text) from public, anon, authenticated;
revoke all on function executive_visuals.ev_restore_timeline_version(uuid,uuid,uuid,integer,uuid,text,text,text) from public, anon, authenticated;
grant execute on function executive_visuals.ev_create_timeline_with_version(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,text) to service_role;
grant execute on function executive_visuals.ev_update_timeline_with_version(uuid,uuid,uuid,integer,text,jsonb,jsonb,text,text,text) to service_role;
grant execute on function executive_visuals.ev_restore_timeline_version(uuid,uuid,uuid,integer,uuid,text,text,text) to service_role;
 then
    raise exception 'Timeline restore identity or revision is invalid.' using errcode = '22023';
  end if;

  select * into current_row
  from executive_visuals.timelines
  where id = p_timeline_id and archived_at is null
  for update;
  if not found or current_row.owner_id <> p_owner_id then
    raise exception 'Timeline not found.' using errcode = 'P0002';
  end if;
  if current_row.revision <> p_expected_revision then
    raise exception 'Timeline revision conflict.' using errcode = '40001';
  end if;

  select * into source_row
  from executive_visuals.timeline_versions
  where id = p_source_version_id
    and timeline_id = p_timeline_id
    and owner_id = p_owner_id;
  if not found then
    raise exception 'Source version not found.' using errcode = 'P0002';
  end if;

  select id into parent_id
  from executive_visuals.timeline_versions
  where timeline_id = p_timeline_id and revision = current_row.revision
  limit 1;
  if parent_id is null then
    insert into executive_visuals.timeline_versions(
      timeline_id, owner_id, project_id, revision, name, summary,
      content_hash, timeline, otio, created_by
    ) values (
      current_row.id, current_row.owner_id, current_row.project_id,
      current_row.revision, current_row.name,
      'Baseline captured before version restore.',
      p_previous_content_hash, current_row.timeline, current_row.otio, p_actor_id
    )
    on conflict (timeline_id, revision) do nothing;
    select id into parent_id
    from executive_visuals.timeline_versions
    where timeline_id = p_timeline_id and revision = current_row.revision
    limit 1;
  end if;

  next_revision := current_row.revision + 1;
  update executive_visuals.timelines
  set name = source_row.name,
      revision = next_revision,
      timeline = source_row.timeline,
      otio = source_row.otio,
      updated_at = now()
  where id = p_timeline_id
  returning * into restored_row;

  insert into executive_visuals.timeline_versions(
    timeline_id, owner_id, project_id, revision, parent_version_id,
    restored_from_version_id, name, summary, content_hash, timeline, otio, created_by
  ) values (
    restored_row.id, restored_row.owner_id, restored_row.project_id,
    restored_row.revision, parent_id, source_row.id,
    restored_row.name,
    left(coalesce(p_summary, 'Restored from revision ' || source_row.revision::text), 500),
    source_row.content_hash, restored_row.timeline, restored_row.otio, p_actor_id
  );

  return next restored_row;
end;
$function$;

revoke all on function executive_visuals.ev_create_timeline_with_version(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,text) from public, anon, authenticated;
revoke all on function executive_visuals.ev_update_timeline_with_version(uuid,uuid,uuid,integer,text,jsonb,jsonb,text,text,text) from public, anon, authenticated;
revoke all on function executive_visuals.ev_restore_timeline_version(uuid,uuid,uuid,integer,uuid,text,text) from public, anon, authenticated;
grant execute on function executive_visuals.ev_create_timeline_with_version(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,text) to service_role;
grant execute on function executive_visuals.ev_update_timeline_with_version(uuid,uuid,uuid,integer,text,jsonb,jsonb,text,text,text) to service_role;
grant execute on function executive_visuals.ev_restore_timeline_version(uuid,uuid,uuid,integer,uuid,text,text) to service_role;
