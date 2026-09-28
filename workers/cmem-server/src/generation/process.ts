// SPDX-License-Identifier: Apache-2.0
//
// Process ONE claimed (`processing`) generation job end to end. Port of
// ProviderObservationGenerator.process (src/server/generation/
// ProviderObservationGenerator.ts) plus the persistence half of
// src/server/generation/processGeneratedResponse.ts, with the Postgres
// transaction rewritten as a single D1 batch.
//
// Reused unchanged from the repo: the provider classes, the job payload
// schema (assertServerGenerationJobPayload), parseAgentXml, stripTags, the
// error classification and the prompt builder's eventBlockBytes (summary input
// budget). The two small renderers are copied: processGeneratedResponse.ts
// does not export them and imports pg-bound repositories.
//
// D1 query budget (Free plan: 50 queries per invocation; a batch counts each
// statement). The claim is done by the caller (1 query). Then:
//   load        2  (context row: project name + session folder + key state;
//                   the source event(s))
//   persist     3  (one batch: complete job, insert observations, link sources;
//                   +1 per extra 15 observations)
//   or settle   1  (retry / fail / defer transition)
// ⇒ ≤ 6 queries per job including the claim for anything under 16
// observations, and never more than MAX_QUERIES_PER_JOB.
//
// Postgres differences, all deliberate:
//   - no audit_log rows (generation_job.processing / observation.created /
//     generation_job.completed) and no job-events log: each would cost a query
//     per job or per observation against the 50-query budget. Failures land in
//     observation_generation_jobs.last_error, visible via GET /v1/jobs/:id.
//   - no usage metering (CLAUDE_MEM_USAGE_METERING has no D1 table).
//   - retry backoff is 5s·2^(attempt-1) (5s, 10s, 20s …) instead of 5s·5^n; the
//     cron ticks once a minute, so a retry runs on the first tick after it.

import { parseAgentXml, type ParsedObservation, type ParsedSummary } from '@claude-mem/agent-xml-parser';
import type { GenerationAgentEvent, ServerGenerationProvider } from '@claude-mem/generation-types';
import { eventBlockBytes } from '@claude-mem/prompt-builder';
import { assertServerGenerationJobPayload, type ServerGenerationJobPayload } from '@claude-mem/server-job-types';
import { stripTags } from '@claude-mem/tag-stripping';
import { ServerClassifiedProviderError } from '../../../../src/server/generation/providers/shared/error-classification';
import { ensureModeLoaded } from '../shims/mode-manager';
import type { AgentEvent } from '../storage/agent-events';
import { AgentEventsRepository } from '../storage/agent-events';
import type { JobTransitionPatch, ObservationGenerationJob } from '../storage/generation-jobs';
import { GenerationJobsRepository } from '../storage/generation-jobs';
import { buildObservationGenerationKey } from '../storage/observations';
import { ServerSessionsRepository } from '../storage/server-sessions';
import type { JsonObject } from '../storage/utils';
import { newId, nowMs } from '../storage/utils';

/** Upper bound on D1 queries one job may issue, claim included (see header). */
export const MAX_QUERIES_PER_JOB = 8;

/** Rows per multi-row INSERT: D1 caps a statement at 100 bound parameters. */
const OBSERVATIONS_PER_STATEMENT = 15;

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 10 * 60 * 1000;

// Lower than the Node runtime's 600 KB: prompt building and parsing count
// against the Workers Free plan's 10 ms CPU budget per invocation.
const DEFAULT_SUMMARY_INPUT_BUDGET_BYTES = 120_000;

export type JobOutcome =
	| { status: 'completed'; jobId: string; observationCount: number }
	| { status: 'retry_scheduled'; jobId: string; nextAttemptAt: number; reason: string }
	| { status: 'failed'; jobId: string; reason: string; classification: string }
	/** Hit the caller's deadline (request-time path): handed back to the cron without using an attempt. */
	| { status: 'deferred'; jobId: string }
	/** The job left `processing` under us (reclaimed / failed elsewhere); nothing written. */
	| { status: 'lost'; jobId: string };

