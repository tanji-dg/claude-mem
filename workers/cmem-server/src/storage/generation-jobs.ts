// SPDX-License-Identifier: Apache-2.0
//
// D1 port of src/storage/postgres/generation-jobs.ts: the observation
// generation outbox. On Cloudflare Free there is no BullMQ/Queues, so this
// table IS the queue:
//   - ingest creates a `queued` row and calls scheduleGeneration() (waitUntil);
//   - the 1/min cron calls claimDue() to pick up anything missed or retrying.
// All state changes are status-guarded single statements (UPDATE … WHERE
// status IN (…) RETURNING *), so concurrent claimers can never both win.
//
// Status vocabulary is identical to Postgres (it is wire-visible through
// GET /v1/jobs/:id). A scheduled retry is `queued` + a future next_attempt_at.

import type { JsonObject } from './utils';
import { deterministicKey, newId, nowMs, sha256Hex, toEpochOrNull, toJsonObject } from './utils';

export type ObservationGenerationJobSourceType = 'agent_event' | 'session_summary' | 'observation_reindex';
export type ObservationGenerationJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export const TERMINAL_JOB_STATUSES: readonly ObservationGenerationJobStatus[] = ['completed', 'failed', 'cancelled'];

/** A `processing` row whose lock is older than this is presumed abandoned (isolate died). */
export const STALE_LOCK_MS = 90_000;

export const EVENT_JOB_TYPE = 'observation_generate_for_event';
export const SUMMARY_JOB_TYPE = 'observation_generate_session_summary';

export interface ObservationGenerationJob {
	id: string;
	projectId: string;
	teamId: string;
	agentEventId: string | null;
	sourceType: ObservationGenerationJobSourceType;
	sourceId: string;
	serverSessionId: string | null;
	jobType: string;
	status: ObservationGenerationJobStatus;
	idempotencyKey: string;
	bullmqJobId: string | null;
	attempts: number;
	maxAttempts: number;
	nextAttemptAtEpoch: number | null;
	lockedAtEpoch: number | null;
	lockedBy: string | null;
	completedAtEpoch: number | null;
	failedAtEpoch: number | null;
	cancelledAtEpoch: number | null;
	lastError: JsonObject | null;
	payload: JsonObject;
	createdAtEpoch: number;
	updatedAtEpoch: number;
}

export interface CreateGenerationJobInput {
	id?: string;
	projectId: string;
	teamId: string;
	sourceType: ObservationGenerationJobSourceType;
	sourceId: string;
	agentEventId?: string | null;
	serverSessionId?: string | null;
	jobType: string;
	status?: ObservationGenerationJobStatus;
	bullmqJobId?: string | null;
	maxAttempts?: number;
	payload?: JsonObject;
}

/**
 * Column changes applied by `transition`. `undefined` leaves a column as is;
 * `null` clears it. `attempts: 'increment'` bumps the counter atomically.
 */
export interface JobTransitionPatch {
	attempts?: number | 'increment';
	nextAttemptAt?: number | null;
	lockedAt?: number | null;
	lockedBy?: string | null;
	completedAt?: number | null;
	failedAt?: number | null;
	cancelledAt?: number | null;
	lastError?: JsonObject | null;
	payload?: JsonObject;
}

export interface JobRow {
	id: string;
	project_id: string;
	team_id: string;
	agent_event_id: string | null;
	source_type: ObservationGenerationJobSourceType;
	source_id: string;
	server_session_id: string | null;
	job_type: string;
	status: ObservationGenerationJobStatus;
	idempotency_key: string;
	bullmq_job_id: string | null;
	attempts: number;
	max_attempts: number;
	next_attempt_at: number | null;
	locked_at: number | null;
	locked_by: string | null;
	completed_at: number | null;
	failed_at: number | null;
	cancelled_at: number | null;
	last_error: string | null;
	payload: string;
	created_at: number;
	updated_at: number;
}

export class GenerationJobsRepository {
	constructor(private readonly db: D1Database) {}

