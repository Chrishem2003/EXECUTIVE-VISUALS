create table if not exists executive_visuals.review_reactions (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 project_id uuid not null references executive_visuals.projects(id) on delete cascade,
 review_id uuid not null references executive_visuals.reviews(id) on delete cascade,
 actor_id uuid not null references auth.users(id) on delete restrict,
 emoji text not null check (emoji in ('👍','❤️','🎉','👀','✅','💯')),
 created_at timestamptz not null default now(),
 constraint ev_review_reactions_unique unique (review_id,actor_id,emoji)
);
create index if not exists ev_review_reactions_thread on executive_visuals.review_reactions(review_id,created_at,id);
alter table executive_visuals.review_reactions enable row level security;
revoke all on executive_visuals.review_reactions from public,anon,authenticated;
grant select,insert,delete on executive_visuals.review_reactions to service_role;
revoke update on executive_visuals.review_reactions from service_role;
