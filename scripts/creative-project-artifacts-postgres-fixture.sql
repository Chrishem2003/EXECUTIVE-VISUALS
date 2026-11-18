-- Add only the missing Supabase project columns to the disposable CI harness.
ALTER TABLE executive_visuals.projects
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

INSERT INTO auth.users(id) VALUES
 ('123e4567-e89b-42d3-a456-426614174000'),
 ('223e4567-e89b-42d3-a456-426614174000'),
 ('323e4567-e89b-42d3-a456-426614174000'),
 ('323e4567-e89b-42d3-a456-426614174001')
ON CONFLICT(id) DO NOTHING;

INSERT INTO executive_visuals.projects(id,owner_id,name,description,settings,archived_at) VALUES
 ('423e4567-e89b-42d3-a456-426614174000','123e4567-e89b-42d3-a456-426614174000','Creative artifact integration','Disposable CI project','{}',NULL),
 ('423e4567-e89b-42d3-a456-426614174001','123e4567-e89b-42d3-a456-426614174000','Creative artifact concurrency','Disposable concurrent append project','{}',NULL)
ON CONFLICT(id) DO NOTHING;

INSERT INTO executive_visuals.project_members(project_id,member_id,role,invited_by) VALUES
 ('423e4567-e89b-42d3-a456-426614174000','223e4567-e89b-42d3-a456-426614174000','editor','123e4567-e89b-42d3-a456-426614174000'),
 ('423e4567-e89b-42d3-a456-426614174000','323e4567-e89b-42d3-a456-426614174000','reviewer','123e4567-e89b-42d3-a456-426614174000'),
 ('423e4567-e89b-42d3-a456-426614174000','323e4567-e89b-42d3-a456-426614174001','viewer','123e4567-e89b-42d3-a456-426614174000')
ON CONFLICT(project_id,member_id) DO NOTHING;
