// SPDX-License-Identifier: Apache-2.0
//
// D1 port of src/storage/postgres/observations.ts. Search uses the FTS5 table
// observations_fts (migrations/0001_init.sql) in place of tsvector/GIN:
// bm25() replaces ts_rank, and user text goes through buildFtsMatchQuery so
// hostile input can never raise an FTS syntax error.

import { normalizePlatformSourceOrNull } from '../../../../src/shared/platform-source';
import { buildFtsMatchQuery } from './fts';
import type { JsonObject, JsonValue } from './utils';
import { assertProjectOwnership, assertSessionOwnership, canonicalJson, deterministicKey, newId, nowMs, parseJson, toJsonObject } from './utils';

export type ObservationSourceType = 'agent_event' | 'session_summary' | 'observation_reindex' | 'manual';

export interface Observation {
	id: string;
	projectId: string;
	teamId: string;
	serverSessionId: string | null;
	kind: string;
	content: string;
	generationKey: string | null;
	metadata: JsonObject;
	embedding: JsonValue | null;
	createdByJobId: string | null;
	createdAtEpoch: number;
	updatedAtEpoch: number;
}

export interface ObservationSource {
	id: string;
	observationId: string;
	agentEventId: string | null;
	generationJobId: string | null;
	sourceType: ObservationSourceType;
	sourceId: string;
	metadata: JsonObject;
	createdAtEpoch: number;
}

export interface CreateObservationInput {
	id?: string;
	projectId: string;
	teamId: string;
	serverSessionId?: string | null;
	kind?: string;
	content: string;
	generationKey?: string | null;
	metadata?: JsonObject;
	embedding?: JsonValue | null;
	createdByJobId?: string | null;
}

export interface AddObservationSourceInput {
	id?: string;
	observationId: string;
	projectId: string;
	teamId: string;
	sourceType: ObservationSourceType;
	sourceId: string;
	agentEventId?: string | null;
	generationJobId?: string | null;
	metadata?: JsonObject;
}

interface ObservationRow {
	seq: number;
	id: string;
	project_id: string;
	team_id: string;
	server_session_id: string | null;
	kind: string;
	content: string;
	generation_key: string | null;
	metadata: string;
	embedding: string | null;
	created_by_job_id: string | null;
	created_at: number;
	updated_at: number;
}

interface ObservationSourceRow {
	id: string;
	observation_id: string;
	agent_event_id: string | null;
	generation_job_id: string | null;
	source_type: ObservationSourceType;
	source_id: string;
	metadata: string;
	created_at: number;
}

// Platform predicate shared by search and listByProject. Mirrors the Postgres
// search: the observation's session is on that platform, or — for unlinked
// observations — one of its source events is.
const PLATFORM_PREDICATE = `(
	EXISTS (
		SELECT 1 FROM server_sessions s
		WHERE s.id = o.server_session_id AND s.project_id = o.project_id AND s.team_id = o.team_id
		  AND s.platform_source = ?PS
	)
	OR (
		o.server_session_id IS NULL
		AND EXISTS (
			SELECT 1 FROM observation_sources os
			INNER JOIN agent_events ae
			  ON ae.id = os.agent_event_id AND ae.project_id = o.project_id AND ae.team_id = o.team_id
			WHERE os.observation_id = o.id AND os.source_type = 'agent_event' AND ae.platform_source = ?PS
		)
	)
)`;

export class ObservationRepository {
	constructor(private readonly db: D1Database) {}

	/**
	 * Prepared create. With a generation_key, a retry of the same generated
	 * observation returns the existing row untouched (Postgres parity:
	 * ON CONFLICT … DO UPDATE SET updated_at = observations.updated_at).
	 * Ownership guards run inside the statement; zero rows ⇒ rejected.
	 */
	createStatement(input: CreateObservationInput): D1PreparedStatement {
		const now = nowMs();
		return this.db
			.prepare(
				`INSERT INTO observations (
				   id, project_id, team_id, server_session_id, kind, content,
				   generation_key, metadata, embedding, created_by_job_id, created_at, updated_at
				 )
				 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11
				 WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?2 AND team_id = ?3)
				   AND (?4 IS NULL OR EXISTS (SELECT 1 FROM server_sessions WHERE id = ?4 AND project_id = ?2 AND team_id = ?3))
				   AND (?10 IS NULL OR EXISTS (SELECT 1 FROM observation_generation_jobs WHERE id = ?10 AND project_id = ?2 AND team_id = ?3))
				 ON CONFLICT (team_id, project_id, generation_key) WHERE generation_key IS NOT NULL DO UPDATE SET
				   updated_at = observations.updated_at
				 RETURNING *`,
			)
			.bind(
				input.id ?? newId(),
				input.projectId,
				input.teamId,
				input.serverSessionId ?? null,
				input.kind ?? 'observation',
				input.content,
				input.generationKey ?? null,
				JSON.stringify(input.metadata ?? {}),
				input.embedding == null ? null : JSON.stringify(input.embedding),
				input.createdByJobId ?? null,
				now,
			);
	}

