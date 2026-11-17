-- Bind cloud timeline feedback to the exact source media bytes that were reviewed.
-- Additive only: existing review records remain explicitly unbound (NULL).
alter table executive_visuals.reviews
  add column if not exists asset_sha256 text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='ev_reviews_asset_sha256_format'
      and conrelid='executive_visuals.reviews'::regclass
  ) then
    alter table executive_visuals.reviews
      add constraint ev_reviews_asset_sha256_format
      check (asset_sha256 is null or asset_sha256 ~ '^[a-f0-9]{64}$');
  end if;
end
$$;

create index if not exists ev_reviews_asset_version
  on executive_visuals.reviews(asset_id,asset_sha256,created_at)
  where asset_id is not null;

-- Preserve the fingerprint in the append-only review event evidence.
create or replace function executive_visuals.record_review_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  kind text;
  payload jsonb;
begin
  if tg_op='INSERT' then
    kind := 'review.created';
  elsif old.status<>'resolved' and new.status='resolved' then
    kind := 'review.resolved';
  elsif old.status='resolved' and new.status='open' then
    kind := 'review.reopened';
  elsif old.decision is distinct from new.decision then
    kind := 'review.decision_changed';
  else
    kind := 'review.edited';
  end if;
  payload := jsonb_build_object(
    'decision',new.decision,
    'status',new.status,
    'visibility',new.visibility,
    'frameNumber',new.frame_number,
    'durationFrames',new.duration_frames,
    'assetSha256',new.asset_sha256,
    'hasAnnotation',new.annotation is not null
  );
  insert into executive_visuals.review_events(review_id,owner_id,project_id,actor_id,event_type,event_data)
  values(new.id,new.owner_id,new.project_id,coalesce(new.reviewer_id,new.owner_id),kind,payload);
  return new;
end;
$$;
revoke all on function executive_visuals.record_review_event() from public,anon,authenticated;
