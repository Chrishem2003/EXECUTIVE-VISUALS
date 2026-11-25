-- Batch 124: initialize asset storage-retention checkpoints at verified asset publication.
-- The checkpoint is metadata, not a cost event; no cost is inferred at upload time.

create or replace function executive_visuals.initialize_asset_storage_retention_checkpoint()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $asset_checkpoint_init$
begin
  if new.deleted_at is null then
    insert into executive_visuals.asset_storage_retention_checkpoints(
      asset_id,owner_id,project_id,cursor_at
    ) values (
      new.id,new.owner_id,new.project_id,new.created_at
    )
    on conflict (asset_id) do nothing;
  end if;
  return new;
end;
$asset_checkpoint_init$;

revoke all on function executive_visuals.initialize_asset_storage_retention_checkpoint()
  from public,anon,authenticated,service_role;

drop trigger if exists initialize_asset_storage_retention_checkpoint
  on executive_visuals.assets;
create trigger initialize_asset_storage_retention_checkpoint
after insert on executive_visuals.assets
for each row
execute function executive_visuals.initialize_asset_storage_retention_checkpoint();

-- Existing active assets receive a cursor at their recorded creation time.
-- This is a tracking baseline only; no historical storage charge is fabricated.
insert into executive_visuals.asset_storage_retention_checkpoints(
  asset_id,owner_id,project_id,cursor_at
)
select id,owner_id,project_id,created_at
from executive_visuals.assets
where deleted_at is null
on conflict (asset_id) do nothing;

comment on function executive_visuals.initialize_asset_storage_retention_checkpoint() is
  'Creates the first asset-scoped storage-retention cursor after verified asset metadata publication; does not create cost events.';
