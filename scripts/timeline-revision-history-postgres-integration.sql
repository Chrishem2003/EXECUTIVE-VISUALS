\set ON_ERROR_STOP on
do $$ declare n integer; begin
 select count(*) into n from executive_visuals.timeline_revisions where timeline_id='30000000-0000-4000-8000-000000000001' and revision=1;
 if n<>1 then raise exception 'Initial timeline revision was not backfilled exactly once (count=%).',n; end if;
end $$;
update executive_visuals.timelines set revision=2,timeline=timeline || '{"label":"revision-two"}'::jsonb,updated_at=now() where id='30000000-0000-4000-8000-000000000001';
do $$ declare n integer; payload jsonb; begin
 select count(*) into n from executive_visuals.timeline_revisions where timeline_id='30000000-0000-4000-8000-000000000001';
 if n<>2 then raise exception 'Revision trigger did not capture revision 2 (count=%).',n; end if;
 select timeline into payload from executive_visuals.timeline_revisions where timeline_id='30000000-0000-4000-8000-000000000001' and revision=2;
 if payload->>'label'<>'revision-two' then raise exception 'Revision 2 snapshot payload is incorrect.'; end if;
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
do $$ declare n integer; begin select count(*) into n from executive_visuals.timeline_revisions where timeline_id='30000000-0000-4000-8000-000000000001'; if n<>2 then raise exception 'Timeline owner cannot read all revisions.'; end if; end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
do $$ declare n integer; begin select count(*) into n from executive_visuals.timeline_revisions where timeline_id='30000000-0000-4000-8000-000000000001'; if n<>2 then raise exception 'Project editor cannot read timeline revisions.'; end if; end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',false);
do $$ declare n integer; begin select count(*) into n from executive_visuals.timeline_revisions where timeline_id='30000000-0000-4000-8000-000000000001'; if n<>0 then raise exception 'Unrelated user can read private timeline revisions.'; end if; end $$;
reset role;

-- Moving a timeline must move access to its entire revision history.
update executive_visuals.timelines
set project_id='20000000-0000-4000-8000-000000000002'
where id='30000000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
do $ declare n integer; begin
 select count(*) into n from executive_visuals.timeline_revisions where timeline_id='30000000-0000-4000-8000-000000000001';
 if n<>0 then raise exception 'Former project member retained access after timeline move.'; end if;
end $;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000004',false);
do $ declare n integer; begin
 select count(*) into n from executive_visuals.timeline_revisions where timeline_id='30000000-0000-4000-8000-000000000001';
 if n<>2 then raise exception 'Current project member cannot read timeline history after move.'; end if;
end $;
reset role;

do $ begin
 if has_table_privilege('service_role','executive_visuals.timeline_revisions','INSERT')
 or has_table_privilege('service_role','executive_visuals.timeline_revisions','UPDATE')
 or has_table_privilege('service_role','executive_visuals.timeline_revisions','DELETE')
 or has_table_privilege('service_role','executive_visuals.timeline_revisions','TRUNCATE') then
  raise exception 'Service role must not mutate or truncate immutable revision snapshots.';
 end if;
 begin update executive_visuals.timeline_revisions set name='tampered' where timeline_id='30000000-0000-4000-8000-000000000001' and revision=1;
  raise exception 'Immutable revision UPDATE unexpectedly succeeded.';
 exception when sqlstate '55000' then null; end;
 begin delete from executive_visuals.timeline_revisions where timeline_id='30000000-0000-4000-8000-000000000001' and revision=1;
  raise exception 'Immutable revision DELETE unexpectedly succeeded.';
 exception when sqlstate '55000' then null; end;
end $$;
do $$ declare n integer; begin select count(*) into n from executive_visuals.timeline_revisions where timeline_id='30000000-0000-4000-8000-000000000001'; if n<>2 then raise exception 'Rejected mutations changed the revision history.'; end if; end $$;
