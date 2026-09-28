-- SPDX-License-Identifier: Apache-2.0
--
-- claude-mem server runtime on Cloudflare D1 (SQLite).
--
-- Translated from the Postgres schema in src/storage/postgres/schema.ts
-- (PHASE_1_SCHEMA_SQL). Type mapping:
--   JSONB        -> TEXT holding a JSON document (parsed in each repo's mapRow)
--   TIMESTAMPTZ  -> INTEGER epoch milliseconds (written by the Worker, not now())
--
-- Tables that only serve the Postgres/BullMQ runtime (team_members,
-- observation_generation_job_events, usage_events, rate_limit_counters,
-- server_beta_schema_migrations) are intentionally left out.
--
-- Free-plan rule (lesson from sync-hub #4218): D1 bills rows READ, so every
-- query on a hot path must be served by an index. Each index below names the
-- query it backs.

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, team_id)
);
CREATE INDEX idx_projects_team ON projects(team_id, id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  revoked_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (project_id IS NULL OR team_id IS NOT NULL),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  actor_id TEXT,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  CHECK (project_id IS NULL OR team_id IS NOT NULL)
);
CREATE INDEX idx_audit_log_scope_created ON audit_log(project_id, team_id, created_at);

CREATE TABLE server_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  external_session_id TEXT,
  idempotency_key TEXT,
  content_session_id TEXT,
  agent_id TEXT,
  agent_type TEXT,
  platform_source TEXT,
  generation_status TEXT NOT NULL DEFAULT 'idle',
  metadata TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_generated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);
-- Upsert target for ServerSessionsRepository.create.
CREATE UNIQUE INDEX idx_server_sessions_project_idempotency
  ON server_sessions(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- findByExternalIdForScope (legacy rows without a platform).
CREATE UNIQUE INDEX idx_server_sessions_external_session_legacy
  ON server_sessions(project_id, external_session_id)
  WHERE external_session_id IS NOT NULL AND platform_source IS NULL;
-- findByExternalIdForScope (platform-scoped rows).
CREATE UNIQUE INDEX idx_server_sessions_external_session_platform
  ON server_sessions(project_id, platform_source, external_session_id)
  WHERE external_session_id IS NOT NULL AND platform_source IS NOT NULL;
-- findIdByContentSessionId: the /v1/events + /v1/memories linkage lookup.
CREATE INDEX idx_server_sessions_content_session
  ON server_sessions(team_id, project_id, content_session_id, platform_source, started_at DESC)
  WHERE content_session_id IS NOT NULL;
-- listByProject.
CREATE INDEX idx_server_sessions_project_started
  ON server_sessions(team_id, project_id, started_at DESC);

CREATE TABLE agent_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_session_id TEXT REFERENCES server_sessions(id) ON DELETE SET NULL,
  source_adapter TEXT NOT NULL,
  source_event_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  platform_source TEXT,
  payload TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (id, project_id, team_id),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);
-- listUnprocessedEvents / session-summary input (per session, oldest first).
CREATE INDEX idx_agent_events_session_occurred
  ON agent_events(server_session_id, occurred_at)
  WHERE server_session_id IS NOT NULL;
-- listByProject (newest first).
CREATE INDEX idx_agent_events_team_project
  ON agent_events(team_id, project_id, occurred_at DESC);

