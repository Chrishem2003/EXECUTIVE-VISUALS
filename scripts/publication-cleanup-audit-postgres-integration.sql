\set ON_ERROR_STOP on
begin;

do $$
declare
  audit_id uuid;
  table_oid oid;
begin
  select c.oid into table_oid
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='executive_visuals'
    and c.relname='publication_cleanup_audit_events'
    and c.relkind='r';

  if table_oid is null then
    raise exception 'publication cleanup audit table is missing';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid=table_oid) then
    raise exception 'publication cleanup audit table must enable RLS';
  end if;
  if not has_table_privilege('service_role',table_oid,'SELECT')
     or not has_table_privilege('service_role',table_oid,'INSERT') then
    raise exception 'service_role must be able to read and append publication cleanup audit events';
  end if;
  if has_table_privilege('service_role',table_oid,'UPDATE')
     or has_table_privilege('service_role',table_oid,'DELETE')
     or has_table_privilege('anon',table_oid,'SELECT')
     or has_table_privilege('authenticated',table_oid,'SELECT') then
    raise exception 'publication cleanup audit privileges are broader than the service-role append/read contract';
  end if;

  insert into executive_visuals.publication_cleanup_audit_events(
    run_id,event_type,owner_id,dry_run,details
  ) values (
    gen_random_uuid(),'publication.cleanup_completed',
    '11111111-1111-4111-8111-111111111111',true,'{"source":"ci"}'::jsonb
  ) returning id into audit_id;

  begin
    update executive_visuals.publication_cleanup_audit_events
      set details='{"mutated":true}'::jsonb
      where id=audit_id;
    raise exception 'append-only audit trigger did not reject UPDATE';
  exception when sqlstate '55000' then
    null;
  end;

  begin
    delete from executive_visuals.publication_cleanup_audit_events where id=audit_id;
    raise exception 'append-only audit trigger did not reject DELETE';
  exception when sqlstate '55000' then
    null;
  end;
end;
$$;

rollback;