	/**
	 * Prepared idempotent create. The source-model guards of the Postgres
	 * `validateSource` run inside the INSERT … SELECT (zero rows ⇒ rejected);
	 * `create` re-checks to throw the Postgres error message. On conflict the
	 * existing row is returned unchanged except that payload.generation_job_id
	 * is re-pinned to the surviving row id (same fix as Postgres). Unlike
	 * Postgres' `payload || excluded.payload`, the new payload is NOT merged:
	 * SQLite's json_patch deletes keys whose new value is null, which would
	 * strip required-nullable fields such as api_key_id.
	 */
	async createStatement(input: CreateGenerationJobInput): Promise<D1PreparedStatement> {
		const model = normalizeSourceModel(input);
		const idempotencyKey = await buildObservationGenerationJobIdempotencyKey(input);
		const now = nowMs();
		const sourceGuard =
			input.sourceType === 'agent_event'
				? `EXISTS (SELECT 1 FROM agent_events e WHERE e.id = ?4 AND e.project_id = ?2 AND e.team_id = ?3
				     AND (?7 IS NULL OR e.server_session_id IS NULL OR e.server_session_id = ?7))
				   AND (?7 IS NULL OR EXISTS (SELECT 1 FROM server_sessions WHERE id = ?7 AND project_id = ?2 AND team_id = ?3))`
				: input.sourceType === 'session_summary'
					? 'EXISTS (SELECT 1 FROM server_sessions WHERE id = ?7 AND project_id = ?2 AND team_id = ?3)'
					: `EXISTS (SELECT 1 FROM observations WHERE id = ?6 AND project_id = ?2 AND team_id = ?3)
					   AND (?7 IS NULL OR EXISTS (SELECT 1 FROM server_sessions WHERE id = ?7 AND project_id = ?2 AND team_id = ?3))`;
		return this.db
			.prepare(
				`INSERT INTO observation_generation_jobs (
				   id, project_id, team_id, agent_event_id, source_type, source_id,
				   server_session_id, job_type, status, idempotency_key, bullmq_job_id,
				   max_attempts, payload, created_at, updated_at
				 )
				 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14
				 WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?2 AND team_id = ?3)
				   AND ${sourceGuard}
				 ON CONFLICT (idempotency_key) DO UPDATE SET
				   payload = json_set(observation_generation_jobs.payload, '$.generation_job_id', observation_generation_jobs.id),
				   updated_at = excluded.updated_at
				 RETURNING *`,
			)
			.bind(
				input.id ?? newId(),
				input.projectId,
				input.teamId,
				model.agentEventId,
				input.sourceType,
				input.sourceId,
				model.serverSessionId,
				input.jobType,
				input.status ?? 'queued',
				idempotencyKey,
				input.bullmqJobId ?? null,
				input.maxAttempts ?? 3,
				JSON.stringify(input.payload ?? {}),
				now,
			);
	}

	async create(input: CreateGenerationJobInput): Promise<ObservationGenerationJob> {
		assertSourceIdentity(input);
		const row = await (await this.createStatement(input)).first<JobRow>();
		if (!row) await this.explainRejectedCreate(input);
		return mapJobRow(row!);
	}

	async getById(id: string): Promise<ObservationGenerationJob | null> {
		const row = await this.db.prepare('SELECT * FROM observation_generation_jobs WHERE id = ?1').bind(id).first<JobRow>();
		return row ? mapJobRow(row) : null;
	}

	async getByIdForScope(input: { id: string; projectId: string; teamId: string }): Promise<ObservationGenerationJob | null> {
		const row = await this.db
			.prepare('SELECT * FROM observation_generation_jobs WHERE id = ?1 AND project_id = ?2 AND team_id = ?3')
			.bind(input.id, input.projectId, input.teamId)
			.first<JobRow>();
		return row ? mapJobRow(row) : null;
	}

	/**
	 * Status-guarded transition: applies `patch` and sets `status = toStatus`
	 * only if the row is currently in one of `fromStatuses`. Returns the updated
	 * job, or null when the guard did not match (someone else moved it, or the
	 * id does not exist). Callers decide what a lost race means.
	 */
	async transition(
		id: string,
		fromStatuses: readonly ObservationGenerationJobStatus[],
		toStatus: ObservationGenerationJobStatus,
		patch: JobTransitionPatch = {},
	): Promise<ObservationGenerationJob | null> {
		if (fromStatuses.length === 0) return null;
		const sets: string[] = ['status = ?', 'updated_at = ?'];
		const values: unknown[] = [toStatus, nowMs()];
		const assign = (column: string, value: unknown): void => {
			sets.push(`${column} = ?`);
			values.push(value);
		};
		if (patch.attempts === 'increment') sets.push('attempts = attempts + 1');
		else if (typeof patch.attempts === 'number') assign('attempts', patch.attempts);
		if (patch.nextAttemptAt !== undefined) assign('next_attempt_at', patch.nextAttemptAt);
		if (patch.lockedAt !== undefined) assign('locked_at', patch.lockedAt);
		if (patch.lockedBy !== undefined) assign('locked_by', patch.lockedBy);
		if (patch.completedAt !== undefined) assign('completed_at', patch.completedAt);
		if (patch.failedAt !== undefined) assign('failed_at', patch.failedAt);
		if (patch.cancelledAt !== undefined) assign('cancelled_at', patch.cancelledAt);
		if (patch.lastError !== undefined) assign('last_error', patch.lastError === null ? null : JSON.stringify(patch.lastError));
		if (patch.payload !== undefined) assign('payload', JSON.stringify(patch.payload));
		const placeholders = fromStatuses.map(() => '?').join(', ');
		const row = await this.db
			.prepare(`UPDATE observation_generation_jobs SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders}) RETURNING *`)
			.bind(...values, id, ...fromStatuses)
			.first<JobRow>();
		return row ? mapJobRow(row) : null;
	}

