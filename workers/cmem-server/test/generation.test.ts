// Observation generation: request-time (waitUntil) and cron paths, provider
// selection, retry/backoff/failure settlement, stale-lock recovery and the
// per-job D1 query budget. LLM calls hit the mocks in vitest.config.ts
// (mockOutbound), whose behaviour is selected by the model name.
//
// The shared test bindings carry no provider API key (so route tests see jobs
// stay `queued`); these tests hand the Worker an env WITH keys directly.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { REQUEST_TIME_MAX_BATCH, scheduleGeneration } from '../src/generation/enqueue';
import { MAX_QUERIES_PER_JOB, processClaimedJob, retryDelayMs } from '../src/generation/process';
import { buildProvider } from '../src/generation/providers';
import { CRON_BATCH_SIZE, runDueJobs } from '../src/generation/runner';
import { endSession, ingestEvents } from '../src/services/ingest';
import { ensureModeLoaded, ModeManager } from '../src/shims/mode-manager';
import { MODE_FILES } from '../src/shims/mode-registry';
import type { ObservationGenerationJob } from '../src/storage/generation-jobs';
import { GenerationJobsRepository, STALE_LOCK_MS } from '../src/storage/generation-jobs';
import { BASE, api, bootstrap, eventBody, type Tenant } from './helpers';

const KEYS = { ANTHROPIC_API_KEY: 'test-anthropic-key', GEMINI_API_KEY: 'test-gemini-key', OPENROUTER_API_KEY: 'test-openrouter-key' };

function genEnv(overrides: Partial<Env> = {}): Env {
	return { ...env, ...KEYS, CLAUDE_MEM_SERVER_PROVIDER: 'claude', CLAUDE_MEM_SERVER_MODEL: '', ...overrides } as Env;
}

const jobs = () => new GenerationJobsRepository(env.DB);

