create index if not exists asset_egress_attempts_asset_idx
  on executive_visuals.asset_egress_transfer_attempts(asset_id);
create index if not exists asset_egress_attempts_project_idx
  on executive_visuals.asset_egress_transfer_attempts(project_id);
create index if not exists asset_egress_attempts_initiated_by_idx
  on executive_visuals.asset_egress_transfer_attempts(initiated_by);
