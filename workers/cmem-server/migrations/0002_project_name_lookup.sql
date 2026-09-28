-- SPDX-License-Identifier: Apache-2.0
--
-- POST /v1/projects/resolve finds a project by (team_id, name). Not UNIQUE:
-- existing databases may already hold same-named projects, and the resolver
-- stays race-free without it (one INSERT … WHERE NOT EXISTS statement, which
-- SQLite serializes) by always picking the oldest match.
CREATE INDEX IF NOT EXISTS idx_projects_team_name ON projects(team_id, name, created_at, id);
