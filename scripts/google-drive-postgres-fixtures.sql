-- Deterministic private owner/project/asset fixtures for Drive ledger integration tests.
insert into auth.users(id) values ('11111111-1111-4111-8111-111111111111') on conflict(id) do nothing;
insert into executive_visuals.projects(id,owner_id,name)
values ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Drive integration test')
on conflict(id) do nothing;
insert into executive_visuals.assets(
 id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path
) values (
 '33333333-3333-4333-8333-333333333333',
 '11111111-1111-4111-8111-111111111111',
 '22222222-2222-4222-8222-222222222222',
 'private-test.png','image/png',24,repeat('a',64),'executive-visuals-media',
 '22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/private-test.png'
) on conflict(id) do nothing;