export interface ProcessJobOptions {
	provider: ServerGenerationProvider;
	/** Aborts the provider call. */
	signal?: AbortSignal;
	/**
	 * What an abort of `signal` means: 'defer' (request-time path — requeue
	 * without charging the attempt, the cron has a longer budget) or 'retry'
	 * (cron — a timeout counts as a transient failure).
	 */
	onAbort?: 'defer' | 'retry';
	now?: () => number;
}

interface RenderedObservation {
	kind: string;
	content: string;
	metadata: JsonObject;
}

interface JobContextRow {
	project_name: string | null;
	session_project: string | null;
	/** 1 revoked/expired, 0 active, null no such key. */
	key_revoked: number | null;
}

class JobFailure extends Error {
	constructor(
		readonly reason: string,
		readonly classification: string,
		readonly retryable: boolean,
		readonly retryAfterMs?: number,
	) {
		super(reason);
	}
}

/**
 * Run the provider for a job the caller has already claimed (status
 * `processing`, attempts already incremented) and settle it. Never throws:
 * every failure becomes a retry / failed / deferred transition.
 */
export async function processClaimedJob(env: Env, job: ObservationGenerationJob, options: ProcessJobOptions): Promise<JobOutcome> {
	const now = options.now ?? nowMs;
	try {
		const payload = validatePayload(job);
		const { events, context } = await loadJobInputs(env, job, payload, now());
		ensureModeLoaded(env.CLAUDE_MEM_MODE);

		let result;
		try {
			result = await options.provider.generate(
				{
					job,
					events,
					project: {
						projectId: job.projectId,
						teamId: job.teamId,
						serverSessionId: job.serverSessionId,
						projectName: context.project_name,
					},
				},
				options.signal,
			);
		} catch (error) {
			if (options.signal?.aborted && options.onAbort === 'defer') {
				return await defer(env, job);
			}
			throw error;
		}

		const rendered = job.sourceType === 'session_summary' ? renderSummaryResponse(result.rawText, job.id) : renderEventResponse(result.rawText, job.id);
		const count = await persist(env, job, payload, rendered, {
			provider: result.providerLabel,
			model: result.modelId ?? null,
			sessionProject: context.session_project,
			now: now(),
		});
		if (count === null) return { status: 'lost', jobId: job.id };
		log('INFO', 'generation completed', { jobId: job.id, sourceType: job.sourceType, attempt: job.attempts, observationCount: count, provider: result.providerLabel });
		return { status: 'completed', jobId: job.id, observationCount: count };
	} catch (error) {
		return await settleFailure(env, job, toJobFailure(error, options.signal), now());
	}
}

// ─── Steps ──────────────────────────────────────────────────────────────────

function validatePayload(job: ObservationGenerationJob): ServerGenerationJobPayload {
	let payload: ServerGenerationJobPayload;
	try {
		payload = assertServerGenerationJobPayload(job.payload);
	} catch (error) {
		throw new JobFailure(error instanceof Error ? error.message : String(error), 'invalid_payload', false);
	}
	// Anti-bypass guard (Postgres Phase 11): the payload is advisory, the row is
	// canonical. A mismatch means tampering or a bug; never generate.
	if (payload.team_id !== job.teamId || payload.project_id !== job.projectId) {
		throw new JobFailure(`payload team/project does not match outbox row (jobId=${job.id})`, 'scope_mismatch', false);
	}
	return payload;
}

