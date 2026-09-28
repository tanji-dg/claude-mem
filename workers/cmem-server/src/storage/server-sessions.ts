// SPDX-License-Identifier: Apache-2.0
//
// D1 port of src/storage/postgres/server-sessions.ts. Same method names and
// return shapes. Postgres queries of the form `($flag = false OR col = $x)`
// are split into per-case SQL here so SQLite can use the partial indexes in
// migrations/0001_init.sql instead of scanning.

import { normalizePlatformSourceOrNull } from '../../../../src/shared/platform-source';
import type { AgentEvent, AgentEventRow } from './agent-events';
import { mapAgentEventRow } from './agent-events';
import type { JsonObject } from './utils';
import { assertProjectOwnership, deterministicKey, newId, nowMs, toEpochOrNull, toJsonObject } from './utils';

export interface ServerSession {
	id: string;
	projectId: string;
	teamId: string;
	externalSessionId: string | null;
	idempotencyKey: string | null;
	contentSessionId: string | null;
	agentId: string | null;
	agentType: string | null;
	platformSource: string | null;
	generationStatus: string;
	metadata: JsonObject;
	startedAtEpoch: number;
	endedAtEpoch: number | null;
	lastGeneratedAtEpoch: number | null;
	createdAtEpoch: number;
	updatedAtEpoch: number;
}

interface ServerSessionRow {
	id: string;
	project_id: string;
	team_id: string;
	external_session_id: string | null;
	idempotency_key: string | null;
	content_session_id: string | null;
	agent_id: string | null;
	agent_type: string | null;
	platform_source: string | null;
	generation_status: string;
	metadata: string;
	started_at: number;
	ended_at: number | null;
	last_generated_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface SessionScope {
	id: string;
	projectId: string;
	teamId: string;
}

export class ServerSessionsRepository {
	constructor(private readonly db: D1Database) {}

	async create(input: {
		id?: string;
		projectId: string;
		teamId: string;
		externalSessionId?: string | null;
		contentSessionId?: string | null;
		agentId?: string | null;
		agentType?: string | null;
		platformSource?: string | null;
		generationStatus?: string;
		metadata?: JsonObject;
	}): Promise<ServerSession> {
		await assertProjectOwnership(this.db, input.projectId, input.teamId);
		const platformSource = normalizePlatformSourceOrNull(input.platformSource);
		const idempotencyKey = await buildServerSessionIdempotencyKey({ ...input, platformSource });
		const now = nowMs();
		const row = await this.db
			.prepare(
				`INSERT INTO server_sessions (
				   id, project_id, team_id, external_session_id, idempotency_key, content_session_id,
				   agent_id, agent_type, platform_source, generation_status, metadata,
				   started_at, created_at, updated_at
				 )
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?12)
				 ON CONFLICT (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
				   external_session_id = excluded.external_session_id,
				   content_session_id = excluded.content_session_id,
				   agent_id = excluded.agent_id,
				   agent_type = excluded.agent_type,
				   platform_source = excluded.platform_source,
				   generation_status = excluded.generation_status,
				   metadata = excluded.metadata,
				   updated_at = excluded.updated_at
				 RETURNING *`,
			)
			.bind(
				input.id ?? newId(),
				input.projectId,
				input.teamId,
				input.externalSessionId ?? null,
				idempotencyKey,
				input.contentSessionId ?? null,
				input.agentId ?? null,
				input.agentType ?? null,
				platformSource,
				input.generationStatus ?? 'idle',
				JSON.stringify(input.metadata ?? {}),
				now,
			)
			.first<ServerSessionRow>();
		return mapServerSessionRow(row!);
	}

	async getByIdForScope(input: SessionScope): Promise<ServerSession | null> {
		const row = await this.db
			.prepare('SELECT * FROM server_sessions WHERE id = ?1 AND project_id = ?2 AND team_id = ?3')
			.bind(input.id, input.projectId, input.teamId)
			.first<ServerSessionRow>();
		return row ? mapServerSessionRow(row) : null;
	}

