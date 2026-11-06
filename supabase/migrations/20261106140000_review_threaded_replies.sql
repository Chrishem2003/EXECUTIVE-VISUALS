-- Threaded replies inherit the parent review's visibility and authorization.
create table if not exists executive_visuals.review_replies (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 project_id uuid not null references executive_visuals.projects(id) on delete cascade,
 review_id uuid not null references executive_visuals.reviews(id) on delete cascade,
 author_id uuid not null references auth.users(id) on delete restrict,
 body text not null check (char_length(btrim(body)) between 1 and 5000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists ev_review_replies_thread_created on executive_visuals.review_replies(review_id,created_at,id);
alter table executive_visuals.review_replies enable row level security;
revoke all on executive_visuals.review_replies from public,anon,authenticated;
grant select,insert on executive_visuals.review_replies to service_role;
revoke update,delete on executive_visuals.review_replies from service_role;