async function loadJobInputs(
	env: Env,
	job: ObservationGenerationJob,
	payload: ServerGenerationJobPayload,
	now: number,
): Promise<{ events: GenerationAgentEvent[]; context: JobContextRow }> {
	// One row answers three Postgres queries: project name (loadProject), the
	// session's folder label (fetchSessionProject) and api-key revocation.
	const contextQuery = env.DB.prepare(
		`SELECT
		   (SELECT name FROM projects WHERE id = ?1 AND team_id = ?2) AS project_name,
		   (SELECT json_extract(metadata, '$.project') FROM server_sessions WHERE id = ?3) AS session_project,
		   (SELECT CASE WHEN revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?5) THEN 1 ELSE 0 END
		      FROM api_keys WHERE id = ?4) AS key_revoked`,
	)
		.bind(job.projectId, job.teamId, job.serverSessionId, payload.api_key_id, now)
		.first<JobContextRow>();

	const [context, events] = await Promise.all([contextQuery, loadEvents(env, job, payload)]);
	const row = context ?? { project_name: null, session_project: null, key_revoked: null };
	// A key that was revoked, expired or deleted between enqueue and run must
	// not generate (Postgres: isApiKeyRevoked; a deleted key counts as revoked).
	if (payload.api_key_id && row.key_revoked !== 0) {
		throw new JobFailure(`api key ${payload.api_key_id} is revoked; refusing to generate for outbox ${job.id}`, 'revoked_key', false);
	}
	return { events, context: row };
}

async function loadEvents(env: Env, job: ObservationGenerationJob, payload: ServerGenerationJobPayload): Promise<GenerationAgentEvent[]> {
	if (job.sourceType === 'session_summary') {
		if (!job.serverSessionId) return [];
		const events = await new ServerSessionsRepository(env.DB).listUnprocessedEvents({
			serverSessionId: job.serverSessionId,
			projectId: job.projectId,
			teamId: job.teamId,
		});
		return capSummaryInput(events, summaryBudget(env));
	}
	if (job.sourceType !== 'agent_event' || payload.kind !== 'event') return [];
	const event = await new AgentEventsRepository(env.DB).getByIdForScope({ id: payload.agent_event_id, projectId: job.projectId, teamId: job.teamId });
	return event ? [event] : [];
}

function summaryBudget(env: Env): number {
	return Number.parseInt(env.CLAUDE_MEM_SUMMARY_INPUT_BUDGET_BYTES ?? '', 10) || DEFAULT_SUMMARY_INPUT_BUDGET_BYTES;
}

/**
 * Port of capSummaryInput (ProviderObservationGenerator.ts): keep the head and
 * the tail of an over-budget session, measured with the prompt builder's own
 * eventBlockBytes so the budget matches what the prompt actually carries.
 */
export function capSummaryInput<T extends AgentEvent>(events: T[], budget: number): T[] {
	let total = 0;
	for (const e of events) total += eventBlockBytes(e);
	if (total <= budget) return events;

	const half = budget / 2;
	const head: T[] = [];
	let headBytes = 0;
	for (const e of events) {
		const s = eventBlockBytes(e);
		if (headBytes + s > half) break;
		head.push(e);
		headBytes += s;
	}
	const tail: T[] = [];
	let tailBytes = 0;
	for (let i = events.length - 1; i >= head.length; i -= 1) {
		const e = events[i]!;
		const s = eventBlockBytes(e);
		if (tailBytes + s > budget - headBytes) break;
		tail.unshift(e);
		tailBytes += s;
	}
	return [...head, ...tail];
}

// ─── Response rendering (processGeneratedResponse / processSessionSummaryResponse) ─

function renderEventResponse(rawText: string, jobId: string): RenderedObservation[] {
	const parsed = parseAgentXml(rawText, jobId);
	if (!parsed.valid) throw new JobFailure('parser rejected response', 'parse_error', false);
	// <skip_summary/> or zero observations is a success with nothing to record.
	return (parsed.observations ?? []).map((observation) => ({
		kind: observation.type ?? 'observation',
		content: renderObservationContent(observation),
		metadata: {
			title: observation.title,
			subtitle: observation.subtitle,
			facts: observation.facts,
			narrative: observation.narrative,
			concepts: observation.concepts,
			files_read: observation.files_read,
			files_modified: observation.files_modified,
		},
	}));
}