	async listByProject(projectId: string, teamId: string, limit = 100): Promise<ServerSession[]> {
		// Postgres returns every row; D1 bills rows read, so this is capped.
		const { results } = await this.db
			.prepare('SELECT * FROM server_sessions WHERE team_id = ?1 AND project_id = ?2 ORDER BY started_at DESC LIMIT ?3')
			.bind(teamId, projectId, limit)
			.all<ServerSessionRow>();
		return results.map(mapServerSessionRow);
	}

	async findByExternalIdForScope(input: {
		externalSessionId: string;
		projectId: string;
		teamId: string;
		platformSource?: string | null;
	}): Promise<ServerSession | null> {
		const hasPlatformScope = Object.prototype.hasOwnProperty.call(input, 'platformSource');
		const platformSource = hasPlatformScope ? normalizePlatformSourceOrNull(input.platformSource) : null;
		const base = 'SELECT * FROM server_sessions WHERE external_session_id = ?1 AND project_id = ?2 AND team_id = ?3';
		const stmt = !hasPlatformScope
			? this.db.prepare(`${base} ORDER BY started_at DESC LIMIT 1`).bind(input.externalSessionId, input.projectId, input.teamId)
			: platformSource === null
				? this.db
						.prepare(`${base} AND platform_source IS NULL ORDER BY started_at DESC LIMIT 1`)
						.bind(input.externalSessionId, input.projectId, input.teamId)
				: this.db
						.prepare(`${base} AND platform_source = ?4 ORDER BY started_at DESC LIMIT 1`)
						.bind(input.externalSessionId, input.projectId, input.teamId, platformSource);
		const row = await stmt.first<ServerSessionRow>();
		return row ? mapServerSessionRow(row) : null;
	}

	// Hot path of /v1/events ingest: resolve only the id for a content session.
	async findIdByContentSessionId(input: {
		contentSessionId: string;
		projectId: string;
		teamId: string;
		platformSource?: string | null;
	}): Promise<string | null> {
		const hasPlatformScope = Object.prototype.hasOwnProperty.call(input, 'platformSource');
		const platformSource = hasPlatformScope ? normalizePlatformSourceOrNull(input.platformSource) : null;
		const base = 'SELECT id FROM server_sessions WHERE team_id = ?1 AND project_id = ?2 AND content_session_id = ?3';
		const stmt = !hasPlatformScope
			? this.db.prepare(`${base} ORDER BY started_at DESC LIMIT 1`).bind(input.teamId, input.projectId, input.contentSessionId)
			: platformSource === null
				? this.db
						.prepare(`${base} AND platform_source IS NULL ORDER BY started_at DESC LIMIT 1`)
						.bind(input.teamId, input.projectId, input.contentSessionId)
				: this.db
						.prepare(`${base} AND platform_source = ?4 ORDER BY started_at DESC LIMIT 1`)
						.bind(input.teamId, input.projectId, input.contentSessionId, platformSource);
		const row = await stmt.first<{ id: string }>();
		return row ? row.id : null;
	}

	/** Idempotent: an already-ended session keeps its ended_at and updated_at. */
	async endSession(input: SessionScope): Promise<ServerSession | null> {
		const now = nowMs();
		const row = await this.db
			.prepare(
				`UPDATE server_sessions
				 SET ended_at = COALESCE(ended_at, ?4),
				     updated_at = CASE WHEN ended_at IS NULL THEN ?4 ELSE updated_at END
				 WHERE id = ?1 AND project_id = ?2 AND team_id = ?3
				 RETURNING *`,
			)
			.bind(input.id, input.projectId, input.teamId, now)
			.first<ServerSessionRow>();
		return row ? mapServerSessionRow(row) : null;
	}

	async markGenerationStarted(input: SessionScope): Promise<ServerSession | null> {
		return this.updateGenerationStatus(input, `generation_status = 'processing', updated_at = ?4`);
	}

	async markGenerationCompleted(input: SessionScope): Promise<ServerSession | null> {
		return this.updateGenerationStatus(input, `generation_status = 'completed', last_generated_at = ?4, updated_at = ?4`);
	}