	async create(input: CreateObservationInput): Promise<Observation> {
		const row = await this.createStatement(input).first<ObservationRow>();
		if (!row) {
			await assertProjectOwnership(this.db, input.projectId, input.teamId);
			if (input.serverSessionId) {
				await assertSessionOwnership(this.db, input.serverSessionId, input.projectId, input.teamId);
			}
			throw new Error('generation_job_id must belong to project_id and team_id');
		}
		return mapObservationRow(row);
	}

	async getByIdForScope(input: { id: string; projectId: string; teamId: string }): Promise<Observation | null> {
		const row = await this.db
			.prepare('SELECT * FROM observations WHERE id = ?1 AND project_id = ?2 AND team_id = ?3')
			.bind(input.id, input.projectId, input.teamId)
			.first<ObservationRow>();
		return row ? mapObservationRow(row) : null;
	}

	/** Newest first; served by idx_observations_team_project_created / idx_observations_session_created. */
	async listByProject(input: { projectId: string; teamId: string; serverSessionId?: string | null; limit?: number }): Promise<Observation[]> {
		const limit = input.limit ?? 100;
		const stmt = input.serverSessionId
			? this.db
					.prepare(
						'SELECT * FROM observations WHERE server_session_id = ?1 AND project_id = ?2 AND team_id = ?3 ORDER BY created_at DESC LIMIT ?4',
					)
					.bind(input.serverSessionId, input.projectId, input.teamId, limit)
			: this.db
					.prepare('SELECT * FROM observations WHERE team_id = ?1 AND project_id = ?2 ORDER BY created_at DESC LIMIT ?3')
					.bind(input.teamId, input.projectId, limit);
		const { results } = await stmt.all<ObservationRow>();
		return results.map(mapObservationRow);
	}

	/** Newest observation of one kind (e.g. the latest session summary); index-backed. */
	async latestByKind(input: { projectId: string; teamId: string; kind: string }): Promise<Observation | null> {
		const row = await this.db
			.prepare('SELECT * FROM observations WHERE team_id = ?1 AND project_id = ?2 AND kind = ?3 ORDER BY created_at DESC LIMIT 1')
			.bind(input.teamId, input.projectId, input.kind)
			.first<ObservationRow>();
		return row ? mapObservationRow(row) : null;
	}

	/**
	 * Full-text search, most relevant first (bm25 ascending = best), ties by
	 * updated_at DESC. Never throws on query syntax: text with no searchable
	 * token yields [].
	 */
	async search(input: { projectId: string; teamId: string; query: string; limit?: number; platformSource?: string | null }): Promise<Observation[]> {
		const match = buildFtsMatchQuery(input.query);
		if (!match) return [];
		const platformSource = normalizePlatformSourceOrNull(input.platformSource);
		const platformClause = platformSource ? `AND ${PLATFORM_PREDICATE.replaceAll('?PS', '?5')}` : '';
		const sql = `
			SELECT o.* FROM observations_fts
			INNER JOIN observations o ON o.seq = observations_fts.rowid
			WHERE observations_fts MATCH ?1
			  AND o.team_id = ?2 AND o.project_id = ?3
			  ${platformClause}
			ORDER BY bm25(observations_fts) ASC, o.updated_at DESC
			LIMIT ?4`;
		const binds: unknown[] = [match, input.teamId, input.projectId, input.limit ?? 20];
		if (platformSource) binds.push(platformSource);
		const { results } = await this.db
			.prepare(sql)
			.bind(...binds)
			.all<ObservationRow>();
		return results.map(mapObservationRow);
	}

	/** Scoped delete; observation_sources cascade and the FTS row is removed by trigger. */
	async deleteForScope(input: { id: string; teamId: string; projectId?: string | null }): Promise<boolean> {
		const stmt = input.projectId
			? this.db.prepare('DELETE FROM observations WHERE id = ?1 AND team_id = ?2 AND project_id = ?3').bind(input.id, input.teamId, input.projectId)
			: this.db.prepare('DELETE FROM observations WHERE id = ?1 AND team_id = ?2').bind(input.id, input.teamId);
		const result = await stmt.run();
		return (result.meta.changes ?? 0) > 0;
	}
}

export class ObservationSourcesRepository {
	constructor(private readonly db: D1Database) {}

