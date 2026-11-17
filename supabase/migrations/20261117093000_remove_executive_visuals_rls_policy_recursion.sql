-- Remove mutually-recursive RLS policy lookups between projects and project_members.
-- These SECURITY DEFINER helpers are owned by the migration role and bypass RLS
-- only for the narrow membership/ownership lookup. The helpers expose booleans,
-- not rows, and all callers pass an explicit target project and auth.uid().

create or replace function executive_visuals.is_project_owner(
  p_project_id uuid,
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, executive_visuals
set row_security = off
as $$
  select exists (
    select 1 from executive_visuals.projects p
    where p.id = p_project_id and p.owner_id = p_user_id
  );
$$;

create or replace function executive_visuals.has_project_role(
  p_project_id uuid,
  p_user_id uuid,
  p_allowed_roles text[] default array['editor','reviewer','viewer']::text[]
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, executive_visuals
set row_security = off
as $$
  select exists (
    select 1 from executive_visuals.project_members m
    where m.project_id = p_project_id
      and m.member_id = p_user_id
      and m.role = any(p_allowed_roles)
  );
$$;

revoke all on function executive_visuals.is_project_owner(uuid, uuid) from public, anon;
revoke all on function executive_visuals.has_project_role(uuid, uuid, text[]) from public, anon;
grant execute on function executive_visuals.is_project_owner(uuid, uuid) to authenticated, service_role;
grant execute on function executive_visuals.has_project_role(uuid, uuid, text[]) to authenticated, service_role;

alter policy ev_projects_read on executive_visuals.projects
using (
  projects.owner_id = (select auth.uid())
  or executive_visuals.has_project_role(projects.id, (select auth.uid()))
);

alter policy ev_members_read on executive_visuals.project_members
using (
  project_members.member_id = (select auth.uid())
  or executive_visuals.is_project_owner(project_members.project_id, (select auth.uid()))
);

alter policy ev_members_insert on executive_visuals.project_members
with check (
  project_members.invited_by = (select auth.uid())
  and executive_visuals.is_project_owner(project_members.project_id, (select auth.uid()))
);

alter policy ev_members_update on executive_visuals.project_members
using (executive_visuals.is_project_owner(project_members.project_id, (select auth.uid())))
with check (executive_visuals.is_project_owner(project_members.project_id, (select auth.uid())));

alter policy ev_members_delete on executive_visuals.project_members
using (executive_visuals.is_project_owner(project_members.project_id, (select auth.uid())));

alter policy ev_project_workspace_read on executive_visuals.project_workspace_documents
using (
  executive_visuals.is_project_owner(project_workspace_documents.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(project_workspace_documents.project_id, (select auth.uid()))
);

alter policy ev_project_workspace_insert on executive_visuals.project_workspace_documents
with check (
  executive_visuals.is_project_owner(project_workspace_documents.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(project_workspace_documents.project_id, (select auth.uid()), array['editor']::text[])
);

alter policy ev_project_workspace_update on executive_visuals.project_workspace_documents
using (
  executive_visuals.is_project_owner(project_workspace_documents.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(project_workspace_documents.project_id, (select auth.uid()), array['editor']::text[])
)
with check (
  executive_visuals.is_project_owner(project_workspace_documents.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(project_workspace_documents.project_id, (select auth.uid()), array['editor']::text[])
);

alter policy ev_workflows_read on executive_visuals.workflows
using (
  workflows.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(workflows.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(workflows.project_id, (select auth.uid()))
);

alter policy ev_workflows_insert on executive_visuals.workflows
with check (
  workflows.owner_id = (select auth.uid())
  and (
    workflows.project_id is null
    or executive_visuals.is_project_owner(workflows.project_id, (select auth.uid()))
    or executive_visuals.has_project_role(workflows.project_id, (select auth.uid()), array['editor']::text[])
  )
);

alter policy ev_workflows_update on executive_visuals.workflows
using (
  workflows.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(workflows.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(workflows.project_id, (select auth.uid()), array['editor']::text[])
)
with check (
  (workflows.project_id is null and workflows.owner_id = (select auth.uid()))
  or executive_visuals.is_project_owner(workflows.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(workflows.project_id, (select auth.uid()), array['editor']::text[])
);

alter policy ev_workflows_delete on executive_visuals.workflows
using (
  workflows.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(workflows.project_id, (select auth.uid()))
);

alter policy ev_workflow_runs_read on executive_visuals.workflow_runs
using (
  workflow_runs.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(workflow_runs.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(workflow_runs.project_id, (select auth.uid()))
);

alter policy ev_workflow_runs_insert on executive_visuals.workflow_runs
with check (
  workflow_runs.owner_id = (select auth.uid())
  and workflow_runs.status = 'awaiting_approval'
  and workflow_runs.job_id is null
  and (
    workflow_runs.project_id is null
    or executive_visuals.is_project_owner(workflow_runs.project_id, (select auth.uid()))
    or executive_visuals.has_project_role(workflow_runs.project_id, (select auth.uid()), array['editor']::text[])
  )
);

alter policy ev_workflow_runs_update on executive_visuals.workflow_runs
using (
  workflow_runs.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(workflow_runs.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(workflow_runs.project_id, (select auth.uid()), array['editor']::text[])
)
with check (
  workflow_runs.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(workflow_runs.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(workflow_runs.project_id, (select auth.uid()), array['editor']::text[])
);

alter policy ev_workflow_node_runs_read on executive_visuals.workflow_node_runs
using (
  exists (
    select 1 from executive_visuals.workflow_runs r
    where r.id = workflow_node_runs.run_id
      and (
        r.owner_id = (select auth.uid())
        or executive_visuals.is_project_owner(r.project_id, (select auth.uid()))
        or executive_visuals.has_project_role(r.project_id, (select auth.uid()))
      )
  )
);

alter policy ev_timelines_read on executive_visuals.timelines
using (
  timelines.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(timelines.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(timelines.project_id, (select auth.uid()))
);

alter policy ev_timelines_insert on executive_visuals.timelines
with check (
  timelines.owner_id = (select auth.uid())
  and (
    timelines.project_id is null
    or executive_visuals.is_project_owner(timelines.project_id, (select auth.uid()))
    or executive_visuals.has_project_role(timelines.project_id, (select auth.uid()), array['editor']::text[])
  )
);

alter policy ev_timelines_update on executive_visuals.timelines
using (
  timelines.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(timelines.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(timelines.project_id, (select auth.uid()), array['editor']::text[])
)
with check (
  (timelines.project_id is null and timelines.owner_id = (select auth.uid()))
  or executive_visuals.is_project_owner(timelines.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(timelines.project_id, (select auth.uid()), array['editor']::text[])
);

alter policy ev_timelines_delete on executive_visuals.timelines
using (
  timelines.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(timelines.project_id, (select auth.uid()))
);

alter policy ev_assets_read on executive_visuals.assets
using (
  assets.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(assets.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(assets.project_id, (select auth.uid()))
);

alter policy ev_assets_insert on executive_visuals.assets
with check (
  assets.owner_id = (select auth.uid())
  and (
    assets.project_id is null
    or executive_visuals.is_project_owner(assets.project_id, (select auth.uid()))
    or executive_visuals.has_project_role(assets.project_id, (select auth.uid()), array['editor']::text[])
  )
);

alter policy ev_assets_update on executive_visuals.assets
using (
  assets.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(assets.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(assets.project_id, (select auth.uid()), array['editor']::text[])
)
with check (
  (assets.project_id is null and assets.owner_id = (select auth.uid()))
  or executive_visuals.is_project_owner(assets.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(assets.project_id, (select auth.uid()), array['editor']::text[])
);

alter policy ev_assets_delete on executive_visuals.assets
using (
  assets.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(assets.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(assets.project_id, (select auth.uid()), array['editor']::text[])
);

alter policy ev_jobs_read on executive_visuals.jobs
using (
  jobs.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(jobs.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(jobs.project_id, (select auth.uid()))
);

alter policy ev_jobs_insert on executive_visuals.jobs
with check (
  jobs.owner_id = (select auth.uid())
  and jobs.status in ('draft','awaiting_approval')
  and jobs.progress = 0
  and jobs.output is null
  and jobs.error is null
  and jobs.attempt_count = 0
  and jobs.approved_by is null
  and jobs.approved_at is null
  and (
    jobs.project_id is null
    or executive_visuals.is_project_owner(jobs.project_id, (select auth.uid()))
    or executive_visuals.has_project_role(jobs.project_id, (select auth.uid()), array['editor']::text[])
  )
);

alter policy ev_jobs_update on executive_visuals.jobs
using (
  jobs.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(jobs.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(jobs.project_id, (select auth.uid()), array['editor']::text[])
)
with check (
  (jobs.project_id is null and jobs.owner_id = (select auth.uid()))
  or executive_visuals.is_project_owner(jobs.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(jobs.project_id, (select auth.uid()), array['editor']::text[])
);

alter policy ev_jobs_delete on executive_visuals.jobs
using (
  jobs.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(jobs.project_id, (select auth.uid()))
);

alter policy ev_job_events_read on executive_visuals.job_events
using (
  job_events.owner_id = (select auth.uid())
  or exists (
    select 1 from executive_visuals.jobs j
    where j.id = job_events.job_id
      and (
        j.owner_id = (select auth.uid())
        or executive_visuals.is_project_owner(j.project_id, (select auth.uid()))
        or executive_visuals.has_project_role(j.project_id, (select auth.uid()))
      )
  )
);

alter policy ev_consents_read on executive_visuals.consents
using (
  consents.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(consents.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(consents.project_id, (select auth.uid()))
);

alter policy ev_reviews_read on executive_visuals.reviews
using (
  reviews.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(reviews.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(reviews.project_id, (select auth.uid()))
);

alter policy ev_reviews_insert on executive_visuals.reviews
with check (
  reviews.owner_id = (select auth.uid())
  and (
    reviews.project_id is null
    or executive_visuals.is_project_owner(reviews.project_id, (select auth.uid()))
    or executive_visuals.has_project_role(reviews.project_id, (select auth.uid()), array['editor','reviewer']::text[])
  )
);

alter policy ev_reviews_update on executive_visuals.reviews
using (
  reviews.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(reviews.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(reviews.project_id, (select auth.uid()), array['editor','reviewer']::text[])
)
with check (
  reviews.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(reviews.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(reviews.project_id, (select auth.uid()), array['editor','reviewer']::text[])
);

alter policy ev_audit_read on executive_visuals.audit_events
using (
  audit_events.owner_id = (select auth.uid())
  or executive_visuals.is_project_owner(audit_events.project_id, (select auth.uid()))
  or executive_visuals.has_project_role(audit_events.project_id, (select auth.uid()))
);

alter policy ev_review_events_read on executive_visuals.review_events
using (
  exists (
    select 1 from executive_visuals.reviews r
    where r.id = review_events.review_id
      and (
        r.owner_id = (select auth.uid())
        or executive_visuals.is_project_owner(r.project_id, (select auth.uid()))
        or (
          (r.visibility = 'project' and executive_visuals.has_project_role(r.project_id, (select auth.uid())))
          or executive_visuals.has_project_role(r.project_id, (select auth.uid()), array['editor','reviewer']::text[])
        )
      )
  )
);

alter policy ev_video_budget_approval_owner_insert on executive_visuals.video_generation_budget_approvals
with check (
  video_generation_budget_approvals.owner_id = (select auth.uid())
  and (
    video_generation_budget_approvals.project_id is null
    or executive_visuals.is_project_owner(video_generation_budget_approvals.project_id, (select auth.uid()))
  )
);

alter policy ev_video_budget_policy_owner_all on executive_visuals.video_generation_budget_policies
using (
  video_generation_budget_policies.owner_id = (select auth.uid())
  and (
    video_generation_budget_policies.project_id is null
    or executive_visuals.is_project_owner(video_generation_budget_policies.project_id, (select auth.uid()))
  )
)
with check (
  video_generation_budget_policies.owner_id = (select auth.uid())
  and (
    video_generation_budget_policies.project_id is null
    or executive_visuals.is_project_owner(video_generation_budget_policies.project_id, (select auth.uid()))
  )
);

alter policy ev_storage_read on storage.objects
using (
  bucket_id = 'executive-visuals-media'
  and (
    (storage.foldername(objects.name))[1] = (select auth.uid())::text
    or executive_visuals.is_project_owner(((storage.foldername(objects.name))[1])::uuid, (select auth.uid()))
    or executive_visuals.has_project_role(((storage.foldername(objects.name))[1])::uuid, (select auth.uid()))
  )
);

alter policy ev_storage_insert on storage.objects
with check (
  bucket_id = 'executive-visuals-media'
  and (
    (storage.foldername(objects.name))[1] = (select auth.uid())::text
    or executive_visuals.is_project_owner(((storage.foldername(objects.name))[1])::uuid, (select auth.uid()))
    or executive_visuals.has_project_role(((storage.foldername(objects.name))[1])::uuid, (select auth.uid()), array['editor']::text[])
  )
);

alter policy ev_storage_update on storage.objects
using (
  bucket_id = 'executive-visuals-media'
  and (
    (storage.foldername(objects.name))[1] = (select auth.uid())::text
    or executive_visuals.is_project_owner(((storage.foldername(objects.name))[1])::uuid, (select auth.uid()))
    or executive_visuals.has_project_role(((storage.foldername(objects.name))[1])::uuid, (select auth.uid()), array['editor']::text[])
  )
)
with check (
  bucket_id = 'executive-visuals-media'
  and (
    (storage.foldername(objects.name))[1] = (select auth.uid())::text
    or executive_visuals.is_project_owner(((storage.foldername(objects.name))[1])::uuid, (select auth.uid()))
    or executive_visuals.has_project_role(((storage.foldername(objects.name))[1])::uuid, (select auth.uid()), array['editor']::text[])
  )
);

alter policy ev_storage_delete on storage.objects
using (
  bucket_id = 'executive-visuals-media'
  and (
    (storage.foldername(objects.name))[1] = (select auth.uid())::text
    or executive_visuals.is_project_owner(((storage.foldername(objects.name))[1])::uuid, (select auth.uid()))
    or executive_visuals.has_project_role(((storage.foldername(objects.name))[1])::uuid, (select auth.uid()), array['editor']::text[])
  )
);