function renderSummaryResponse(rawText: string, jobId: string): RenderedObservation[] {
	const parsed = parseAgentXml(rawText, jobId);
	if (!parsed.valid) throw new JobFailure('parser rejected summary response', 'parse_error', false);
	const summary = parsed.summary ?? null;
	const skipped = summary?.skipped === true;
	// A summary job answered with <observation> blocks is folded into the
	// summary body instead of being dropped (same as Postgres).
	const fallbackObservations = !summary && !skipped ? parsed.observations : [];
	const content = summary ? renderSummaryContent(summary) : fallbackObservations.map((o) => renderObservationContent(o)).join('\n\n');
	if (skipped || content.trim().length === 0) return [];
	return [
		{
			kind: 'summary',
			content,
			metadata: {
				request: summary?.request ?? null,
				investigated: summary?.investigated ?? null,
				learned: summary?.learned ?? null,
				completed: summary?.completed ?? null,
				next_steps: summary?.next_steps ?? null,
				notes: summary?.notes ?? null,
			},
		},
	];
}

// Copied from processGeneratedResponse.ts (not exported there).
function renderSummaryContent(summary: ParsedSummary): string {
	const parts: string[] = [];
	if (summary.request) parts.push(`Request: ${summary.request}`);
	if (summary.investigated) parts.push(`Investigated: ${summary.investigated}`);
	if (summary.learned) parts.push(`Learned: ${summary.learned}`);
	if (summary.completed) parts.push(`Completed: ${summary.completed}`);
	if (summary.next_steps) parts.push(`Next steps: ${summary.next_steps}`);
	if (summary.notes) parts.push(`Notes: ${summary.notes}`);
	return parts.join('\n\n').trim();
}

// Copied from processGeneratedResponse.ts (not exported there).
function renderObservationContent(observation: ParsedObservation): string {
	const parts: string[] = [];
	if (observation.title) parts.push(observation.title);
	if (observation.subtitle) parts.push(observation.subtitle);
	if (observation.narrative) parts.push(observation.narrative);
	if (observation.facts && observation.facts.length > 0) {
		parts.push(observation.facts.map((f) => `- ${f}`).join('\n'));
	}
	if (parts.length === 0 && observation.concepts && observation.concepts.length > 0) {
		parts.push(`Concepts: ${observation.concepts.join(', ')}`);
	}
	return parts.join('\n\n').trim();
}

// ─── Persistence ────────────────────────────────────────────────────────────

/**
 * One db.batch() (an implicit transaction): complete the job first, then
 * insert the observations and their source links guarded on THAT completion
 * (status = completed AND completed_at = this run's timestamp). If the job
 * left `processing` under us (stale-lock reclaim, failExhaustedStale), the
 * completion matches nothing and the guarded inserts write nothing, so a
 * zombie run can never add rows to a job another run owns. Retries of the
 * same job dedupe on observations.generation_key, exactly like Postgres.
 *
 * Returns the number of observations written, or null if the job was lost.
 */
async function persist(
	env: Env,
	job: ObservationGenerationJob,
	payload: ServerGenerationJobPayload,
	rendered: RenderedObservation[],
	meta: { provider: string; model: string | null; sessionProject: string | null; now: number },
): Promise<number | null> {
	const rows: Array<{ id: string; sourceId: string; kind: string; content: string; generationKey: string; metadata: string; index: number }> = [];
	for (let index = 0; index < rendered.length; index++) {
		const { kind, content, metadata } = rendered[index]!;
		if (!content || content.trim().length === 0) continue;
		// Defense in depth: scrub private tags even if the parser let one through.
		const scrubbed = stripTags(content).stripped;
		if (!scrubbed || scrubbed.trim().length === 0) continue;
		rows.push({
			id: newId(),
			sourceId: newId(),
			kind,
			content: scrubbed,
			generationKey: await buildObservationGenerationKey({ generationJobId: job.id, parsedObservationIndex: index, content: scrubbed }),
			metadata: JSON.stringify({ ...metadata, project: meta.sessionProject, provider: meta.provider, model: meta.model }),
			index,
		});
	}

	const jobs = new GenerationJobsRepository(env.DB);
	const statements: D1PreparedStatement[] = [
		jobs.transitionStatement(job.id, ['processing'], 'completed', {
			completedAt: meta.now,
			lockedAt: null,
			lockedBy: null,
			nextAttemptAt: null,
			lastError: null,
		}),
	];
	for (let start = 0; start < rows.length; start += OBSERVATIONS_PER_STATEMENT) {
		const chunk = rows.slice(start, start + OBSERVATIONS_PER_STATEMENT);
		statements.push(insertObservationsStatement(env.DB, job, chunk, meta.now));
		statements.push(insertSourcesStatement(env.DB, job, payload, chunk, meta));
	}
	const results = await env.DB.batch(statements);
	if ((results[0]?.results.length ?? 0) === 0) {
		log('WARN', 'generation job left processing before completion; results discarded', { jobId: job.id });
		return null;
	}
	return rows.length;
}

