import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, bootstrap, eventBody } from './helpers';

interface JobJson {
	id: string;
	status: string;
	[key: string]: unknown;
}

async function jobRow(id: string) {
	return env.DB.prepare('SELECT * FROM observation_generation_jobs WHERE id = ?1').bind(id).first<Record<string, unknown>>();
}

describe('POST /v1/sessions/start', () => {
	it('is idempotent on externalSessionId: 201 then 200 with the same session', async () => {
		const t = await bootstrap();
		const body = { projectId: t.projectId, externalSessionId: 'ext-1', contentSessionId: 'content-1', platformSource: 'claude-code' };
		const first = await api('POST', '/v1/sessions/start', t.apiKey, body);
		expect(first.status).toBe(201);
		const { session } = (await first.json()) as { session: Record<string, unknown> };
		expect(session).toMatchObject({ projectId: t.projectId, teamId: t.teamId, externalSessionId: 'ext-1', platformSource: 'claude', endedAtEpoch: null });
		expect(typeof session.startedAtEpoch).toBe('number');

		const again = await api('POST', '/v1/sessions/start', t.apiKey, body);
		expect(again.status).toBe(200);
		expect(((await again.json()) as { session: { id: string } }).session.id).toBe(session.id);

		// Another platform with the same external id is a distinct session.
		const other = await api('POST', '/v1/sessions/start', t.apiKey, { ...body, platformSource: 'cursor' });
		expect(other.status).toBe(201);
		expect(((await other.json()) as { session: { id: string } }).session.id).not.toBe(session.id);
	});

	it('400 on an invalid body', async () => {
		const t = await bootstrap();
		const res = await api('POST', '/v1/sessions/start', t.apiKey, { externalSessionId: 'x' });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: 'ValidationError' });
	});
});

describe('POST /v1/events', () => {
	it('stores the event and an outbox job whose payload matches the BullMQ contract', async () => {
		const t = await bootstrap();
		const res = await api('POST', '/v1/events', t.apiKey, eventBody(t.projectId, { platformSource: 'claude-code' }));
		expect(res.status).toBe(201);
		const body = (await res.json()) as { event: Record<string, unknown>; generationJob: JobJson };
		expect(body.event).toMatchObject({ projectId: t.projectId, sourceAdapter: 'hook', eventType: 'PostToolUse', platformSource: 'claude' });
		expect(body.event.payload).toEqual({ tool: 'Read', input: { file: 'a.ts' } });
		expect(body.generationJob).toMatchObject({ status: 'queued', sourceType: 'agent_event', sourceId: body.event.id, transport: 'enqueued' });
		expect(body.generationJob.bullmqJobId).toMatch(/^evt_[0-9a-f]{64}$/);

		const row = await jobRow(body.generationJob.id);
		expect(row).toMatchObject({ status: 'queued', job_type: 'observation_generate_for_event', agent_event_id: body.event.id, attempts: 0, max_attempts: 3 });
		expect(JSON.parse(row!.payload as string)).toEqual({
			kind: 'event',
			team_id: t.teamId,
			project_id: t.projectId,
			source_type: 'agent_event',
			source_id: body.event.id,
			generation_job_id: body.generationJob.id,
			agent_event_id: body.event.id,
			api_key_id: expect.any(String),
			actor_id: 'system:admin-bootstrap',
			source_adapter: 'hook',
			request_id: expect.any(String),
		});
	});

	it('is idempotent: a retried delivery returns the same event and job', async () => {
		const t = await bootstrap();
		const first = (await (await api('POST', '/v1/events', t.apiKey, eventBody(t.projectId))).json()) as { event: { id: string }; generationJob: JobJson };
		const second = (await (await api('POST', '/v1/events', t.apiKey, eventBody(t.projectId))).json()) as { event: { id: string }; generationJob: JobJson };
		expect(second.event.id).toBe(first.event.id);
		expect(second.generationJob.id).toBe(first.generationJob.id);
		const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM observation_generation_jobs WHERE project_id = ?1').bind(t.projectId).first<{ n: number }>();
		expect(count?.n).toBe(1);
		// The surviving job's payload still points at itself.
		expect(JSON.parse((await jobRow(first.generationJob.id))!.payload as string).generation_job_id).toBe(first.generationJob.id);
	});

	it('?generate=false records the event without a job; bad query flags are 400', async () => {
		const t = await bootstrap();
		const res = await api('POST', '/v1/events?generate=false', t.apiKey, eventBody(t.projectId));
		expect(res.status).toBe(201);
		expect(await res.json()).not.toHaveProperty('generationJob');
		expect((await api('POST', '/v1/events?generate=yes', t.apiKey, eventBody(t.projectId))).status).toBe(400);
	});

	it('links events to the session via contentSessionId', async () => {
		const t = await bootstrap();
		const session = (await (
			await api('POST', '/v1/sessions/start', t.apiKey, { projectId: t.projectId, contentSessionId: 'cs-1', platformSource: 'claude' })
		).json()) as { session: { id: string } };
		const res = await api('POST', '/v1/events', t.apiKey, eventBody(t.projectId, { contentSessionId: 'cs-1', platformSource: 'claude' }));
		const body = (await res.json()) as { event: { serverSessionId: string }; generationJob: JobJson };
		expect(body.event.serverSessionId).toBe(session.session.id);
		expect((await jobRow(body.generationJob.id))!.server_session_id).toBe(session.session.id);

		// A different platform does not link to that session.
		const cursor = await api('POST', '/v1/events', t.apiKey, eventBody(t.projectId, { contentSessionId: 'cs-1', platformSource: 'cursor' }));
		expect(((await cursor.json()) as { event: { serverSessionId: string | null } }).event.serverSessionId).toBeNull();
	});

	it('?wait=true returns the job status immediately once it is terminal', async () => {
		const t = await bootstrap();
		const first = (await (await api('POST', '/v1/events', t.apiKey, eventBody(t.projectId))).json()) as { generationJob: JobJson };
		await env.DB.prepare("UPDATE observation_generation_jobs SET status = 'completed', attempts = 1, completed_at = ?2 WHERE id = ?1")
			.bind(first.generationJob.id, Date.now())
			.run();
		const res = await api('POST', '/v1/events?wait=true', t.apiKey, eventBody(t.projectId));
		expect(res.status).toBe(201);
		const body = (await res.json()) as { generationJob: JobJson };
		expect(body.generationJob).toMatchObject({ id: first.generationJob.id, status: 'completed', attempts: 1, maxAttempts: 3 });
		expect(body).not.toHaveProperty('waitTimedOut');
	});
});

