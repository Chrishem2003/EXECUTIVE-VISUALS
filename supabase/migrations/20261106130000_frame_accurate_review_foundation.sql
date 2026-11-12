-- Frame-accurate review records and append-only review event history.
-- Apply only after the isolated Executive Visuals core migration has been reviewed.
alter table executive_visuals.reviews
  add column if not exists timeline_id uuid references executive_visuals.timelines(id) on delete restrict,
  add column if not exists timeline_revision integer,
  add column if not exists frame_number bigint,
  add column if not exists duration_frames integer,
  add column if not exists annotation jsonb,
  add column if not exists visibility text not null default 'project',
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists edited_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by uuid references auth.users(id) on delete set null,
  add column if not exists request_id text;

alter table executive_visuals.reviews
  add constraint ev_reviews_timeline_revision_positive check (timeline_revision is null or timeline_revision > 0),
  add constraint ev_reviews_frame_nonnegative check (frame_number is null or frame_number >= 0),
  add constraint ev_reviews_duration_frames_valid check (duration_frames is null or duration_frames between 1 and 90000),
  add constraint ev_reviews_visibility_valid check (visibility in ('project','internal')),
  add constraint ev_reviews_annotation_object check (annotation is null or (jsonb_typeof(annotation)='object' and octet_length(annotation::text)<=32768)),
  add constraint ev_reviews_request_id_valid check (request_id is null or char_length(request_id) between 8 and 128),
  add constraint ev_reviews_frame_anchor_consistent check (
    (frame_number is null and duration_frames is null and annotation is null)
    or frame_number is not null
  ),
  add constraint ev_reviews_timeline_anchor_consistent check (
    (timeline_id is null and timeline_revision is null)
    or (timeline_id is not null and timeline_revision is not null and frame_number is not null)
  );

create unique index if not exists ev_reviews_owner_request
  on executive_visuals.reviews(owner_id,request_id) where request_id is not null;
create index if not exists ev_reviews_asset_frame
  on executive_visuals.reviews(asset_id,frame_number,created_at) where asset_id is not null;
create index if not exists ev_reviews_timeline_revision
  on executive_visuals.reviews(timeline_id,timeline_revision,frame_number) where timeline_id is not null;

create table if not exists executive_visuals.review_events (
  id bigint generated always as identity primary key,
  review_id uuid not null references executive_visuals.reviews(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references executive_visuals.projects(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  event_type text not null check (event_type in ('review.created','review.edited','review.resolved','review.reopened','review.decision_changed')),
  event_data jsonb not null default '{}'::jsonb check (jsonb_typeof(event_data)='object' and octet_length(event_data::text)<=4096),
  created_at timestamptz not null default now()
);
create index if not exists ev_review_events_review_created
  on executive_visuals.review_events(review_id,created_at,id);

alter table executive_visuals.review_events enable row level security;
revoke all on executive_visuals.review_events from public,anon,authenticated;
grant select on executive_visuals.review_events to authenticated;
grant select,insert on executive_visuals.review_events to service_role;
revoke update,delete on executive_visuals.review_events from service_role;

-- Internal comments are visible only to project owners, their author, editors and reviewers.
drop policy if exists ev_reviews_read on executive_visuals.reviews;
create policy ev_reviews_read on executive_visuals.reviews for select to authenticated
using (
  owner_id=(select auth.uid())
  or exists (select 1 from executive_visuals.projects p where p.id=reviews.project_id and p.owner_id=(select auth.uid()))
  or exists (select 1 from executive_visuals.project_members m
    where m.project_id=reviews.project_id and m.member_id=(select auth.uid())
      and (reviews.visibility='project' or m.role in ('editor','reviewer')))
);

create policy ev_review_events_read on executive_visuals.review_events for select to authenticated
using (
  exists (select 1 from executive_visuals.reviews r
    where r.id=review_events.review_id
      and (r.owner_id=(select auth.uid())
        or exists (select 1 from executive_visuals.projects p where p.id=r.project_id and p.owner_id=(select auth.uid()))
        or exists (select 1 from executive_visuals.project_members m
          where m.project_id=r.project_id and m.member_id=(select auth.uid())
            and (r.visibility='project' or m.role in ('editor','reviewer')))))
);

create or replace function executive_visuals.touch_review_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, executive_visuals
as $$
begin
  new.updated_at := now();
  if row(new.body,new.decision,new.status,new.visibility,new.annotation)
     is distinct from row(old.body,old.decision,old.status,old.visibility,old.annotation) then
    new.edited_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists ev_reviews_touch_updated_at on executive_visuals.reviews;
create trigger ev_reviews_touch_updated_at
before update on executive_visuals.reviews
for each row execute function executive_visuals.touch_review_updated_at();
revoke all on function executive_visuals.touch_review_updated_at() from public,anon,authenticated;

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
  values(new.id,new.owner_id,new.project_id,coalesce(new.reviewer_id,new.owner_id),kind,payload);
  return new;
end;
$$;

drop trigger if exists ev_reviews_record_event on executive_visuals.reviews;
create trigger ev_reviews_record_event
after insert or update on executive_visuals.reviews
for each row execute function executive_visuals.record_review_event();

revoke all on function executive_visuals.record_review_event() from public,anon,authenticated;
