// SPDX-License-Identifier: Apache-2.0
//
// D1 port of src/storage/postgres/agent-events.ts. `create` is one
// INSERT … SELECT … WHERE EXISTS … ON CONFLICT … RETURNING statement: the
// project/session ownership guards and the idempotent upsert happen in a
// single round trip (D1 has no interactive transactions), and
// `createStatement` exposes it for db.batch() so a batch ingest is atomic.

import { normalizePlatformSourceOrNull } from '../../../../src/shared/platform-source';
import type { JsonObject, JsonValue } from './utils';
import { assertProjectOwnership, assertSessionOwnership, canonicalJson, deterministicKey, newId, nowMs, parseJson, toJsonObject } from './utils';

export interface AgentEvent {
	id: string;
	projectId: string;
	teamId: string;
	serverSessionId: string | null;
	sourceAdapter: string;
	sourceEventId: string | null;
	idempotencyKey: string;
	eventType: string;
	platformSource: string | null;
	payload: JsonValue;
	metadata: JsonObject;
	occurredAtEpoch: number;
	receivedAtEpoch: number;
	createdAtEpoch: number;
}

export interface CreateAgentEventInput {
	id?: string;
	projectId: string;
	teamId: string;
	serverSessionId?: string | null;
	contentSessionId?: string | null;
	sourceAdapter: string;
	sourceEventId?: string | null;
	eventType: string;
	platformSource?: string | null;
	payload?: JsonValue;
	metadata?: JsonObject;
	occurredAt: Date | string | number;
}

export interface AgentEventRow {
	id: string;
	project_id: string;
	team_id: string;
	server_session_id: string | null;
	source_adapter: string;
	source_event_id: string | null;
	idempotency_key: string;
	event_type: string;
	platform_source: string | null;
	payload: string;
	metadata: string;
	occurred_at: number;
	received_at: number;
	created_at: number;
}

export class AgentEventsRepository {
	constructor(private readonly db: D1Database) {}

	/**
	 * Prepared upsert. Returns zero rows (instead of inserting) when the project
	 * or session is outside (teamId, projectId); `create` turns that into the
	 * Postgres repo's ownership error. On idempotency-key conflict the existing
	 * row is returned with metadata merged, like `metadata || excluded.metadata`.
	 */
	async createStatement(input: CreateAgentEventInput): Promise<D1PreparedStatement> {
		const idempotencyKey = await buildAgentEventIdempotencyKey(input);
		const platformSource = normalizePlatformSourceOrNull(input.platformSource);
		const now = nowMs();
		return this.db
			.prepare(
				`INSERT INTO agent_events (
				   id, project_id, team_id, server_session_id, source_adapter, source_event_id,
				   idempotency_key, event_type, platform_source, payload, metadata,
				   occurred_at, received_at, created_at
				 )
				 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13
				 WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?2 AND team_id = ?3)
				   AND (?4 IS NULL OR EXISTS (
				     SELECT 1 FROM server_sessions WHERE id = ?4 AND project_id = ?2 AND team_id = ?3
				   ))
				 ON CONFLICT (idempotency_key) DO UPDATE SET
				   metadata = json_patch(agent_events.metadata, excluded.metadata),
				   platform_source = COALESCE(excluded.platform_source, agent_events.platform_source)
				 RETURNING *`,
			)
			.bind(
				input.id ?? newId(),
				input.projectId,
				input.teamId,
				input.serverSessionId ?? null,
				input.sourceAdapter,
				input.sourceEventId ?? null,
				idempotencyKey,
				input.eventType,
				platformSource,
				JSON.stringify(input.payload ?? {}),
				JSON.stringify(input.metadata ?? {}),
				new Date(input.occurredAt).getTime(),
				now,
			);
	}

	async create(input: CreateAgentEventInput): Promise<AgentEvent> {
		const row = await (await this.createStatement(input)).first<AgentEventRow>();
		if (!row) await this.explainRejectedInsert(input);
		return mapAgentEventRow(row!);
	}