	async markGenerationFailed(input: SessionScope & { error?: string | null }): Promise<ServerSession | null> {
		const row = await this.db
			.prepare(
				`UPDATE server_sessions
				 SET generation_status = 'failed',
				     metadata = json_set(COALESCE(metadata, '{}'), '$.lastGenerationError', ?5),
				     updated_at = ?4
				 WHERE id = ?1 AND project_id = ?2 AND team_id = ?3
				 RETURNING *`,
			)
			.bind(input.id, input.projectId, input.teamId, nowMs(), input.error ?? null)
			.first<ServerSessionRow>();
		return row ? mapServerSessionRow(row) : null;
	}

	/**
	 * Events of this session without a completed generation job (session
	 * summary input), oldest first. Served by idx_agent_events_session_occurred
	 * plus the idx_observation_jobs_event probe per event.
	 */
	async listUnprocessedEvents(input: {
		serverSessionId: string;
		projectId: string;
		teamId: string;
		limit?: number;
	}): Promise<AgentEvent[]> {
		const { results } = await this.db
			.prepare(
				`SELECT e.* FROM agent_events e
				 WHERE e.server_session_id = ?1 AND e.project_id = ?2 AND e.team_id = ?3
				   AND NOT EXISTS (
				     SELECT 1 FROM observation_generation_jobs j
				     WHERE j.agent_event_id = e.id
				       AND j.project_id = e.project_id
				       AND j.team_id = e.team_id
				       AND j.source_type = 'agent_event'
				       AND j.status = 'completed'
				   )
				 ORDER BY e.occurred_at ASC
				 LIMIT ?4`,
			)
			.bind(input.serverSessionId, input.projectId, input.teamId, input.limit ?? 500)
			.all<AgentEventRow>();
		return results.map(mapAgentEventRow);
	}

	private async updateGenerationStatus(input: SessionScope, setClause: string): Promise<ServerSession | null> {
		const row = await this.db
			.prepare(`UPDATE server_sessions SET ${setClause} WHERE id = ?1 AND project_id = ?2 AND team_id = ?3 RETURNING *`)
			.bind(input.id, input.projectId, input.teamId, nowMs())
			.first<ServerSessionRow>();
		return row ? mapServerSessionRow(row) : null;
	}
}

/** Same key derivation as the Postgres runtime (buildServerSessionIdempotencyKey). */
export async function buildServerSessionIdempotencyKey(input: {
	projectId: string;
	teamId: string;
	externalSessionId?: string | null;
	contentSessionId?: string | null;
	agentId?: string | null;
	agentType?: string | null;
	platformSource?: string | null;
}): Promise<string | null> {
	const platformSource = normalizePlatformSourceOrNull(input.platformSource);

	if (input.externalSessionId) {
		const parts: unknown[] = [input.teamId, input.projectId, 'external'];
		if (platformSource) parts.push(platformSource);
		parts.push(input.externalSessionId);
		return `server_session:v1:${await deterministicKey(parts)}`;
	}

	if (input.contentSessionId) {
		return `server_session:v1:${await deterministicKey([
			input.teamId,
			input.projectId,
			'content',
			platformSource,
			input.agentId ?? null,
			input.contentSessionId,
		])}`;
	}

	if (input.agentId && platformSource) {
		return `server_session:v1:${await deterministicKey([
			input.teamId,
			input.projectId,
			'agent',
			platformSource,
			input.agentId,
			input.agentType ?? null,
		])}`;
	}

	return null;
}

export function mapServerSessionRow(row: ServerSessionRow): ServerSession {
	return {
		id: row.id,
		projectId: row.project_id,
		teamId: row.team_id,
		externalSessionId: row.external_session_id,
		idempotencyKey: row.idempotency_key,
		contentSessionId: row.content_session_id,
		agentId: row.agent_id,
		agentType: row.agent_type,
		platformSource: row.platform_source,
		generationStatus: row.generation_status,
		metadata: toJsonObject(row.metadata),
		startedAtEpoch: row.started_at,
		endedAtEpoch: toEpochOrNull(row.ended_at),
		lastGeneratedAtEpoch: toEpochOrNull(row.last_generated_at),
		createdAtEpoch: row.created_at,
		updatedAtEpoch: row.updated_at,
	};
}