CREATE TABLE observation_generation_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_event_id TEXT REFERENCES agent_events(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('agent_event', 'session_summary', 'observation_reindex')),
  source_id TEXT NOT NULL,
  server_session_id TEXT REFERENCES server_sessions(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  -- Same status vocabulary as Postgres (wire-visible via GET /v1/jobs/:id).
  -- A scheduled retry is status='queued' with next_attempt_at in the future,
  -- exactly like transitionStatus(... 'queued', nextAttemptAt) on Postgres.
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  bullmq_job_id TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at INTEGER,
  locked_at INTEGER,
  locked_by TEXT,
  completed_at INTEGER,
  failed_at INTEGER,
  cancelled_at INTEGER,
  last_error TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (source_type = 'agent_event' AND agent_event_id IS NOT NULL AND source_id = agent_event_id)
    OR
    (source_type = 'session_summary' AND agent_event_id IS NULL AND server_session_id IS NOT NULL AND source_id = server_session_id)
    OR
    (source_type = 'observation_reindex' AND agent_event_id IS NULL)
  ),
  FOREIGN KEY (agent_event_id, project_id, team_id) REFERENCES agent_events(id, project_id, team_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_observation_jobs_source_scope
  ON observation_generation_jobs(team_id, project_id, source_type, source_id, job_type);
-- claimDue: queued rows whose next_attempt_at has passed.
CREATE INDEX idx_observation_jobs_status_next_attempt
  ON observation_generation_jobs(status, next_attempt_at);
-- claimDue: stale 'processing' rows (locked_at older than the lease).
CREATE INDEX idx_observation_jobs_status_locked
  ON observation_generation_jobs(status, locked_at);
-- listUnprocessedEvents NOT EXISTS probe + FK cascade from agent_events.
CREATE INDEX idx_observation_jobs_event ON observation_generation_jobs(agent_event_id);
CREATE INDEX idx_observation_jobs_session ON observation_generation_jobs(server_session_id);

CREATE TABLE observations (
  -- Stable integer rowid for the external-content FTS5 index. A TEXT primary
  -- key would leave SQLite's implicit rowid free to change on VACUUM, which
  -- would silently desynchronize observations_fts.
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_session_id TEXT REFERENCES server_sessions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'observation',
  content TEXT NOT NULL,
  generation_key TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  embedding TEXT,
  created_by_job_id TEXT REFERENCES observation_generation_jobs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);
-- Upsert target for ObservationRepository.create (generation retries).
CREATE UNIQUE INDEX idx_observations_generation_key_scope
  ON observations(team_id, project_id, generation_key)
  WHERE generation_key IS NOT NULL;
-- listByProject / context inject / MCP `recent` (newest first).
CREATE INDEX idx_observations_team_project_created
  ON observations(team_id, project_id, created_at DESC);
-- Latest session summary for context inject.
CREATE INDEX idx_observations_team_project_kind_created
  ON observations(team_id, project_id, kind, created_at DESC);
-- listByProject filtered by session + ON DELETE SET NULL from server_sessions.
CREATE INDEX idx_observations_session_created
  ON observations(server_session_id, created_at DESC);
CREATE INDEX idx_observations_created_by_job ON observations(created_by_job_id);

CREATE TABLE observation_sources (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  agent_event_id TEXT REFERENCES agent_events(id) ON DELETE CASCADE,
  generation_job_id TEXT REFERENCES observation_generation_jobs(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('agent_event', 'session_summary', 'observation_reindex', 'manual')),
  source_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (observation_id, source_type, source_id),
  UNIQUE (source_type, source_id, generation_job_id, observation_id),
  CHECK (
    (source_type = 'agent_event' AND agent_event_id IS NOT NULL AND source_id = agent_event_id)
    OR
    (source_type <> 'agent_event' AND agent_event_id IS NULL)
  )
);
CREATE INDEX idx_observation_sources_event ON observation_sources(agent_event_id);
CREATE INDEX idx_observation_sources_job ON observation_sources(generation_job_id);

-- Full-text search: external-content FTS5 over observations.content, keyed by
-- the stable observations.seq rowid (template: src/storage/sqlite/schema.ts).
-- porter+unicode61 approximates Postgres to_tsvector('english') stemming.
-- Deletes go through the FTS 'delete' command by rowid, so removing an
-- observation never scans the index.
CREATE VIRTUAL TABLE observations_fts USING fts5(
  content,
  content='observations',
  content_rowid='seq',
  tokenize='porter unicode61'
);

CREATE TRIGGER observations_fts_insert AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, content) VALUES (new.seq, new.content);
END;

CREATE TRIGGER observations_fts_delete AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES ('delete', old.seq, old.content);
END;

CREATE TRIGGER observations_fts_update AFTER UPDATE OF content ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES ('delete', old.seq, old.content);
  INSERT INTO observations_fts(rowid, content) VALUES (new.seq, new.content);
END;
