-- Completion lifecycle hardening: preserve the actual acting reviewer in the append-only event ledger.
-- Apply only after the review foundation migration has been reviewed and approved.
alter table executive_visuals.review_events
  drop constraint if exists review_events_event_type_check;

alter table executive_visuals.review_events
  add constraint review_events_event_type_check
  check (event_type in (
    'review.created',
    'review.edited',
    'review.resolved',
    'review.reopened',
    'review.dismissed',
    'review.decision_changed'
  ));

create or replace function executive_visuals.record_review_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, executive_visuals
as $$
declare
  kind text;
  payload jsonb;
  actor uuid;
begin
  if tg_op='UPDATE'
     and row(new.body,new.decision,new.status,new.visibility,new.annotation,
             new.timeline_id,new.timeline_revision,new.frame_number,new.duration_frames)
         is not distinct from
         row(old.body,old.decision,old.status,old.visibility,old.annotation,
             old.timeline_id,old.timeline_revision,old.frame_number,old.duration_frames) then
    return new;
  end if;

  actor := coalesce(new.last_actor_id,new.reviewer_id,new.owner_id);

  if tg_op='INSERT' then
    kind := 'review.created';
  elsif old.status not in ('resolved','dismissed') and new.status='resolved' then
    kind := 'review.resolved';
  elsif old.status not in ('resolved','dismissed') and new.status='dismissed' then
    kind := 'review.dismissed';
  elsif old.status in ('resolved','dismissed') and new.status='open' then
    kind := 'review.reopened';
  elsif old.decision is distinct from new.decision then
    kind := 'review.decision_changed';
  else
    kind := 'review.edited';
  end if;

  payload := jsonb_build_object(
    'decision',new.decision,
    'previousDecision',case when tg_op='UPDATE' then old.decision else null end,
    'status',new.status,
    'previousStatus',case when tg_op='UPDATE' then old.status else null end,
    'visibility',new.visibility,
    'frameNumber',new.frame_number,
    'durationFrames',new.duration_frames,
    'hasAnnotation',new.annotation is not null
  );

  insert into executive_visuals.review_events(
    review_id,owner_id,project_id,actor_id,event_type,event_data
  ) values (
    new.id,new.owner_id,new.project_id,actor,kind,payload
  );

  return new;
end;
$$;

revoke all on function executive_visuals.record_review_event() from public,anon,authenticated;
