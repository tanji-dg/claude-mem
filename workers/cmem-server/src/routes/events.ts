// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/events and POST /v1/events/batch — ports of the
// ServerV1PostgresRoutes handlers. Request bodies are validated with the
// shared zod schema from src/core/schemas/agent-event.ts.

import { z } from 'zod';
import { CreateAgentEventSchema } from '../../../../src/core/schemas/agent-event';
import { normalizePlatformSource, normalizePlatformSourceOrNull } from '../../../../src/shared/platform-source';
import { ensureProjectAllowed, ROUTE_SCOPES } from '../auth';
import { scheduleGeneration } from '../generation/enqueue';
import { dbErrorResponse, errorResponse, json, validationError } from '../http';
import type { RouteContext } from '../router';
import type { IngestResult } from '../services/ingest';
import { ingestEvents } from '../services/ingest';
import type { CreateAgentEventInput } from '../storage/agent-events';
import type { ObservationGenerationJob, JobRow } from '../storage/generation-jobs';
import { mapJobRow, TERMINAL_JOB_STATUSES } from '../storage/generation-jobs';
import { ServerSessionsRepository } from '../storage/server-sessions';
import type { Authorized } from './common';
import { authorize, parseBody, sessionLookupPlatformScope } from './common';
import type { EnqueueOutcome } from './serializers';
import { serializeEvent, serializeGenerationJob, serializeJobStatusResponse } from './serializers';

const SOURCE_ADAPTER_DEFAULT = 'api';

const EVENT_QUERY_SCHEMA = z.object({
	generate: z.union([z.literal('true'), z.literal('false')]).optional(),
	wait: z.union([z.literal('true'), z.literal('false')]).optional(),
});

/**
 * Worker-side batch cap (Express allows 500). The Free plan allows 50 D1
 * queries per invocation and a batch costs ~2 statements per event plus
 * session lookups, so larger batches would fail mid-request.
 */
export const MAX_BATCH_EVENTS = 20;

// `?wait=true` polls the job row until terminal. 25s keeps a margin under
// client timeouts; 1s ticks keep the poll within the per-invocation D1 query
// budget (the generator running in waitUntil shares that budget).
const WAIT_TIMEOUT_MS = 25_000;
const WAIT_POLL_INTERVAL_MS = 1_000;

type CreateAgentEvent = z.infer<typeof CreateAgentEventSchema>;

export async function postEvent(rc: RouteContext): Promise<Response> {
	const authz = await authorize(rc, ROUTE_SCOPES.eventsWrite);
	if (authz instanceof Response) return authz;
	const query = parseEventQuery(rc.url);
	if (query instanceof Response) return query;
	const parsed = await parseBody(rc, CreateAgentEventSchema);
	if (parsed instanceof Response) return parsed;
	const denied = ensureProjectAllowed(authz.auth, parsed.data.projectId);
	if (denied) return denied;

	const input = toAgentEventInput(parsed.data, authz.teamId);
	await applyContentSessionLinks(rc.env.DB, [input], [parsed.raw], authz.teamId);

	let result: IngestResult;
	try {
		[result] = (await ingestEvents(rc.env.DB, [input], ingestOptions(rc, authz, query.generate, input.sourceAdapter))) as [IngestResult];
	} catch (error) {
		return dbErrorResponse(error, 'event.write');
	}
	const transport = schedule(rc, result.outbox);

	if (query.wait) {
		let job = result.outbox;
		let timedOut = false;
		if (job) {
			const waited = await waitForTerminalJobs(rc.env.DB, [job]);
			job = waited.jobs[0] ?? job;
			timedOut = waited.timedOut;
		}
		return json(201, {
			event: serializeEvent(result.event),
			generationJob: job ? serializeJobStatusResponse(job, transport) : null,
			...(timedOut ? { waitTimedOut: true } : {}),
		});
	}
	return json(201, {
		event: serializeEvent(result.event),
		...(result.outbox ? { generationJob: serializeGenerationJob(result.outbox, transport) } : {}),
	});
}

export async function postEventsBatch(rc: RouteContext): Promise<Response> {
	const authz = await authorize(rc, ROUTE_SCOPES.eventsWrite);
	if (authz instanceof Response) return authz;
	const query = parseEventQuery(rc.url);
	if (query instanceof Response) return query;
	const parsed = await parseBody(rc, z.array(CreateAgentEventSchema).min(1).max(MAX_BATCH_EVENTS));
	if (parsed instanceof Response) return parsed;
	// Same pre-validation as Express: a project-scoped key may only write its project.
	if (authz.auth.projectId && parsed.data.some((e) => e.projectId !== authz.auth.projectId)) {
		return errorResponse(403, 'Forbidden', 'API key is scoped to a different project');
	}

	const inputs = parsed.data.map((item) => toAgentEventInput(item, authz.teamId));
	await applyContentSessionLinks(rc.env.DB, inputs, Array.isArray(parsed.raw) ? parsed.raw : parsed.data, authz.teamId);

	let results: IngestResult[];
	try {
		// sourceAdapter null: each job payload keeps its own event's adapter.
		results = await ingestEvents(rc.env.DB, inputs, ingestOptions(rc, authz, query.generate, null));
	} catch (error) {
		return dbErrorResponse(error, 'event.batch_write');
	}
	const transports = results.map((r) => schedule(rc, r.outbox));

	if (query.wait) {
		const pending = results.map((r) => r.outbox).filter((j): j is ObservationGenerationJob => j !== null);
		const waited = await waitForTerminalJobs(rc.env.DB, pending);
		const byId = new Map(waited.jobs.map((j) => [j.id, j]));
		const events = results.map(({ event, outbox }, index) => {
			const job = outbox ? (byId.get(outbox.id) ?? outbox) : null;
			const timedOut = job !== null && !TERMINAL_JOB_STATUSES.includes(job.status);
			return {
				event: serializeEvent(event),
				generationJob: job ? serializeJobStatusResponse(job, transports[index]!) : null,
				...(timedOut ? { waitTimedOut: true } : {}),
			};
		});
		return json(201, { events, ...(waited.timedOut ? { waitTimedOut: true } : {}) });
	}
	return json(201, {
		events: results.map(({ event, outbox }, index) => ({
			event: serializeEvent(event),
			...(outbox ? { generationJob: serializeGenerationJob(outbox, transports[index]!) } : {}),
		})),
	});
}