// Shared guard: only write for the job completion this batch just made.
const COMPLETED_BY_THIS_RUN = `j.id = ?1 AND j.team_id = ?2 AND j.project_id = ?3 AND j.status = 'completed' AND j.completed_at = ?4`;

function insertObservationsStatement(
	db: D1Database,
	job: ObservationGenerationJob,
	chunk: Array<{ id: string; kind: string; content: string; generationKey: string; metadata: string }>,
	now: number,
): D1PreparedStatement {
	const SHARED = 4;
	const PER_ROW = 5;
	const values = chunk
		.map((_, i) => {
			const b = SHARED + i * PER_ROW;
			return `(?${b + 1}, ?${b + 2}, ?${b + 3}, ?${b + 4}, ?${b + 5})`;
		})
		.join(', ');
	const binds: unknown[] = [job.id, job.teamId, job.projectId, now];
	for (const row of chunk) binds.push(row.id, row.kind, row.content, row.generationKey, row.metadata);
	// server_session_id comes from the live job row (ON DELETE SET NULL safe).
	return db
		.prepare(
			`INSERT INTO observations (
			   id, project_id, team_id, server_session_id, kind, content,
			   generation_key, metadata, embedding, created_by_job_id, created_at, updated_at
			 )
			 SELECT v.column1, j.project_id, j.team_id, j.server_session_id, v.column2, v.column3,
			        v.column4, v.column5, NULL, j.id, ?4, ?4
			 FROM (VALUES ${values}) AS v
			 JOIN observation_generation_jobs j ON ${COMPLETED_BY_THIS_RUN}
			 WHERE true
			 ON CONFLICT (team_id, project_id, generation_key) WHERE generation_key IS NOT NULL DO UPDATE SET
			   updated_at = observations.updated_at`,
		)
		.bind(...binds);
}

function insertSourcesStatement(
	db: D1Database,
	job: ObservationGenerationJob,
	payload: ServerGenerationJobPayload,
	chunk: Array<{ sourceId: string; generationKey: string; index: number }>,
	meta: { provider: string; now: number },
): D1PreparedStatement {
	const SHARED = 8;
	const PER_ROW = 3;
	const values = chunk
		.map((_, i) => {
			const b = SHARED + i * PER_ROW;
			return `(?${b + 1}, ?${b + 2}, ?${b + 3})`;
		})
		.join(', ');
	const binds: unknown[] = [job.id, job.teamId, job.projectId, meta.now, meta.provider, payload.source_adapter ?? null, payload.actor_id ?? null, payload.api_key_id ?? null];
	for (const row of chunk) binds.push(row.sourceId, row.generationKey, row.index);
	// Metadata keys match processGeneratedResponse's addSource call.
	return db
		.prepare(
			`INSERT INTO observation_sources (
			   id, observation_id, agent_event_id, generation_job_id, source_type, source_id, metadata, created_at
			 )
			 SELECT v.column1, o.id, j.agent_event_id, j.id, j.source_type, j.source_id,
			        json_object('provider', ?5, 'parsedObservationIndex', v.column3,
			                    'source_adapter', ?6, 'actor_id', ?7, 'api_key_id', ?8),
			        ?4
			 FROM (VALUES ${values}) AS v
			 JOIN observation_generation_jobs j ON ${COMPLETED_BY_THIS_RUN}
			 JOIN observations o
			   ON o.team_id = j.team_id AND o.project_id = j.project_id
			  AND o.generation_key IS NOT NULL AND o.generation_key = v.column2
			 WHERE true
			 ON CONFLICT (observation_id, source_type, source_id) DO UPDATE SET
			   metadata = json_patch(observation_sources.metadata, excluded.metadata)`,
		)
		.bind(...binds);
}

