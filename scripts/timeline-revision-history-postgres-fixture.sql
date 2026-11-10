-- Pre-migration fixture: verifies the migration backfills the current timeline revision.
insert into auth.users(id) values
 ('10000000-0000-4000-8000-000000000001'),
 ('10000000-0000-4000-8000-000000000002'),
 ('10000000-0000-4000-8000-000000000003')
on conflict(id) do nothing;
insert into executive_visuals.projects(id,owner_id,name)
values ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Revision history test')
on conflict(id) do nothing;
insert into executive_visuals.project_members(project_id,member_id,role,invited_by)
values ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','editor','10000000-0000-4000-8000-000000000001')
on conflict(project_id,member_id) do nothing;
insert into executive_visuals.timelines(id,owner_id,project_id,name,revision,timeline,otio)
values ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Revision fixture',1,'{"tracks":[],"markers":[]}'::jsonb,null)
on conflict(id) do nothing;