function parseEventQuery(url: URL): { generate: boolean; wait: boolean } | Response {
	const parsed = EVENT_QUERY_SCHEMA.safeParse(Object.fromEntries(url.searchParams));
	if (!parsed.success) return validationError(parsed.error.issues);
	return { generate: parsed.data.generate !== 'false', wait: parsed.data.wait === 'true' };
}

function ingestOptions(rc: RouteContext, authz: Authorized, generate: boolean, sourceAdapter: string | null) {
	return {
		generate,
		apiKeyId: authz.auth.apiKeyId,
		actorId: authz.auth.actorId,
		sourceAdapter,
		requestId: rc.requestId,
	};
}

/** Kick request-time generation for a freshly queued job. */
function schedule(rc: RouteContext, job: ObservationGenerationJob | null): EnqueueOutcome {
	if (!job) return 'skipped';
	if (job.status !== 'queued') return 'queued_only';
	scheduleGeneration(rc.env, rc.ctx, job.id);
	return 'enqueued';
}

// Mirrors ServerV1PostgresRoutes.toAgentEventInput. As there, sourceEventId and
// metadata are read from the zod-parsed body (which strips unknown keys), so
// idempotency keys match the Express runtime for identical requests.
function toAgentEventInput(body: CreateAgentEvent, teamId: string): CreateAgentEventInput {
	const record = body as Record<string, unknown>;
	return {
		projectId: body.projectId,
		teamId,
		serverSessionId: body.serverSessionId ?? null,
		contentSessionId: body.contentSessionId ?? null,
		sourceAdapter: body.sourceType ?? SOURCE_ADAPTER_DEFAULT,
		sourceEventId: typeof record.sourceEventId === 'string' ? record.sourceEventId : null,
		eventType: body.eventType,
		platformSource: normalizePlatformSourceOrNull(body.platformSource),
		payload: body.payload ?? {},
		metadata: typeof record.metadata === 'object' && record.metadata !== null ? (record.metadata as Record<string, unknown>) : {},
		occurredAt: new Date(typeof body.occurredAtEpoch === 'number' ? body.occurredAtEpoch : Date.now()),
	};
}

/**
 * Link events to their server_session via contentSessionId (#2634), with the
 * platform scope taken from the raw body. Best-effort like Express: a lookup
 * failure stores the event unlinked. Lookups are de-duplicated per request.
 */
async function applyContentSessionLinks(db: D1Database, inputs: CreateAgentEventInput[], rawBodies: unknown[], teamId: string): Promise<void> {
	const repo = new ServerSessionsRepository(db);
	const lookups = new Map<string, Promise<string | null>>();
	await Promise.all(
		inputs.map(async (input, index) => {
			if (input.serverSessionId || !input.contentSessionId) return;
			const platformScope = sessionLookupPlatformScope(rawBodies[index], normalizePlatformSource);
			const hasPlatformScope = Object.prototype.hasOwnProperty.call(platformScope, 'platformSource');
			const cacheKey = JSON.stringify([input.projectId, input.contentSessionId, hasPlatformScope, platformScope.platformSource ?? null]);
			let lookup = lookups.get(cacheKey);
			if (!lookup) {
				lookup = repo
					.findIdByContentSessionId({ contentSessionId: input.contentSessionId, projectId: input.projectId, teamId, ...platformScope })
					.catch((err: unknown) => {
						console.warn(JSON.stringify({ level: 'WARN', message: 'session linkage lookup failed; storing event unlinked', error: String(err) }));
						return null;
					});
				lookups.set(cacheKey, lookup);
			}
			const linkedId = await lookup;
			if (linkedId) input.serverSessionId = linkedId;
		}),
	);
}

/** Poll job rows (one query per tick for all ids) until terminal or timeout. */
async function waitForTerminalJobs(
	db: D1Database,
	jobs: ObservationGenerationJob[],
): Promise<{ jobs: ObservationGenerationJob[]; timedOut: boolean }> {
	let current = jobs;
	const isDone = () => current.every((j) => TERMINAL_JOB_STATUSES.includes(j.status));
	if (jobs.length === 0 || isDone()) return { jobs: current, timedOut: false };
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	const ids = jobs.map((j) => j.id);
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
		const { results } = await db
			.prepare(`SELECT * FROM observation_generation_jobs WHERE id IN (${ids.map(() => '?').join(', ')})`)
			.bind(...ids)
			.all<JobRow>();
		const byId = new Map(results.map((row) => [row.id, mapJobRow(row)]));
		current = current.map((j) => byId.get(j.id) ?? j);
		if (isDone()) return { jobs: current, timedOut: false };
	}
	return { jobs: current, timedOut: true };
}
