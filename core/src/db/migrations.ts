/** Append-only. Each entry is one schema version; never edit a shipped entry. */
export const migrations: string[] = [
  `
  CREATE TABLE agents (
    name TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    briefing TEXT NOT NULL DEFAULT '',
    harness TEXT NOT NULL DEFAULT 'claude-code',
    models TEXT NOT NULL DEFAULT '[]',          -- JSON array of LiteLLM model names
    budget_usd REAL NOT NULL DEFAULT 10,
    max_parallel INTEGER NOT NULL DEFAULT 1,
    guardrails TEXT NOT NULL DEFAULT '{}',      -- JSON: rate_per_hour, cooldown_seconds, hop_limit
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );

  CREATE TABLE briefing_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE ON UPDATE CASCADE,
    briefing TEXT NOT NULL,
    author TEXT NOT NULL,                        -- human | agent | job id
    created TEXT NOT NULL
  );

  CREATE TABLE triggers (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE ON UPDATE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('cron','inbox','manual','delay')),
    cron TEXT,
    next_fire TEXT,
    session_id TEXT,                             -- delay triggers resume this session
    created TEXT NOT NULL
  );

  CREATE TABLE projects (
    name TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    briefing TEXT NOT NULL DEFAULT '',
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );

  CREATE TABLE resources (
    name TEXT PRIMARY KEY,
    briefing TEXT NOT NULL DEFAULT '',
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );

  CREATE TABLE resource_keys (
    resource TEXT NOT NULL REFERENCES resources(name) ON DELETE CASCADE ON UPDATE CASCADE,
    name TEXT NOT NULL,
    secret INTEGER NOT NULL DEFAULT 1,
    has_value INTEGER NOT NULL DEFAULT 0,        -- the value itself lives only in Dopbase
    PRIMARY KEY (resource, name)
  );

  CREATE TABLE agent_projects (
    agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE ON UPDATE CASCADE,
    project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY (agent, project)
  );

  CREATE TABLE agent_resources (
    agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE ON UPDATE CASCADE,
    resource TEXT NOT NULL REFERENCES resources(name) ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY (agent, resource)
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE ON UPDATE CASCADE,
    harness_session_id TEXT,
    transcript_ref TEXT,
    summary TEXT,
    last_state TEXT,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE ON UPDATE CASCADE,
    session_id TEXT REFERENCES sessions(id),
    trigger_type TEXT NOT NULL,
    trigger_detail TEXT,
    status TEXT NOT NULL,                        -- queued running finished sleeping failed budget_exhausted stopped
    reason TEXT,
    model TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    resume_at TEXT,
    hop INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL,
    started TEXT,
    ended TEXT
  );
  CREATE INDEX jobs_agent ON jobs(agent, created);
  CREATE INDEX jobs_status ON jobs(status);

  CREATE TABLE job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                          -- text tool_use tool_result system cost stderr status
    data TEXT NOT NULL,                          -- JSON
    created TEXT NOT NULL
  );
  CREATE INDEX job_events_job ON job_events(job, id);

  CREATE TABLE job_tokens (
    token TEXT PRIMARY KEY,
    job TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    expires TEXT NOT NULL
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    from_addr TEXT NOT NULL,                     -- human | agent:<name>
    to_addr TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('question','instruction','info','reply')),
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}',          -- JSON: choices, steps, ...
    read INTEGER NOT NULL DEFAULT 0,
    reply_to TEXT REFERENCES messages(id),
    hop INTEGER NOT NULL DEFAULT 0,
    job TEXT,
    created TEXT NOT NULL
  );
  CREATE INDEX messages_to ON messages(to_addr, read, created);

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE ON UPDATE CASCADE,
    agent TEXT NOT NULL,
    job TEXT,
    kind TEXT NOT NULL,
    file_path TEXT NOT NULL,                     -- relative to the project's artifacts/ folder
    created TEXT NOT NULL
  );
  `,
  // 2: the harness pid, so a restarted core can kill an orphaned harness.
  `ALTER TABLE jobs ADD COLUMN pid INTEGER;`,
];
