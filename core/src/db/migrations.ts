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
  // 3: resources of other kinds (Composio connections) besides plain keys.
  `ALTER TABLE resources ADD COLUMN kind TEXT NOT NULL DEFAULT 'keys';
   ALTER TABLE resources ADD COLUMN config TEXT NOT NULL DEFAULT '{}';`,
  // 4: optional folders that group agents in the sidebar. An agent in no folder has folder NULL.
  `CREATE TABLE agent_folders (name TEXT PRIMARY KEY, position INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
   ALTER TABLE agents ADD COLUMN folder TEXT;`,
  // 5: where each inbox message was posted in Slack, so answers and read state can update it.
  `CREATE TABLE slack_posts (message TEXT PRIMARY KEY, channel TEXT NOT NULL, ts TEXT NOT NULL, created TEXT NOT NULL);
   CREATE INDEX slack_posts_ts ON slack_posts(ts);`,
  // 6: the provider a job's token may reach through the bridge.
  `ALTER TABLE job_tokens ADD COLUMN provider TEXT;`,
  // 7: the WhatsApp messages each inbox message was posted as (actions: the one with its buttons), so answers and
  // reactions find their message.
  `CREATE TABLE whatsapp_posts (wamid TEXT PRIMARY KEY, message TEXT NOT NULL, actions INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
   CREATE INDEX whatsapp_posts_message ON whatsapp_posts(message);`,
  // 8: email through Resend. agents.email opts an agent in; email_threads are the conversations an agent has by email
  // (token is in the Reply-To address, so replies find their thread); emails ties each message to its email.
  `ALTER TABLE agents ADD COLUMN email INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE email_threads (token TEXT PRIMARY KEY, agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE ON UPDATE CASCADE, subject TEXT NOT NULL, created TEXT NOT NULL);
   CREATE TABLE emails (message TEXT PRIMARY KEY, thread TEXT NOT NULL REFERENCES email_threads(token) ON DELETE CASCADE, direction TEXT NOT NULL, addresses TEXT NOT NULL, resend_id TEXT, message_id TEXT, created TEXT NOT NULL);
   CREATE INDEX emails_thread ON emails(thread, created);
   CREATE INDEX emails_message_id ON emails(message_id);`,
  // 9: SMS through Twilio. agents.sms opts an agent in; sms ties each message to the phone it went to or came from,
  // so a text to the shared number finds the agent that last texted that phone.
  `ALTER TABLE agents ADD COLUMN sms INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE sms (message TEXT PRIMARY KEY, agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE ON UPDATE CASCADE, phone TEXT NOT NULL, direction TEXT NOT NULL, sid TEXT, created TEXT NOT NULL);
   CREATE INDEX sms_phone ON sms(phone, created);
   CREATE INDEX sms_agent ON sms(agent, created);
   CREATE UNIQUE INDEX sms_sid ON sms(sid) WHERE sid IS NOT NULL;`,
  // 10: the Telegram messages each inbox message was posted as (actions: the one with its buttons), so answers,
  // replies and reactions find their message.
  `CREATE TABLE telegram_posts (chat TEXT NOT NULL, tg_id INTEGER NOT NULL, message TEXT NOT NULL, actions INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, PRIMARY KEY (chat, tg_id));
   CREATE INDEX telegram_posts_message ON telegram_posts(message);`,
  // 11: inbound webhooks, a trigger type: each has an unguessable URL token and an optional signature check.
  // webhook_deliveries keeps each accepted delivery, for the hourly limit and for dropping repeats by the sender's id.
  `CREATE TABLE webhooks (id TEXT PRIMARY KEY, agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, verify TEXT NOT NULL DEFAULT 'none', secret TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', hourly_limit INTEGER NOT NULL DEFAULT 60, paused INTEGER NOT NULL DEFAULT 0, last_delivery TEXT, last_rejected TEXT, created TEXT NOT NULL, UNIQUE (agent, name));
   CREATE TABLE webhook_deliveries (id TEXT PRIMARY KEY, webhook TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, delivery TEXT, job TEXT, message TEXT, file TEXT NOT NULL, created TEXT NOT NULL);
   CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook, created);
   CREATE INDEX webhook_deliveries_job ON webhook_deliveries(job);
   CREATE UNIQUE INDEX webhook_deliveries_delivery ON webhook_deliveries(webhook, delivery) WHERE delivery IS NOT NULL;`,
  // 12: past jobs, searchable (yaho history). summary is the agent's own from yaho finish, recap a short one written
  // by a model when the job ended; job_search indexes both with what started the job and what the agent said.
  `ALTER TABLE jobs ADD COLUMN summary TEXT;
   ALTER TABLE jobs ADD COLUMN recap TEXT;
   CREATE VIRTUAL TABLE job_search USING fts5(job UNINDEXED, agent UNINDEXED, trigger, messages, summary, recap, tokenize = 'porter unicode61');
   CREATE TRIGGER jobs_search_delete AFTER DELETE ON jobs BEGIN DELETE FROM job_search WHERE job = old.id; END;`,
];