function newMarker(): string {
	return `marker-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Call the Worker's fetch handler with a custom env and wait for its waitUntil work. */
async function fetchWith(e: Env, method: string, path: string, key: string, body?: unknown): Promise<Response> {
	const ctx = createExecutionContext();
	const request = new Request(`${BASE}${path}`, {
		method,
		headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const res = await worker.fetch!(request as Parameters<NonNullable<typeof worker.fetch>>[0], e, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

/** Create an event + queued job WITHOUT scheduling it (the route would). */
async function queueEventJob(t: Tenant, opts: { marker?: string; apiKeyId?: string | null; serverSessionId?: string | null } = {}): Promise<ObservationGenerationJob> {
	const [result] = await ingestEvents(
		env.DB,
		[
			{
				projectId: t.projectId,
				teamId: t.teamId,
				serverSessionId: opts.serverSessionId ?? null,
				sourceAdapter: 'hook',
				eventType: 'PostToolUse',
				payload: { tool: 'Read', note: opts.marker ?? newMarker(), nonce: crypto.randomUUID() },
				occurredAt: Date.now(),
			},
		],
		{ generate: true, apiKeyId: opts.apiKeyId ?? null, actorId: 'test', sourceAdapter: null, requestId: null },
	);
	return result!.outbox!;
}

async function schedule(e: Env, jobId: string): Promise<void> {
	const ctx = createExecutionContext();
	scheduleGeneration(e, ctx, jobId);
	await waitOnExecutionContext(ctx);
}

async function runCron(e: Env) {
	const ctx = createExecutionContext();
	const outcomes = await runDueJobs(e, ctx);
	await waitOnExecutionContext(ctx);
	return outcomes;
}

async function observationsOf(jobId: string) {
	const { results } = await env.DB.prepare('SELECT * FROM observations WHERE created_by_job_id = ?1 ORDER BY generation_key')
		.bind(jobId)
		.all<{ id: string; kind: string; content: string; metadata: string; [column: string]: unknown }>();
	return results.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) as Record<string, unknown> }));
}

async function makeDue(jobId: string): Promise<void> {
	await env.DB.prepare('UPDATE observation_generation_jobs SET next_attempt_at = ?2 WHERE id = ?1').bind(jobId, Date.now() - 1).run();
}

/** Cancel everything runnable so each cron test only sees its own rows. */
async function drain(): Promise<void> {
	await env.DB.prepare("UPDATE observation_generation_jobs SET status = 'cancelled' WHERE status IN ('queued', 'processing')").run();
}

/** A D1Database wrapper that counts queries the way the Free-plan limit does (a batch counts each statement). */
function countingDb(db: D1Database): { db: D1Database; count: () => number } {
	let n = 0;
	const real = new WeakMap<object, D1PreparedStatement>();
	const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
		const wrapped = {
			bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
			first: (...args: [string?]) => (n++, stmt.first(...(args as []))),
			all: () => (n++, stmt.all()),
			run: () => (n++, stmt.run()),
			raw: (...args: unknown[]) => (n++, (stmt.raw as (...a: unknown[]) => unknown)(...args)),
		} as unknown as D1PreparedStatement;
		real.set(wrapped, stmt);
		return wrapped;
	};
	const counted = {
		prepare: (sql: string) => wrap(db.prepare(sql)),
		batch: (stmts: D1PreparedStatement[]) => {
			n += stmts.length;
			return db.batch(stmts.map((s) => real.get(s) ?? s));
		},
		exec: (sql: string) => (n++, db.exec(sql)),
	} as unknown as D1Database;
	return { db: counted, count: () => n };
}

describe('request-time generation (waitUntil)', () => {
	it('event → observation persisted, searchable, and in /v1/context/inject', async () => {
		const t = await bootstrap();
		const marker = newMarker();
		const res = await fetchWith(genEnv(), 'POST', '/v1/events', t.apiKey, eventBody(t.projectId, { payload: { tool: 'Read', note: marker } }));
		expect(res.status).toBe(201);
		const { generationJob } = (await res.json()) as { generationJob: { id: string } };

		const status = (await (await api('GET', `/v1/jobs/${generationJob.id}`, t.apiKey)).json()) as { generationJob: Record<string, unknown> };
		expect(status.generationJob).toMatchObject({ status: 'completed', attempts: 1, lastError: null });

		const [obs] = await observationsOf(generationJob.id);
		expect(obs).toMatchObject({ kind: 'discovery', project_id: t.projectId });
		expect(String(obs!.content)).toContain(marker);
		expect(obs!.metadata).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5', title: `Mock observation 0 ${marker}`, files_read: ['a.ts'] });
		const sources = await env.DB.prepare('SELECT * FROM observation_sources WHERE observation_id = ?1').bind(obs!.id).all<Record<string, unknown>>();
		expect(sources.results).toHaveLength(1);
		expect(sources.results[0]).toMatchObject({ source_type: 'agent_event', generation_job_id: generationJob.id });
		expect(JSON.parse(String(sources.results[0]!.metadata))).toMatchObject({ provider: 'claude', parsedObservationIndex: 0, source_adapter: 'hook' });

		const search = await api('POST', '/v1/search', t.apiKey, { projectId: t.projectId, query: marker.slice('marker-'.length) });
		const found = (await search.json()) as { observations: Array<{ id: string }> };
		expect(found.observations.map((o) => o.id)).toEqual([obs!.id]);

		const inject = await (await api('GET', `/v1/context/inject?projectId=${t.projectId}`, t.apiKey)).text();
		expect(inject).toContain('## Recent observations');
		expect(inject).toContain(`[discovery] Mock observation 0 ${marker}`);
	});

	it('?wait=true returns the completed job in the same request', async () => {
		const t = await bootstrap();
		const res = await fetchWith(genEnv(), 'POST', '/v1/events?wait=true', t.apiKey, eventBody(t.projectId));
		const body = (await res.json()) as { generationJob: { status: string } };
		expect(body.generationJob.status).toBe('completed');
	});

	it('session end → session summary persisted with kind summary', async () => {
		const t = await bootstrap();
		const marker = newMarker();
		const start = await api('POST', '/v1/sessions/start', t.apiKey, { projectId: t.projectId, externalSessionId: `ext-${marker}`, platformSource: 'claude-code' });
		const { session } = (await start.json()) as { session: { id: string } };
		// generate=false: the events stay "unprocessed" and feed the summary.
		for (const tool of ['Read', 'Edit']) {
			const ev = await api('POST', '/v1/events?generate=false', t.apiKey, eventBody(t.projectId, { serverSessionId: session.id, payload: { tool, note: marker } }));
			expect(ev.status).toBe(201);
		}
		const end = await fetchWith(genEnv(), 'POST', `/v1/sessions/${session.id}/end`, t.apiKey);
		expect(end.status).toBe(200);
		const { generationJob } = (await end.json()) as { generationJob: { id: string } };
		expect((await jobs().getById(generationJob.id))!.status).toBe('completed');

		const [summary] = await observationsOf(generationJob.id);
		expect(summary).toMatchObject({ kind: 'summary', server_session_id: session.id });
		expect(String(summary!.content)).toContain(`Request: Summarize session ${marker}`);
		expect(summary!.metadata).toMatchObject({ learned: `Summaries are persisted with kind summary (${marker})` });

		const inject = await (await api('GET', `/v1/context/inject?projectId=${t.projectId}`, t.apiKey)).text();
		expect(inject).toContain('## Last session');
		expect(inject).toContain(marker);
	});

	it('processes at most one job per invocation, and none for large batches', async () => {
		const t = await bootstrap();
		const small = await fetchWith(genEnv(), 'POST', '/v1/events/batch', t.apiKey, [eventBody(t.projectId, { occurredAtEpoch: 1 }), eventBody(t.projectId, { occurredAtEpoch: 2 })]);
		const smallJobs = ((await small.json()) as { events: Array<{ generationJob: { id: string } }> }).events.map((e) => e.generationJob.id);
		const statuses = await Promise.all(smallJobs.map(async (id) => (await jobs().getById(id))!.status));
		expect(statuses).toEqual(['completed', 'queued']);

		const big = Array.from({ length: REQUEST_TIME_MAX_BATCH + 1 }, (_, i) => eventBody(t.projectId, { occurredAtEpoch: 10 + i }));
		const bigRes = await fetchWith(genEnv(), 'POST', '/v1/events/batch', t.apiKey, big);
		const bigJobs = ((await bigRes.json()) as { events: Array<{ generationJob: { id: string } }> }).events.map((e) => e.generationJob.id);
		for (const id of bigJobs) expect((await jobs().getById(id))!.status).toBe('queued');
	});

	it('does nothing without an API key for the configured provider (jobs stay queued)', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		await schedule({ ...env, CLAUDE_MEM_SERVER_PROVIDER: 'gemini' } as Env, job.id);
		expect(await runCron({ ...env, CLAUDE_MEM_SERVER_PROVIDER: 'nope', ...KEYS } as Env)).toEqual([]);
		expect((await jobs().getById(job.id))!).toMatchObject({ status: 'queued', attempts: 0 });
	});

	it('does not claim a job whose retry is not yet due', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		await jobs().transition(job.id, ['queued'], 'queued', { nextAttemptAt: Date.now() + 60_000 });
		await schedule(genEnv(), job.id);
		expect((await jobs().getById(job.id))!).toMatchObject({ status: 'queued', attempts: 0 });
	});
});

describe('provider selection', () => {
	it.each([
		['claude', 'claude', 'claude-sonnet-5'],
		['anthropic', 'claude', 'claude-sonnet-5'],
		['gemini', 'gemini', 'gemini-flash-latest'],
		['openrouter', 'openrouter', 'anthropic/claude-3.5-sonnet'],
		['', 'claude', 'claude-sonnet-5'],
	])('CLAUDE_MEM_SERVER_PROVIDER=%j generates with %s', async (setting, label, model) => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		await schedule(genEnv({ CLAUDE_MEM_SERVER_PROVIDER: setting }), job.id);
		expect((await jobs().getById(job.id))!.status).toBe('completed');
		const [obs] = await observationsOf(job.id);
		expect(obs!.metadata).toMatchObject({ provider: label, model });
	});

	it('honours CLAUDE_MEM_SERVER_MODEL and rejects unknown providers', () => {
		expect(buildProvider(genEnv({ CLAUDE_MEM_SERVER_PROVIDER: 'gemini', CLAUDE_MEM_SERVER_MODEL: 'gemini-x' }))).toMatchObject({ providerLabel: 'gemini' });
		expect(buildProvider(genEnv({ CLAUDE_MEM_SERVER_PROVIDER: 'openai' }))).toBeNull();
		expect(buildProvider({ ...env, CLAUDE_MEM_SERVER_PROVIDER: 'claude' } as Env)).toBeNull();
	});
});

describe('failures, retries and the cron', () => {
	beforeEach(drain);

	it('transient failure → queued with 5s backoff, then succeeds via runDueJobs', async () => {
		const t = await bootstrap();
		const e = genEnv({ CLAUDE_MEM_SERVER_MODEL: 'mock-flaky' });
		const job = await queueEventJob(t);
		const before = Date.now();
		await schedule(e, job.id);
		const retry = (await jobs().getById(job.id))!;
		expect(retry).toMatchObject({ status: 'queued', attempts: 1, lockedBy: null, lastError: { classification: 'transient' } });
		expect(retry.nextAttemptAtEpoch! - before).toBeGreaterThanOrEqual(5_000);
		expect(retry.nextAttemptAtEpoch! - Date.now()).toBeLessThanOrEqual(5_000);

		// Not due yet: the cron leaves it alone.
		expect(await runCron(e)).toEqual([]);
		await makeDue(job.id);
		const outcomes = await runCron(e);
		expect(outcomes).toEqual([{ status: 'completed', jobId: job.id, observationCount: 1 }]);
		expect((await jobs().getById(job.id))!).toMatchObject({ status: 'completed', attempts: 2, lastError: null, nextAttemptAtEpoch: null });
		expect(await observationsOf(job.id)).toHaveLength(1);
	});

	it('rate limit (429) is retried with backoff', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		await schedule(genEnv({ CLAUDE_MEM_SERVER_MODEL: 'mock-429' }), job.id);
		expect((await jobs().getById(job.id))!).toMatchObject({ status: 'queued', attempts: 1, lastError: { classification: 'rate_limit' } });
	});

	it.each([
		['mock-400', 'unrecoverable'],
		['mock-garbage', 'parse_error'],
	])('permanent failure (%s) → failed immediately with lastError', async (model, classification) => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		await schedule(genEnv({ CLAUDE_MEM_SERVER_MODEL: model }), job.id);
		const failed = (await jobs().getById(job.id))!;
		expect(failed).toMatchObject({ status: 'failed', attempts: 1, lockedAtEpoch: null, lockedBy: null, lastError: { classification } });
		expect(failed.failedAtEpoch).not.toBeNull();
		expect(await observationsOf(job.id)).toEqual([]);
	});

	it('exhausts max_attempts: 5s then 10s backoff, then failed', async () => {
		const t = await bootstrap();
		const e = genEnv({ CLAUDE_MEM_SERVER_MODEL: 'mock-500' });
		const job = await queueEventJob(t);
		const delays: number[] = [];
		for (let attempt = 1; attempt <= 3; attempt++) {
			const t0 = Date.now();
			const [outcome] = await runCron(e);
			const row = (await jobs().getById(job.id))!;
			expect(row.attempts).toBe(attempt);
			if (attempt < 3) {
				expect(outcome).toMatchObject({ status: 'retry_scheduled', jobId: job.id });
				expect(row.status).toBe('queued');
				delays.push(Math.round((row.nextAttemptAtEpoch! - t0) / 1000));
				await makeDue(job.id);
			} else {
				expect(outcome).toMatchObject({ status: 'failed', classification: 'transient' });
				expect(row).toMatchObject({ status: 'failed', lastError: { classification: 'transient' } });
			}
		}
		expect(delays).toEqual([5, 10]);
		expect([1, 2, 3].map((a) => retryDelayMs(a))).toEqual([5_000, 10_000, 20_000]);
		expect(retryDelayMs(1, 30_000)).toBe(30_000);
	});

	it('reclaims a stale processing job (isolate died mid-flight) and completes it', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		// What a killed waitUntil leaves behind: processing, attempt charged, old lock.
		await jobs().transition(job.id, ['queued'], 'processing', { attempts: 1, lockedAt: Date.now() - STALE_LOCK_MS - 1, lockedBy: 'request:dead' });
		expect(await runCron(genEnv())).toEqual([{ status: 'completed', jobId: job.id, observationCount: 1 }]);
		expect((await jobs().getById(job.id))!).toMatchObject({ status: 'completed', attempts: 2 });
	});

	it('a live processing lock is not reclaimed', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		await jobs().transition(job.id, ['queued'], 'processing', { attempts: 1, lockedAt: Date.now() - 1_000, lockedBy: 'request:alive' });
		expect(await runCron(genEnv())).toEqual([]);
	});

	it('the scheduled() handler drains due jobs', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		const ctx = createExecutionContext();
		await worker.scheduled!(createScheduledController({ scheduledTime: new Date(), cron: '* * * * *' }), genEnv(), ctx);
		await waitOnExecutionContext(ctx);
		expect((await jobs().getById(job.id))!.status).toBe('completed');
	});

	it('claims at most CRON_BATCH_SIZE jobs per tick', async () => {
		const t = await bootstrap();
		for (let i = 0; i < CRON_BATCH_SIZE + 2; i++) await queueEventJob(t);
		expect(await runCron(genEnv())).toHaveLength(CRON_BATCH_SIZE);
		expect(await runCron(genEnv())).toHaveLength(2);
	});

	it('refuses to generate for a revoked or deleted API key', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t, { apiKeyId: 'deleted-key' });
		await schedule(genEnv(), job.id);
		expect((await jobs().getById(job.id))!).toMatchObject({ status: 'failed', lastError: { classification: 'revoked_key' } });
	});

	it('refuses a payload whose scope does not match the row', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		await jobs().transition(job.id, ['queued'], 'queued', { payload: { ...job.payload, team_id: 'other-team' } });
		await schedule(genEnv(), job.id);
		expect((await jobs().getById(job.id))!).toMatchObject({ status: 'failed', lastError: { classification: 'scope_mismatch' } });
	});

	it('a deadline abort on the request path defers to the cron without charging the attempt', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		const claimed = (await jobs().claimById(job.id, Date.now(), 'request:test'))!;
		const outcome = await processClaimedJob(genEnv(), claimed, { provider: buildProvider(genEnv())!, signal: AbortSignal.abort(), onAbort: 'defer' });
		expect(outcome).toEqual({ status: 'deferred', jobId: job.id });
		expect((await jobs().getById(job.id))!).toMatchObject({ status: 'queued', attempts: 0, nextAttemptAtEpoch: null });
	});

	it('a run that lost its job (reclaimed/cancelled mid-flight) writes nothing', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		const claimed = (await jobs().claimById(job.id, Date.now(), 'request:zombie'))!;
		await jobs().transition(job.id, ['processing'], 'cancelled', { cancelledAt: Date.now() });
		const outcome = await processClaimedJob(genEnv(), claimed, { provider: buildProvider(genEnv())! });
		expect(outcome).toEqual({ status: 'lost', jobId: job.id });
		expect(await observationsOf(job.id)).toEqual([]);
		expect((await jobs().getById(job.id))!.status).toBe('cancelled');
	});

	it('skip_summary completes the job with no observations', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		await schedule(genEnv({ CLAUDE_MEM_SERVER_MODEL: 'mock-skip' }), job.id);
		expect((await jobs().getById(job.id))!.status).toBe('completed');
		expect(await observationsOf(job.id)).toEqual([]);
	});

	it('session summary job via the service path (endSession) is picked up by the cron', async () => {
		const t = await bootstrap();
		const start = await api('POST', '/v1/sessions/start', t.apiKey, { projectId: t.projectId, externalSessionId: `svc-${newMarker()}` });
		const { session } = (await start.json()) as { session: { id: string } };
		await queueEventJob(t, { serverSessionId: session.id });
		await drain(); // leave the event job out; its event still feeds the summary
		const { outbox } = await endSession(env.DB, { sessionId: session.id, projectId: t.projectId, teamId: t.teamId, apiKeyId: null, actorId: null, sourceAdapter: 'api', requestId: null });
		const outcomes = await runCron(genEnv({ CLAUDE_MEM_MODE: 'code--ja' }));
		expect(outcomes).toEqual([{ status: 'completed', jobId: outbox!.id, observationCount: 1 }]);
		expect((await observationsOf(outbox!.id))[0]).toMatchObject({ kind: 'summary' });
	});
});

describe('persistence and D1 query budget', () => {
	beforeEach(drain);

	it('persists every observation with its source link; a re-run dedupes on generation_key', async () => {
		const t = await bootstrap();
		const e = genEnv({ CLAUDE_MEM_SERVER_MODEL: 'mock-multi' });
		const job = await queueEventJob(t);
		await schedule(e, job.id);
		const first = await observationsOf(job.id);
		expect(first).toHaveLength(3);
		const links = await env.DB.prepare('SELECT COUNT(*) AS n FROM observation_sources WHERE generation_job_id = ?1').bind(job.id).first<{ n: number }>();
		expect(links!.n).toBe(3);

		// Re-run the same job (e.g. a retry after a lost completion ack).
		await jobs().transition(job.id, ['completed'], 'processing', { lockedAt: Date.now(), lockedBy: 'again' });
		const again = (await jobs().getById(job.id))!;
		expect(await processClaimedJob(e, again, { provider: buildProvider(e)! })).toMatchObject({ status: 'completed', observationCount: 3 });
		expect((await observationsOf(job.id)).map((o) => o.id)).toEqual(first.map((o) => o.id));
		const relinks = await env.DB.prepare('SELECT COUNT(*) AS n FROM observation_sources WHERE generation_job_id = ?1').bind(job.id).first<{ n: number }>();
		expect(relinks!.n).toBe(3);
	});

	it('an event job costs ≤ 6 D1 queries including the claim; a cron tick stays far under 50', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		const counter = countingDb(env.DB);
		await schedule(genEnv({ DB: counter.db, CLAUDE_MEM_SERVER_MODEL: 'mock-multi' }), job.id);
		expect((await jobs().getById(job.id))!.status).toBe('completed');
		// claim + context row + source event + batch(complete, observations, sources)
		expect(counter.count()).toBe(6);
		expect(counter.count()).toBeLessThanOrEqual(MAX_QUERIES_PER_JOB);

		for (let i = 0; i < CRON_BATCH_SIZE; i++) await queueEventJob(t);
		const cron = countingDb(env.DB);
		expect(await runCron(genEnv({ DB: cron.db }))).toHaveLength(CRON_BATCH_SIZE);
		// failExhaustedStale + claimDue + 5 per job
		expect(cron.count()).toBe(2 + CRON_BATCH_SIZE * 5);
		expect(cron.count()).toBeLessThanOrEqual(2 + CRON_BATCH_SIZE * (MAX_QUERIES_PER_JOB - 1));
		expect(cron.count()).toBeLessThan(45);
	});

	it('a failed job costs ≤ 4 queries', async () => {
		const t = await bootstrap();
		const job = await queueEventJob(t);
		const counter = countingDb(env.DB);
		await schedule(genEnv({ DB: counter.db, CLAUDE_MEM_SERVER_MODEL: 'mock-500' }), job.id);
		expect((await jobs().getById(job.id))!.status).toBe('queued');
		// claim + context row + source event + retry transition
		expect(counter.count()).toBe(4);
	});
});

describe('ModeManager shim', () => {
	it('bundles every mode in plugin/modes/', () => {
		expect(Object.keys(MODE_FILES).sort()).toEqual([...env.TEST_MODE_IDS].sort());
	});

	it('mirrors parent--override inheritance and the fall-back-to-code rule', () => {
		const code = ensureModeLoaded('code');
		const ja = ensureModeLoaded('code--ja');
		expect(ja.observation_types).toEqual(code.observation_types);
		expect(ja.prompts).not.toEqual(code.prompts);
		expect(ModeManager.getInstance().getActiveModeId()).toBe('code--ja');
		expect(ensureModeLoaded('no-such-mode').name).toBe(code.name);
		expect(ensureModeLoaded('').name).toBe(code.name);
		// Loading must not mutate the bundled JSON.
		expect((MODE_FILES['code'] as { prompts: unknown }).prompts).toEqual(code.prompts);
	});

});
