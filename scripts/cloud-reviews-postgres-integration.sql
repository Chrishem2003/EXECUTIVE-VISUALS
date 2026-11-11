\set ON_ERROR_STOP on
begin;

insert into auth.users(id) values
 ('123e4567-e89b-42d3-a456-426614174000'),
 ('223e4567-e89b-42d3-a456-426614174000'),
 ('323e4567-e89b-42d3-a456-426614174000')
on conflict do nothing;

insert into executive_visuals.projects(id,owner_id,name)
values('423e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000','Review integration project')
on conflict do nothing;

insert into executive_visuals.project_members(project_id,member_id,role,invited_by)
values
 ('423e4567-e89b-42d3-a456-426614174000','223e4567-e89b-42d3-a456-426614174000','reviewer','123e4567-e89b-42d3-a456-426614174000'),
 ('423e4567-e89b-42d3-a456-426614174000','323e4567-e89b-42d3-a456-426614174000','viewer','123e4567-e89b-42d3-a456-426614174000')
on conflict do nothing;

insert into executive_visuals.timelines(id,owner_id,project_id,name,revision,timeline)
values('523e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000','423e4567-e89b-42d3-a456-426614174000','Review timeline',3,'{"frameRate":{"numerator":24,"denominator":1}}'::jsonb)
on conflict do nothing;

insert into executive_visuals.assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path)
values('623e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000','423e4567-e89b-42d3-a456-426614174000','master.mp4','video/mp4',1,repeat('a',64),'executive-visuals-media','123e4567-e89b-42d3-a456-426614174000/423e4567-e89b-42d3-a456-426614174000/623e4567-e89b-42d3-a456-426614174000/original.mp4')
on conflict do nothing;

insert into executive_visuals.reviews(
 id,owner_id,project_id,asset_id,reviewer_id,last_actor_id,timecode_seconds,body,decision,status,
 timeline_id,timeline_revision,frame_number,duration_frames,annotation,visibility,request_id
) values(
 '723e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '423e4567-e89b-42d3-a456-426614174000',
 '623e4567-e89b-42d3-a456-426614174000',
 '223e4567-e89b-42d3-a456-426614174000',
 '223e4567-e89b-42d3-a456-426614174000',
 2.0,'Align the title with the product edge.','request_changes','open',
 '523e4567-e89b-42d3-a456-426614174000',3,48,24,
 '{"version":1,"shapes":[{"type":"arrow","points":[{"x":0.1,"y":0.2},{"x":0.8,"y":0.7}],"color":"#ffcc00","width":3}]}',
 'project','review-request-0001'
);

do $$
begin
 if (select count(*) from executive_visuals.review_events where review_id='723e4567-e89b-42d3-a456-426614174000')<>1 then
  raise exception 'Review creation must append exactly one immutable audit event';
 end if;
 if not exists(select 1 from executive_visuals.reviews where id='723e4567-e89b-42d3-a456-426614174000' and frame_number=48 and timeline_revision=3 and timecode_seconds=2.0) then
  raise exception 'Frame-anchored review was not persisted with its timecode';
 end if;
end $$;

update executive_visuals.reviews
 set status='resolved',resolved_at=now(),resolved_by='123e4567-e89b-42d3-a456-426614174000',
     last_actor_id='123e4567-e89b-42d3-a456-426614174000'
 where id='723e4567-e89b-42d3-a456-426614174000';

do $$
begin
 if (select count(*) from executive_visuals.review_events where review_id='723e4567-e89b-42d3-a456-426614174000')<>2 then
  raise exception 'Review resolution must append a second audit event';
 end if;
 if not exists(select 1 from executive_visuals.review_events where review_id='723e4567-e89b-42d3-a456-426614174000' and actor_id='123e4567-e89b-42d3-a456-426614174000' and event_type='review.resolved') then
  raise exception 'Review resolution audit event must record the actual actor';
 end if;
end $$;

rollback;