// ─── Failure handling (markGenerationFailed) ────────────────────────────────

function toJobFailure(error: unknown, signal: AbortSignal | undefined): JobFailure {
	if (error instanceof JobFailure) return error;
	if (error instanceof ServerClassifiedProviderError) {
		const retryable = error.kind === 'transient' || error.kind === 'rate_limit';
		const reason = signal?.aborted ? `${error.message} (generation deadline exceeded)` : error.message;
		return new JobFailure(reason, String(error.kind), retryable, error.retryAfterMs);
	}
	// Unclassified (e.g. a D1 error while persisting): Postgres treats these as
	// non-retryable ('unknown'). A D1 hiccup is transient far more often than
	// not, so give it the same bounded retries as a provider 5xx.
	return new JobFailure(error instanceof Error ? error.message : String(error), 'unknown', true);
}

/** 5s, 10s, 20s, … (attempt is 1-based), capped; a longer Retry-After wins. */
export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
	const backoff = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
	return retryAfterMs !== undefined ? Math.min(Math.max(backoff, retryAfterMs), RETRY_MAX_MS) : backoff;
}

async function settleFailure(env: Env, job: ObservationGenerationJob, failure: JobFailure, now: number): Promise<JobOutcome> {
	const canRetry = failure.retryable && job.attempts < job.maxAttempts;
	const lastError = { reason: failure.reason, classification: failure.classification };
	const patch: JobTransitionPatch = { lockedAt: null, lockedBy: null, lastError };
	let nextAttemptAt = 0;
	if (canRetry) {
		nextAttemptAt = now + retryDelayMs(job.attempts, failure.retryAfterMs);
		patch.nextAttemptAt = nextAttemptAt;
	} else {
		patch.failedAt = now;
		patch.nextAttemptAt = null;
	}
	try {
		const moved = await new GenerationJobsRepository(env.DB).transition(job.id, ['processing'], canRetry ? 'queued' : 'failed', patch);
		if (!moved) return { status: 'lost', jobId: job.id };
	} catch (error) {
		// The row stays `processing`; claimDue reclaims it after STALE_LOCK_MS.
		log('ERROR', 'failed to record generation failure; the stale-lock sweep will retry it', {
			jobId: job.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	log(canRetry ? 'WARN' : 'ERROR', canRetry ? 'generation failed; retry scheduled' : 'generation failed', {
		jobId: job.id,
		attempt: job.attempts,
		maxAttempts: job.maxAttempts,
		...lastError,
	});
	return canRetry
		? { status: 'retry_scheduled', jobId: job.id, nextAttemptAt, reason: failure.reason }
		: { status: 'failed', jobId: job.id, reason: failure.reason, classification: failure.classification };
}

/** Hand the job back to the cron without charging the attempt the deadline cut short. */
async function defer(env: Env, job: ObservationGenerationJob): Promise<JobOutcome> {
	try {
		await new GenerationJobsRepository(env.DB).transition(job.id, ['processing'], 'queued', {
			attempts: Math.max(0, job.attempts - 1),
			lockedAt: null,
			lockedBy: null,
			nextAttemptAt: null,
		});
	} catch (error) {
		log('WARN', 'failed to defer generation job; the stale-lock sweep will pick it up', {
			jobId: job.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	log('INFO', 'generation deferred to cron (request-time deadline)', { jobId: job.id });
	return { status: 'deferred', jobId: job.id };
}

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, context: Record<string, unknown>): void {
	const line = JSON.stringify({ level, component: 'GENERATION', message, ...context });
	if (level === 'ERROR') console.error(line);
	else if (level === 'WARN') console.warn(line);
	else console.log(line);
}