	/**
	 * Atomically claim up to `limit` runnable jobs, moving them to `processing`
	 * (attempts + 1, locked_at = now). Runnable means:
	 *   - `queued` with next_attempt_at NULL (fresh) or <= now (retry due), or
	 *   - `processing` whose lock is older than STALE_LOCK_MS (abandoned) and
	 *     that still has attempts left (see failExhaustedStale for the rest).
	 * Each branch is a range scan on idx_observation_jobs_status_next_attempt /
	 * idx_observation_jobs_status_locked, never a table scan. The outer WHERE
	 * repeats the guard so two concurrent claimers cannot take the same row.
	 */
	async claimDue(
		now: number,
		limit: number,
		options: { workerId?: string; staleLockMs?: number } = {},
	): Promise<ObservationGenerationJob[]> {
		if (limit <= 0) return [];
		const staleBefore = now - (options.staleLockMs ?? STALE_LOCK_MS);
		const { results } = await this.db
			.prepare(
				`UPDATE observation_generation_jobs
				 SET status = 'processing',
				     attempts = attempts + 1,
				     locked_at = ?1,
				     locked_by = ?2,
				     next_attempt_at = NULL,
				     updated_at = ?1
				 WHERE id IN (
				   SELECT id FROM (
				     SELECT id FROM observation_generation_jobs WHERE status = 'queued' AND next_attempt_at IS NULL
				     UNION ALL
				     SELECT id FROM observation_generation_jobs WHERE status = 'queued' AND next_attempt_at <= ?1
				     UNION ALL
				     SELECT id FROM observation_generation_jobs
				       WHERE status = 'processing' AND locked_at <= ?3 AND attempts < max_attempts
				   )
				   LIMIT ?4
				 )
				   AND attempts < max_attempts
				   AND (
				     (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1))
				     OR (status = 'processing' AND locked_at <= ?3)
				   )
				 RETURNING *`,
			)
			.bind(now, options.workerId ?? 'cron', staleBefore, limit)
			.all<JobRow>();
		return results.map(mapJobRow);
	}

	/**
	 * Stale `processing` rows that already used every attempt can never be
	 * claimed again; fail them so they stop being scanned and surface in
	 * GET /v1/jobs/:id. Returns the failed jobs (e.g. to mark their session).
	 */
	async failExhaustedStale(now: number, options: { staleLockMs?: number; limit?: number } = {}): Promise<ObservationGenerationJob[]> {
		const staleBefore = now - (options.staleLockMs ?? STALE_LOCK_MS);
		const { results } = await this.db
			.prepare(
				`UPDATE observation_generation_jobs
				 SET status = 'failed', failed_at = ?1, locked_at = NULL, locked_by = NULL, updated_at = ?1,
				     last_error = json_object('reason', 'stalled', 'message', 'processing lock expired after the final attempt')
				 WHERE id IN (
				   SELECT id FROM observation_generation_jobs
				   WHERE status = 'processing' AND locked_at <= ?2 AND attempts >= max_attempts
				   LIMIT ?3
				 )
				   AND status = 'processing'
				 RETURNING *`,
			)
			.bind(now, staleBefore, options.limit ?? 50)
			.all<JobRow>();
		return results.map(mapJobRow);
	}

	async listByStatusForScope(input: {
		status: ObservationGenerationJobStatus;
		projectId: string;
		teamId: string;
		limit?: number;
	}): Promise<ObservationGenerationJob[]> {
		const { results } = await this.db
			.prepare(
				`SELECT * FROM observation_generation_jobs
				 WHERE status = ?1 AND project_id = ?2 AND team_id = ?3
				 ORDER BY created_at ASC LIMIT ?4`,
			)
			.bind(input.status, input.projectId, input.teamId, input.limit ?? 100)
			.all<JobRow>();
		return results.map(mapJobRow);
	}

