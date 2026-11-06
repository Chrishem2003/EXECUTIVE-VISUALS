-- Bind append-only review audit events to the authenticated API actor.
-- Idempotency is scoped to the submitting reviewer, not the project owner.
drop index if exists executive_visuals.ev_reviews_owner_request;
create unique index if not exists ev_reviews_reviewer_request
  on executive_visuals.reviews(reviewer_id,request_id) where request_id is not null;

-- All review writes must pass through the authenticated server API so actor identity,
-- role checks, optimistic concurrency and event recording cannot be bypassed.
revoke insert,update,delete on executive_visuals.reviews from authenticated;
revoke insert,update,delete on executive_visuals.review_events from authenticated;
alter table executive_visuals.reviews
  add column if not exists last_actor_id uuid references auth.users(id) on delete set null;

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
    'hasAnnotation',new.annotation is not null
  );
  insert into executive_visuals.review_events(review_id,owner_id,project_id,actor_id,event_type,event_data)
  values(new.id,new.owner_id,new.project_id,coalesce(new.last_actor_id,new.reviewer_id,new.owner_id),kind,payload);
  return new;
end;
$$;
