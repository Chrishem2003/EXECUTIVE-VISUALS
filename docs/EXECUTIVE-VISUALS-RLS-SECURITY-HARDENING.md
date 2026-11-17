# Executive Visuals tenant RLS hardening

## Root cause

The initial core migration used unqualified `project_id` references inside correlated subqueries against `executive_visuals.project_members m`. PostgreSQL resolved the unqualified identifier to the inner `m.project_id`, producing tautologies such as `m.project_id = m.project_id` instead of checking the target row's project.

The storage policies also used an unqualified `name` inside a subquery against `executive_visuals.projects p`. PostgreSQL resolved that identifier to `p.name`, not the target storage object's path. The correct reference is `objects.name`.

## Correction

Migration `20261117090000_fix_executive_visuals_project_rls_scope.sql` uses `ALTER POLICY` to qualify the outer row for workflows, workflow runs, timelines, assets, jobs and reviews. It also scopes all four private-storage policies to the first path segment of `storage.objects.name`.

The migration does not alter the public schema, NEMA tables, bucket visibility, bucket contents, or any production project. It only changes Executive Visuals policies and the existing private `executive-visuals-media` bucket's object policies.

## Required acceptance

1. Apply to the Executive Visuals staging project only.
2. Inspect `pg_policies` and verify there are no `m.project_id = m.project_id` expressions in the affected policies.
3. Verify storage policy project-owner checks reference `objects.name`.
4. Run authenticated cross-tenant tests: an editor in project A must not insert or update assets, jobs, timelines, workflows or reviews in project B.
5. Verify project A owners/editors retain permitted access; reviewers retain only review access; viewers remain read-only.
6. Verify user-owned objects remain scoped to the authenticated user and project paths remain scoped to the matching project.
7. Re-run tenant-isolation and private-media upload/download acceptance before enabling production cloud media.

Do not enable the cloud media API or provider workers until the staging acceptance above passes.

## Recursive-policy correction

A staging integration test found a second PostgreSQL issue: `projects` read policy queried `project_members`, while the membership read policy queried `projects`. Similar cross-table subqueries propagated through assets, jobs, timelines, workflows, reviews and storage policies, producing PostgreSQL's infinite-recursion error.

Migration `20261117093000_remove_executive_visuals_rls_policy_recursion.sql` introduces two narrowly-scoped `SECURITY DEFINER` boolean helpers. They read only the requested project ownership or current-user membership role with `row_security=off`, fixed `search_path`, and no caller-supplied user identity. All affected policies now call those helpers instead of querying the two mutually-dependent tables directly. Table privileges remain separate; this migration does not expose the Executive Visuals tables through PostgREST.