describe('POST /v1/events/batch', () => {
	it('ingests every event with its own job, in order', async () => {
		const t = await bootstrap();
		const events = [0, 1, 2].map((i) => eventBody(t.projectId, { occurredAtEpoch: 1_700_000_000_000 + i, sourceType: i === 2 ? 'api' : 'hook' }));
		const res = await api('POST', '/v1/events/batch', t.apiKey, events);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { events: { event: { id: string; occurredAtEpoch: number }; generationJob: JobJson }[] };
		expect(body.events.map((e) => e.event.occurredAtEpoch)).toEqual([0, 1, 2].map((i) => 1_700_000_000_000 + i));
		expect(new Set(body.events.map((e) => e.generationJob.id)).size).toBe(3);
		const payload = JSON.parse((await jobRow(body.events[2]!.generationJob.id))!.payload as string);
		expect(payload.source_adapter).toBe('api');
	});

	it('rejects empty batches and a project-scoped key writing elsewhere', async () => {
		const t = await bootstrap();
		expect((await api('POST', '/v1/events/batch', t.apiKey, [])).status).toBe(400);
		const res = await api('POST', '/v1/events/batch', t.apiKey, [eventBody(t.projectId), eventBody('other-project')]);
		expect(res.status).toBe(403);
	});
});

describe('POST /v1/sessions/:id/end', () => {
	it('ends the session once and queues exactly one summary job', async () => {
		const t = await bootstrap();
		const { session } = (await (await api('POST', '/v1/sessions/start', t.apiKey, { projectId: t.projectId, externalSessionId: 'end-me' })).json()) as {
			session: { id: string };
		};
		const first = await api('POST', `/v1/sessions/${session.id}/end`, t.apiKey, {});
		expect(first.status).toBe(200);
		const a = (await first.json()) as { session: { endedAtEpoch: number }; generationJob: JobJson };
		expect(a.session.endedAtEpoch).toEqual(expect.any(Number));
		expect(a.generationJob).toMatchObject({ status: 'queued', sourceType: 'session_summary', sourceId: session.id });
		expect(a.generationJob.bullmqJobId).toMatch(/^sum_[0-9a-f]{64}$/);
		expect(JSON.parse((await jobRow(a.generationJob.id))!.payload as string)).toMatchObject({
			kind: 'summary',
			source_type: 'session_summary',
			server_session_id: session.id,
			generation_job_id: a.generationJob.id,
			source_adapter: 'api',
		});

		const b = (await (await api('POST', `/v1/sessions/${session.id}/end`, t.apiKey, {})).json()) as { session: { endedAtEpoch: number }; generationJob: JobJson };
		expect(b.session.endedAtEpoch).toBe(a.session.endedAtEpoch);
		expect(b.generationJob.id).toBe(a.generationJob.id);
	});

	it('404 for an unknown or foreign session', async () => {
		const a = await bootstrap();
		const b = await bootstrap();
		const { session } = (await (await api('POST', '/v1/sessions/start', b.apiKey, { projectId: b.projectId, externalSessionId: 'theirs' })).json()) as {
			session: { id: string };
		};
		expect((await api('POST', '/v1/sessions/nope/end', a.apiKey, {})).status).toBe(404);
		expect((await api('POST', `/v1/sessions/${session.id}/end`, a.apiKey, {})).status).toBe(404);
	});
});

describe('GET /v1/jobs/:id', () => {
	it('returns the scoped job status and hides other tenants', async () => {
		const a = await bootstrap();
		const b = await bootstrap();
		const created = (await (await api('POST', '/v1/events', a.apiKey, eventBody(a.projectId))).json()) as { generationJob: JobJson };
		const res = await api('GET', `/v1/jobs/${created.generationJob.id}`, a.apiKey);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { generationJob: JobJson }).generationJob).toMatchObject({
			id: created.generationJob.id,
			projectId: a.projectId,
			teamId: a.teamId,
			jobType: 'observation_generate_for_event',
			status: 'queued',
			attempts: 0,
			lastError: null,
		});
		expect((await api('GET', `/v1/jobs/${created.generationJob.id}`, b.apiKey)).status).toBe(404);
		expect((await api('GET', '/v1/jobs/does-not-exist', a.apiKey)).status).toBe(404);
	});
});