	/**
	 * Multi-event insert as one D1 batch (one implicit transaction). A guard
	 * that fails inside a batch cannot abort it — the statement just inserts
	 * nothing — so every distinct project/session is validated up front to keep
	 * Postgres' all-or-nothing behavior for scope errors.
	 */
	async createMany(inputs: CreateAgentEventInput[]): Promise<AgentEvent[]> {
		if (inputs.length === 0) return [];
		const checked = new Set<string>();
		for (const input of inputs) {
			const projectKey = `p:${input.teamId}:${input.projectId}`;
			if (!checked.has(projectKey)) {
				await assertProjectOwnership(this.db, input.projectId, input.teamId);
				checked.add(projectKey);
			}
			const sessionKey = `s:${input.teamId}:${input.projectId}:${input.serverSessionId ?? ''}`;
			if (input.serverSessionId && !checked.has(sessionKey)) {
				await assertSessionOwnership(this.db, input.serverSessionId, input.projectId, input.teamId);
				checked.add(sessionKey);
			}
		}
		const statements = await Promise.all(inputs.map((input) => this.createStatement(input)));
		const results = await this.db.batch<AgentEventRow>(statements);
		const events: AgentEvent[] = [];
		for (let i = 0; i < results.length; i++) {
			const row = results[i]!.results[0];
			if (!row) await this.explainRejectedInsert(inputs[i]!);
			events.push(mapAgentEventRow(row!));
		}
		return events;
	}

	async getByIdForScope(input: { id: string; projectId: string; teamId: string }): Promise<AgentEvent | null> {
		const row = await this.db
			.prepare('SELECT * FROM agent_events WHERE id = ?1 AND project_id = ?2 AND team_id = ?3')
			.bind(input.id, input.projectId, input.teamId)
			.first<AgentEventRow>();
		return row ? mapAgentEventRow(row) : null;
	}

	async listByProject(input: { projectId: string; teamId: string; serverSessionId?: string | null; limit?: number }): Promise<AgentEvent[]> {
		const limit = input.limit ?? 100;
		const stmt = input.serverSessionId
			? this.db
					.prepare(
						'SELECT * FROM agent_events WHERE server_session_id = ?1 AND project_id = ?2 AND team_id = ?3 ORDER BY occurred_at DESC LIMIT ?4',
					)
					.bind(input.serverSessionId, input.projectId, input.teamId, limit)
			: this.db
					.prepare('SELECT * FROM agent_events WHERE team_id = ?1 AND project_id = ?2 ORDER BY occurred_at DESC LIMIT ?3')
					.bind(input.teamId, input.projectId, limit);
		const { results } = await stmt.all<AgentEventRow>();
		return results.map(mapAgentEventRow);
	}

	/** Re-run the guards one by one so the thrown message matches Postgres. */
	private async explainRejectedInsert(input: CreateAgentEventInput): Promise<never> {
		await assertProjectOwnership(this.db, input.projectId, input.teamId);
		if (input.serverSessionId) {
			await assertSessionOwnership(this.db, input.serverSessionId, input.projectId, input.teamId);
		}
		throw new Error('agent_event insert returned no row');
	}
}

/** Same key derivation as the Postgres runtime (buildAgentEventIdempotencyKey). */
export async function buildAgentEventIdempotencyKey(input: {
	teamId: string;
	projectId: string;
	sourceAdapter: string;
	sourceEventId?: string | null;
	serverSessionId?: string | null;
	contentSessionId?: string | null;
	eventType: string;
	platformSource?: string | null;
	occurredAt: Date | string | number;
	payload?: JsonValue;
}): Promise<string> {
	const platformSource = normalizePlatformSourceOrNull(input.platformSource);
	const platformScope = platformSource ? [platformSource] : [];

	if (input.sourceEventId) {
		return `agent_event:v1:${await deterministicKey([input.teamId, input.projectId, input.sourceAdapter, ...platformScope, input.sourceEventId])}`;
	}

	// contentSessionId is stable across retries; serverSessionId is resolved
	// lazily at ingest and may flip from NULL to set between deliveries.
	return `agent_event:v1:${await deterministicKey([
		input.teamId,
		input.projectId,
		input.sourceAdapter,
		...platformScope,
		input.contentSessionId ?? input.serverSessionId ?? null,
		input.eventType,
		new Date(input.occurredAt).toISOString(),
		canonicalJson(input.payload ?? {}),
	])}`;
}

export function mapAgentEventRow(row: AgentEventRow): AgentEvent {
	return {
		id: row.id,
		projectId: row.project_id,
		teamId: row.team_id,
		serverSessionId: row.server_session_id,
		sourceAdapter: row.source_adapter,
		sourceEventId: row.source_event_id,
		idempotencyKey: row.idempotency_key,
		eventType: row.event_type,
		platformSource: row.platform_source,
		payload: parseJson(row.payload),
		metadata: toJsonObject(row.metadata),
		occurredAtEpoch: row.occurred_at,
		receivedAtEpoch: row.received_at,
		createdAtEpoch: row.created_at,
	};
}
