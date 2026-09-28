ALTER TABLE projects ADD COLUMN IF NOT EXISTS duplicate_of_project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS projects_duplicate_of_idx ON projects(duplicate_of_project_id);
