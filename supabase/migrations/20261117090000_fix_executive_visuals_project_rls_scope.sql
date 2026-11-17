-- Fix correlated references in Executive Visuals tenant RLS policies.
-- In PostgreSQL, an unqualified project_id inside a project_members subquery
-- binds to the inner project_members row, creating a tautological comparison against the inner row.
-- Qualify every outer-row reference so membership is scoped to the target record.
-- Storage policies must qualify objects.name; otherwise projects.name shadows it.

alter policy ev_workflows_insert on executive_visuals.workflows
with check (
  workflows.owner_id = (select auth.uid())
  and (
    workflows.project_id is null
    or exists (
      select 1 from executive_visuals.projects p
      where p.id = workflows.project_id and p.owner_id = (select auth.uid())
    )
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id = workflows.project_id
        and m.member_id = (select auth.uid())
        and m.role = 'editor'
    )
  )
);

alter policy ev_workflows_update on executive_visuals.workflows
with check (
  (workflows.project_id is null and workflows.owner_id = (select auth.uid()))
  or exists (
    select 1 from executive_visuals.projects p
    where p.id = workflows.project_id and p.owner_id = (select auth.uid())
  )
  or exists (
    select 1 from executive_visuals.project_members m
    where m.project_id = workflows.project_id
      and m.member_id = (select auth.uid())
      and m.role = 'editor'
  )
);

alter policy ev_workflow_runs_insert on executive_visuals.workflow_runs
with check (
  workflow_runs.owner_id = (select auth.uid())
  and workflow_runs.status = 'awaiting_approval'
  and workflow_runs.job_id is null
  and (
    workflow_runs.project_id is null
    or exists (
      select 1 from executive_visuals.projects p
      where p.id = workflow_runs.project_id and p.owner_id = (select auth.uid())
    )
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id = workflow_runs.project_id
        and m.member_id = (select auth.uid())
        and m.role = 'editor'
    )
  )
);

alter policy ev_timelines_insert on executive_visuals.timelines
with check (
  timelines.owner_id = (select auth.uid())
  and (
    timelines.project_id is null
    or exists (
      select 1 from executive_visuals.projects p
      where p.id = timelines.project_id and p.owner_id = (select auth.uid())
    )
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id = timelines.project_id
        and m.member_id = (select auth.uid())
        and m.role = 'editor'
    )
  )
);

alter policy ev_timelines_update on executive_visuals.timelines
with check (
  (timelines.project_id is null and timelines.owner_id = (select auth.uid()))
  or exists (
    select 1 from executive_visuals.projects p
    where p.id = timelines.project_id and p.owner_id = (select auth.uid())
  )
  or exists (
    select 1 from executive_visuals.project_members m
    where m.project_id = timelines.project_id
      and m.member_id = (select auth.uid())
      and m.role = 'editor'
  )
);

alter policy ev_assets_insert on executive_visuals.assets
with check (
  assets.owner_id = (select auth.uid())
  and (
    assets.project_id is null
    or exists (
      select 1 from executive_visuals.projects p
      where p.id = assets.project_id and p.owner_id = (select auth.uid())
    )
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id = assets.project_id
        and m.member_id = (select auth.uid())
        and m.role = 'editor'
    )
  )
);

alter policy ev_assets_update on executive_visuals.assets
with check (
  (assets.project_id is null and assets.owner_id = (select auth.uid()))
  or exists (
    select 1 from executive_visuals.projects p
    where p.id = assets.project_id and p.owner_id = (select auth.uid())
  )
  or exists (
    select 1 from executive_visuals.project_members m
    where m.project_id = assets.project_id
      and m.member_id = (select auth.uid())
      and m.role = 'editor'
  )
);

alter policy ev_jobs_insert on executive_visuals.jobs
with check (
  jobs.owner_id = (select auth.uid())
  and jobs.status in ('draft', 'awaiting_approval')
  and jobs.progress = 0
  and jobs.output is null
  and jobs.error is null
  and jobs.attempt_count = 0
  and jobs.approved_by is null
  and jobs.approved_at is null
  and (
    jobs.project_id is null
    or exists (
      select 1 from executive_visuals.projects p
      where p.id = jobs.project_id and p.owner_id = (select auth.uid())
    )
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id = jobs.project_id
        and m.member_id = (select auth.uid())
        and m.role = 'editor'
    )
  )
);