	/**
	 * Link an observation to what produced it. Same validation rules as the
	 * Postgres repo, expressed as guards on one INSERT … SELECT (zero rows ⇒
	 * rejected, then diagnosed for the exact error). On conflict the metadata is
	 * merged into the existing link.
	 */
	async addSource(input: AddObservationSourceInput): Promise<ObservationSource> {
		const agentEventId = input.sourceType === 'agent_event' ? (input.agentEventId ?? input.sourceId) : null;
		if (input.sourceType === 'agent_event' && agentEventId !== input.sourceId) {
			throw new Error('agent_event source_id must equal agent_event_id');
		}
		if (input.sourceType === 'manual' && input.generationJobId) {
			throw new Error('manual observation sources cannot be linked to a generation_job_id');
		}
		const guards: string[] = ['EXISTS (SELECT 1 FROM observations WHERE id = ?2 AND project_id = ?8 AND team_id = ?9)'];
		if (input.sourceType === 'agent_event') {
			guards.push('EXISTS (SELECT 1 FROM agent_events WHERE id = ?6 AND project_id = ?8 AND team_id = ?9)');
		} else if (input.sourceType === 'session_summary' && !input.generationJobId) {
			guards.push('EXISTS (SELECT 1 FROM server_sessions WHERE id = ?6 AND project_id = ?8 AND team_id = ?9)');
		} else if (input.sourceType === 'observation_reindex' && !input.generationJobId) {
			guards.push('EXISTS (SELECT 1 FROM observations WHERE id = ?6 AND project_id = ?8 AND team_id = ?9)');
		}
		if (input.generationJobId) {
			guards.push(`EXISTS (
				SELECT 1 FROM observation_generation_jobs
				WHERE id = ?4 AND project_id = ?8 AND team_id = ?9 AND source_type = ?5 AND source_id = ?6
				  AND (?5 <> 'agent_event' OR agent_event_id = ?3)
			)`);
		}
		const row = await this.db
			.prepare(
				`INSERT INTO observation_sources (
				   id, observation_id, agent_event_id, generation_job_id, source_type, source_id, metadata, created_at
				 )
				 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?10
				 WHERE ${guards.join(' AND ')}
				 ON CONFLICT (observation_id, source_type, source_id) DO UPDATE SET
				   metadata = json_patch(observation_sources.metadata, excluded.metadata)
				 RETURNING *`,
			)
			.bind(
				input.id ?? newId(),
				input.observationId,
				agentEventId,
				input.generationJobId ?? null,
				input.sourceType,
				input.sourceId,
				JSON.stringify(input.metadata ?? {}),
				input.projectId,
				input.teamId,
				nowMs(),
			)
			.first<ObservationSourceRow>();
		if (!row) await this.explainRejectedSource(input);
		return mapObservationSourceRow(row!);
	}

	async listByObservationForScope(input: { observationId: string; projectId: string; teamId: string }): Promise<ObservationSource[]> {
		const { results } = await this.db
			.prepare(
				`SELECT os.* FROM observation_sources os
				 INNER JOIN observations o ON o.id = os.observation_id
				 WHERE os.observation_id = ?1 AND o.project_id = ?2 AND o.team_id = ?3
				 ORDER BY os.created_at ASC`,
			)
			.bind(input.observationId, input.projectId, input.teamId)
			.all<ObservationSourceRow>();
		return results.map(mapObservationSourceRow);
	}

	private async explainRejectedSource(input: AddObservationSourceInput): Promise<never> {
		const first = (sql: string, ...binds: unknown[]) => this.db.prepare(sql).bind(...binds).first();
		const scope = [input.projectId, input.teamId];
		if (!(await first('SELECT id FROM observations WHERE id = ?1 AND project_id = ?2 AND team_id = ?3', input.observationId, ...scope))) {
			throw new Error('observation_id does not exist');
		}
		if (input.sourceType === 'agent_event') {
			if (!(await first('SELECT id FROM agent_events WHERE id = ?1 AND project_id = ?2 AND team_id = ?3', input.sourceId, ...scope))) {
				throw new Error('agent_event_id must belong to project_id and team_id');
			}
		}
		if (input.generationJobId) {
			throw new Error('generation_job_id source model must match observation source');
		}
		if (input.sourceType === 'session_summary') {
			throw new Error('server_session_id must belong to project_id and team_id');
		}
		throw new Error('observation_reindex source_id must belong to project_id and team_id');
	}
}

/** Same key as the Postgres runtime (generation retries dedupe on it). */
export async function buildObservationGenerationKey(input: {
	generationJobId: string;
	parsedObservationIndex: number;
	content: string;
}): Promise<string> {
	return `generation:v1:${input.generationJobId}:${input.parsedObservationIndex}:${await deterministicKey([canonicalJson(input.content.trim())])}`;
}

export function mapObservationRow(row: ObservationRow): Observation {
	return {
		id: row.id,
		projectId: row.project_id,
		teamId: row.team_id,
		serverSessionId: row.server_session_id,
		kind: row.kind,
		content: row.content,
		generationKey: row.generation_key,
		metadata: toJsonObject(row.metadata),
		embedding: row.embedding == null ? null : parseJson(row.embedding),
		createdByJobId: row.created_by_job_id,
		createdAtEpoch: row.created_at,
		updatedAtEpoch: row.updated_at,
	};
}

function mapObservationSourceRow(row: ObservationSourceRow): ObservationSource {
	return {
		id: row.id,
		observationId: row.observation_id,
		agentEventId: row.agent_event_id,
		generationJobId: row.generation_job_id,
		sourceType: row.source_type,
		sourceId: row.source_id,
		metadata: toJsonObject(row.metadata),
		createdAtEpoch: row.created_at,
	};
}