	private async explainRejectedCreate(input: CreateGenerationJobInput): Promise<never> {
		const scoped = (sql: string, ...binds: unknown[]) => this.db.prepare(sql).bind(...binds).first();
		if (!(await scoped('SELECT id FROM projects WHERE id = ?1 AND team_id = ?2', input.projectId, input.teamId))) {
			throw new Error('project_id must belong to team_id');
		}
		const model = normalizeSourceModel(input);
		if (model.serverSessionId) {
			const session = await scoped(
				'SELECT id FROM server_sessions WHERE id = ?1 AND project_id = ?2 AND team_id = ?3',
				model.serverSessionId,
				input.projectId,
				input.teamId,
			);
			if (!session) throw new Error('server_session_id must belong to project_id and team_id');
		}
		if (input.sourceType === 'agent_event') {
			const event = await scoped(
				'SELECT server_session_id FROM agent_events WHERE id = ?1 AND project_id = ?2 AND team_id = ?3',
				model.agentEventId,
				input.projectId,
				input.teamId,
			);
			if (!event) throw new Error('agent_event source_id must belong to project_id and team_id');
			throw new Error('server_session_id must match the agent_event server_session_id');
		}
		if (input.sourceType === 'observation_reindex') {
			throw new Error('observation_reindex source_id must belong to project_id and team_id');
		}
		throw new Error('observation generation job insert returned no row');
	}
}

function assertSourceIdentity(input: CreateGenerationJobInput): void {
	if (input.sourceType === 'agent_event' && (input.agentEventId ?? input.sourceId) !== input.sourceId) {
		throw new Error('agent_event source_id must belong to project_id and team_id');
	}
	if (input.sourceType === 'session_summary' && (input.serverSessionId ?? input.sourceId) !== input.sourceId) {
		throw new Error('session_summary source_id must equal server_session_id');
	}
}

function normalizeSourceModel(input: {
	sourceType: ObservationGenerationJobSourceType;
	sourceId: string;
	agentEventId?: string | null;
	serverSessionId?: string | null;
}): { agentEventId: string | null; serverSessionId: string | null } {
	if (input.sourceType === 'agent_event') {
		return { agentEventId: input.agentEventId ?? input.sourceId, serverSessionId: input.serverSessionId ?? null };
	}
	if (input.sourceType === 'session_summary') {
		return { agentEventId: null, serverSessionId: input.serverSessionId ?? input.sourceId };
	}
	return { agentEventId: null, serverSessionId: input.serverSessionId ?? null };
}

/** Same key derivation as the Postgres runtime. */
export async function buildObservationGenerationJobIdempotencyKey(input: {
	teamId: string;
	projectId: string;
	sourceType: ObservationGenerationJobSourceType;
	sourceId: string;
	jobType: string;
}): Promise<string> {
	return `observation_generation_job:v1:${await deterministicKey([input.teamId, input.projectId, input.sourceType, input.sourceId, input.jobType])}`;
}

/**
 * Port of src/server/jobs/job-id.ts buildServerJobId (that file imports Node's
 * `crypto`). There is no BullMQ here; the id is kept so `bullmqJobId` in API
 * responses stays identical to the Postgres runtime for the same source.
 */
export async function buildServerJobId(parts: {
	kind: 'event' | 'summary';
	team_id: string;
	project_id: string;
	source_type: string;
	source_id: string;
}): Promise<string> {
	const prefix = parts.kind === 'event' ? 'evt' : 'sum';
	const canonical = JSON.stringify({
		kind: parts.kind,
		team_id: parts.team_id,
		project_id: parts.project_id,
		source_type: parts.source_type,
		source_id: parts.source_id,
	});
	return `${prefix}_${await sha256Hex(canonical)}`;
}

export function mapJobRow(row: JobRow): ObservationGenerationJob {
	return {
		id: row.id,
		projectId: row.project_id,
		teamId: row.team_id,
		agentEventId: row.agent_event_id,
		sourceType: row.source_type,
		sourceId: row.source_id,
		serverSessionId: row.server_session_id,
		jobType: row.job_type,
		status: row.status,
		idempotencyKey: row.idempotency_key,
		bullmqJobId: row.bullmq_job_id,
		attempts: row.attempts,
		maxAttempts: row.max_attempts,
		nextAttemptAtEpoch: toEpochOrNull(row.next_attempt_at),
		lockedAtEpoch: toEpochOrNull(row.locked_at),
		lockedBy: row.locked_by,
		completedAtEpoch: toEpochOrNull(row.completed_at),
		failedAtEpoch: toEpochOrNull(row.failed_at),
		cancelledAtEpoch: toEpochOrNull(row.cancelled_at),
		lastError: row.last_error == null ? null : toJsonObject(row.last_error),
		payload: toJsonObject(row.payload),
		createdAtEpoch: row.created_at,
		updatedAtEpoch: row.updated_at,
	};
}
