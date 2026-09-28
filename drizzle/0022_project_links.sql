ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS demo_url TEXT;
ALTER TABLE projects ADD CONSTRAINT projects_repo_url_http_check CHECK (repo_url IS NULL OR repo_url ~* '^https?://');
ALTER TABLE projects ADD CONSTRAINT projects_demo_url_http_check CHECK (demo_url IS NULL OR demo_url ~* '^https?://');
