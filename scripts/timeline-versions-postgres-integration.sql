-- Verify atomic timeline version creation, optimistic updates, restore lineage and append-only privileges.
\set ON_ERROR_STOP on

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222')
on conflict (id) do nothing;

set role service_role;

do $$
declare
  owner_id constant uuid := '11111111-1111-4111-8111-111111111111';
  actor_id constant uuid := '22222222-2222-4222-8222-222222222222';
  v_timeline_id constant uuid := '33333333-3333-4333-8333-333333333333';
  first_timeline executive_visuals.timelines;
  second_timeline executive_visuals.timelines;
  restored_timeline executive_visuals.timelines;
  first_version executive_visuals.timeline_versions;
  second_version executive_visuals.timeline_versions;
  restored_version executive_visuals.timeline_versions;
  first_doc jsonb := '{"frameRate":{"numerator":24,"denominator":1},"tracks":[],"markers":[],"title":"First"}'::jsonb;
  second_doc jsonb := '{"frameRate":{"numerator":24,"denominator":1},"tracks":[],"markers":[],"title":"Second"}'::jsonb;
begin
  select * into first_timeline
  from executive_visuals.ev_create_timeline_with_version(
    v_timeline_id, owner_id, owner_id, null, 'Version test', first_doc, null,
    'Initial version', repeat('a',64)
  );
  if first_timeline.revision <> 1 then raise exception 'Initial timeline revision was not 1.'; end if;

  select * into first_version
  from executive_visuals.timeline_versions tv
  where tv.timeline_id = v_timeline_id and tv.revision = 1;
  if first_version.id is null or first_version.content_hash <> repeat('a',64) then
    raise exception 'Initial immutable version was not created.';
  end if;

  select * into second_timeline
  from executive_visuals.ev_update_timeline_with_version(
    v_timeline_id, owner_id, actor_id, 1, 'Version test v2', second_doc, null,
    'Updated title and sequence', repeat('a',64), repeat('b',64)
  );
  if second_timeline.revision <> 2 then raise exception 'Versioned update did not increment revision.'; end if;

  select * into second_version
  from executive_visuals.timeline_versions tv
  where tv.timeline_id = v_timeline_id and tv.revision = 2;
  if second_version.parent_version_id <> first_version.id then
    raise exception 'Version update did not preserve its parent lineage.';
  end if;

  select * into restored_timeline
  from executive_visuals.ev_restore_timeline_version(
    timeline_id, owner_id, actor_id, 2, first_version.id,
    'Restore the first cut', repeat('b',64), repeat('a',64)
  );
  if restored_timeline.revision <> 3 or restored_timeline.timeline <> first_doc then
    raise exception 'Restore did not create a new revision containing the selected snapshot.';
  end if;

  select * into restored_version
  from executive_visuals.timeline_versions tv
  where tv.timeline_id = timeline_id and tv.revision = 3;
  if restored_version.parent_version_id <> second_version.id
     or restored_version.restored_from_version_id <> first_version.id then
    raise exception 'Restore lineage must point to both the previous head and restored source.';
  end if;

  begin
    perform * from executive_visuals.ev_update_timeline_with_version(
      timeline_id, owner_id, actor_id, 2, 'Stale', second_doc, null,
      'Stale update', repeat('a',64), repeat('c',64)
    );
    raise exception 'Stale version update unexpectedly succeeded.';
  exception when serialization_failure then
    null;
  end;

  if has_table_privilege('service_role','executive_visuals.timeline_versions','UPDATE')
     or has_table_privilege('service_role','executive_visuals.timeline_versions','DELETE') then
    raise exception 'Version snapshots must be append-only for service_role.';
  end if;
  if not has_function_privilege('service_role','executive_visuals.ev_restore_timeline_version(uuid,uuid,uuid,integer,uuid,text,text,text)','EXECUTE') then
    raise exception 'Service role is missing restore function permission.';
  end if;
end;
$$;

reset role;