alter policy ev_jobs_update on executive_visuals.jobs
with check (
  (jobs.project_id is null and jobs.owner_id = (select auth.uid()))
  or exists (
    select 1 from executive_visuals.projects p
    where p.id = jobs.project_id and p.owner_id = (select auth.uid())
  )
  or exists (
    select 1 from executive_visuals.project_members m
    where m.project_id = jobs.project_id
      and m.member_id = (select auth.uid())
      and m.role = 'editor'
  )
);

alter policy ev_reviews_insert on executive_visuals.reviews
with check (
  reviews.owner_id = (select auth.uid())
  and (
    reviews.project_id is null
    or exists (
      select 1 from executive_visuals.projects p
      where p.id = reviews.project_id and p.owner_id = (select auth.uid())
    )
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id = reviews.project_id
        and m.member_id = (select auth.uid())
        and m.role in ('editor', 'reviewer')
    )
  )
);

alter policy ev_reviews_update on executive_visuals.reviews
with check (
  reviews.owner_id = (select auth.uid())
  or exists (
    select 1 from executive_visuals.projects p
    where p.id = reviews.project_id and p.owner_id = (select auth.uid())
  )
  or exists (
    select 1 from executive_visuals.project_members m
    where m.project_id = reviews.project_id
      and m.member_id = (select auth.uid())
      and m.role in ('editor', 'reviewer')
  )
);

alter policy ev_storage_read on storage.objects
using (
  bucket_id = 'executive-visuals-media'
  and (
    (storage.foldername(objects.name))[1] = (select auth.uid())::text
    or exists (
      select 1 from executive_visuals.projects p
      where p.id::text = (storage.foldername(objects.name))[1]
        and p.owner_id = (select auth.uid())
    )
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id::text = (storage.foldername(objects.name))[1]
        and m.member_id = (select auth.uid())
    )
  )
);

alter policy ev_storage_insert on storage.objects
with check (
  bucket_id = 'executive-visuals-media'
  and (
    (storage.foldername(objects.name))[1] = (select auth.uid())::text
    or exists (
      select 1 from executive_visuals.projects p
      where p.id::text = (storage.foldername(objects.name))[1]
        and p.owner_id = (select auth.uid())
    )
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id::text = (storage.foldername(objects.name))[1]
        and m.member_id = (select auth.uid())
        and m.role = 'editor'
    )
  )
);

alter policy ev_storage_update on storage.objects
using (
  bucket_id = 'executive-visuals-media'
  and (
    (storage.foldername(objects.name))[1] = (select auth.uid())::text
    or exists (
      select 1 from executive_visuals.projects p
      where p.id::text = (storage.foldername(objects.name))[1]
        and p.owner_id = (select auth.uid())
    )
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id::text = (storage.foldername(objects.name))[1]
        and m.member_id = (select auth.uid())
        and m.role = 'editor'
    )
  )
)
with check (
  bucket_id = 'executive-visuals-media'
  and (
    (storage.foldername(objects.name))[1] = (select auth.uid())::text
    or exists (
      select 1 from executive_visuals.projects p
      where p.id::text = (storage.foldername(objects.name))[1]
        and p.owner_id = (select auth.uid())
    )
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id::text = (storage.foldername(objects.name))[1]
        and m.member_id = (select auth.uid())
        and m.role = 'editor'
    )
  )
);

alter policy ev_storage_delete on storage.objects
using (
  bucket_id = 'executive-visuals-media'
  and (
    (storage.foldername(objects.name))[1] = (select auth.uid())::text
    or exists (
      select 1 from executive_visuals.projects p
      where p.id::text = (storage.foldername(objects.name))[1]
        and p.owner_id = (select auth.uid())
    )
    or exists (
      select 1 from executive_visuals.project_members m
      where m.project_id::text = (storage.foldername(objects.name))[1]
        and m.member_id = (select auth.uid())
        and m.role = 'editor'
    )
  )
);
