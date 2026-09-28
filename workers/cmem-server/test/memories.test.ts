import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildFtsMatchQuery } from '../src/storage/fts';
import { api, bootstrap } from './helpers';

interface ObservationJson {
	id: string;
	content: string;
	kind: string;
	metadata: Record<string, unknown>;
	serverSessionId: string | null;
}

async function addMemory(key: string, body: Record<string, unknown>): Promise<ObservationJson> {
	const res = await api('POST', '/v1/memories', key, body);
	expect(res.status).toBe(201);
	return ((await res.json()) as { memory: ObservationJson }).memory;
}

async function search(key: string, body: Record<string, unknown>, path = '/v1/search'): Promise<{ status: number; ids: string[]; body: Record<string, unknown> }> {
	const res = await api('POST', path, key, body);
	const json = (await res.json()) as { observations?: ObservationJson[] };
	return { status: res.status, ids: (json.observations ?? []).map((o) => o.id), body: json as Record<string, unknown> };
}

describe('POST /v1/memories', () => {
	it('stores a manual memory without creating a generation job', async () => {
		const t = await bootstrap();
		const memory = await addMemory(t.apiKey, { projectId: t.projectId, content: 'Use D1 batches, not transactions', metadata: { tag: 'd1' } });
		expect(memory).toMatchObject({ kind: 'manual', content: 'Use D1 batches, not transactions', metadata: { tag: 'd1' }, serverSessionId: null });
		const jobs = await env.DB.prepare('SELECT COUNT(*) AS n FROM observation_generation_jobs WHERE project_id = ?1').bind(t.projectId).first<{ n: number }>();
		expect(jobs?.n).toBe(0);
	});

	it('accepts the hooks client payload (narrative/title instead of content)', async () => {
		const t = await bootstrap();
		const memory = await addMemory(t.apiKey, { projectId: t.projectId, kind: 'decision', type: 'decision', narrative: 'Chose FTS5 over LIKE', title: 'Search engine' });
		expect(memory).toMatchObject({ kind: 'decision', content: 'Chose FTS5 over LIKE', metadata: { title: 'Search engine' } });
		const missing = await api('POST', '/v1/memories', t.apiKey, { projectId: t.projectId });
		expect(missing.status).toBe(400);
	});

	it('links a memory to its session through contentSessionId', async () => {
		const t = await bootstrap();
		const { session } = (await (await api('POST', '/v1/sessions/start', t.apiKey, { projectId: t.projectId, contentSessionId: 'mem-cs' })).json()) as {
			session: { id: string };
		};
		const memory = await addMemory(t.apiKey, { projectId: t.projectId, content: 'linked', contentSessionId: 'mem-cs' });
		expect(memory.serverSessionId).toBe(session.id);
	});

	it('keeps an imported createdAtEpoch and dedupes on idempotencyKey', async () => {
		const t = await bootstrap();
		const body = { projectId: t.projectId, content: 'imported', createdAtEpoch: 1_700_000_000_000, idempotencyKey: 'local:obs:42' };
		const first = await api('POST', '/v1/memories', t.apiKey, body);
		expect(first.status).toBe(201);
		const created = ((await first.json()) as { memory: { id: string; createdAtEpoch: number } }).memory;
		expect(created.createdAtEpoch).toBe(1_700_000_000_000);

		const again = await api('POST', '/v1/memories', t.apiKey, { ...body, content: 'changed' });
		expect(again.status).toBe(200);
		expect(((await again.json()) as { memory: { id: string; content: string } }).memory).toMatchObject({ id: created.id, content: 'imported' });
		const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM observations WHERE project_id = ?1').bind(t.projectId).first<{ n: number }>();
		expect(n?.n).toBe(1);

		// Same key in another project is a different memory.
		const other = await bootstrap();
		expect((await api('POST', '/v1/memories', other.apiKey, { ...body, projectId: other.projectId })).status).toBe(201);
	});

	it('orders imported memories by their original time in context inject', async () => {
		const t = await bootstrap();
		await addMemory(t.apiKey, { projectId: t.projectId, title: 'newest', content: 'newest' });
		await addMemory(t.apiKey, { projectId: t.projectId, title: 'old import', content: 'old import', createdAtEpoch: 1_600_000_000_000 });
		const text = await (await api('GET', `/v1/context/inject?projectId=${t.projectId}`, t.apiKey)).text();
		expect(text.indexOf('newest')).toBeLessThan(text.indexOf('old import'));
		expect(text).toContain('2020-09-13 [manual] old import');
	});

	it('rejects a future or malformed createdAtEpoch and an oversized key', async () => {
		const t = await bootstrap();
		const post = (extra: Record<string, unknown>) => api('POST', '/v1/memories', t.apiKey, { projectId: t.projectId, content: 'x', ...extra });
		expect((await post({ createdAtEpoch: Date.now() + 60 * 60_000 })).status).toBe(400);
		expect((await post({ createdAtEpoch: 1.5 })).status).toBe(400);
		expect((await post({ createdAtEpoch: -1 })).status).toBe(400);
		expect((await post({ idempotencyKey: 'k'.repeat(201) })).status).toBe(400);
	});
});

describe('POST /v1/search (FTS5)', () => {
	it('finds memories by stemmed terms, ranks the best match first, and stays in scope', async () => {
		const t = await bootstrap();
		const other = await bootstrap();
		const weak = await addMemory(t.apiKey, { projectId: t.projectId, content: 'The worker handles queue retries.' });
		const strong = await addMemory(t.apiKey, { projectId: t.projectId, content: 'Retry retries retrying: the queue retry policy uses exponential backoff for retries.' });
		await addMemory(t.apiKey, { projectId: t.projectId, content: 'Unrelated note about CSS grid.' });
		await addMemory(other.apiKey, { projectId: other.projectId, content: 'Other tenant queue retries.' });

		const found = await search(t.apiKey, { projectId: t.projectId, query: 'retry queue' });
		expect(found.status).toBe(200);
		expect(found.ids).toEqual([strong.id, weak.id]);

		const limited = await search(t.apiKey, { projectId: t.projectId, query: 'retries', limit: 1 });
		expect(limited.ids).toEqual([strong.id]);
	});

	it('never errors on hostile FTS syntax', async () => {
		const t = await bootstrap();
		const memory = await addMemory(t.apiKey, { projectId: t.projectId, content: 'foo bar baz' });
		const hostile = ['"foo AND (', 'foo*', 'NEAR(foo bar', ')))', "'; DROP TABLE observations; --", 'content:foo', '^foo', '-foo', 'foo OR', '"', '!!!', 'AND OR NOT'];
		for (const query of hostile) {
			const result = await search(t.apiKey, { projectId: t.projectId, query });
			expect(result.status, query).toBe(200);
		}
		expect((await search(t.apiKey, { projectId: t.projectId, query: '"foo AND (' })).ids).toEqual([memory.id]);
		expect((await search(t.apiKey, { projectId: t.projectId, query: '!!!' })).ids).toEqual([]);
		const stillThere = await env.DB.prepare('SELECT COUNT(*) AS n FROM observations').first<{ n: number }>();
		expect(stillThere?.n).toBeGreaterThan(0);
	});

	it('sanitizer quotes every term and drops operators', () => {
		expect(buildFtsMatchQuery('"foo AND ("')).toBe('"foo"');
		expect(buildFtsMatchQuery('Foo bar foo')).toBe('"foo" "bar"');
		expect(buildFtsMatchQuery('   ')).toBeNull();
	});

	it('filters by platformSource through the linked session', async () => {
		const t = await bootstrap();
		const start = async (platformSource: string) =>
			((await (await api('POST', '/v1/sessions/start', t.apiKey, { projectId: t.projectId, contentSessionId: `cs-${platformSource}`, platformSource })).json()) as {
				session: { id: string };
			}).session.id;
		const claudeSession = await start('claude');
		const cursorSession = await start('cursor');
		const a = await addMemory(t.apiKey, { projectId: t.projectId, content: 'shared topic alpha', serverSessionId: claudeSession });
		const b = await addMemory(t.apiKey, { projectId: t.projectId, content: 'shared topic beta', serverSessionId: cursorSession });
		expect((await search(t.apiKey, { projectId: t.projectId, query: 'shared topic', platformSource: 'claude-code' })).ids).toEqual([a.id]);
		expect(new Set((await search(t.apiKey, { projectId: t.projectId, query: 'shared topic' })).ids)).toEqual(new Set([a.id, b.id]));
	});
});

describe('POST /v1/context', () => {
	it('returns matches plus the joined context string', async () => {
		const t = await bootstrap();
		await addMemory(t.apiKey, { projectId: t.projectId, content: 'deploy with wrangler' });
		await addMemory(t.apiKey, { projectId: t.projectId, content: 'wrangler d1 migrations apply' });
		const res = await search(t.apiKey, { projectId: t.projectId, query: 'wrangler' }, '/v1/context');
		expect(res.status).toBe(200);
		expect(res.ids).toHaveLength(2);
		const context = res.body.context as string;
		expect(context.split('\n\n').sort()).toEqual(['deploy with wrangler', 'wrangler d1 migrations apply']);
	});
});

describe('DELETE /v1/memories/:id', () => {
	it('deletes the memory and its FTS entry; 404 afterwards and across tenants', async () => {
		const t = await bootstrap();
		const other = await bootstrap();
		const memory = await addMemory(t.apiKey, { projectId: t.projectId, content: 'ephemeral secret thing' });
		expect((await api('DELETE', `/v1/memories/${memory.id}`, other.apiKey)).status).toBe(404);

		const res = await api('DELETE', `/v1/memories/${memory.id}`, t.apiKey);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ deleted: true, id: memory.id });
		expect((await search(t.apiKey, { projectId: t.projectId, query: 'ephemeral' })).ids).toEqual([]);
		expect((await api('DELETE', `/v1/memories/${memory.id}`, t.apiKey)).status).toBe(404);
	});
});

describe('GET /v1/context/inject', () => {
	it('returns an empty text/plain body when the project has no memory', async () => {
		const t = await bootstrap();
		const res = await api('GET', `/v1/context/inject?projectId=${t.projectId}&platformSource=claude`, t.apiKey);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/plain');
		expect(await res.text()).toBe('');
	});

	it('renders the latest summary and recent observations as markdown', async () => {
		const t = await bootstrap({ projectName: 'my-repo' });
		await addMemory(t.apiKey, { projectId: t.projectId, kind: 'summary', content: 'Old summary' });
		await addMemory(t.apiKey, { projectId: t.projectId, kind: 'summary', content: 'Implemented the D1 port.\nNext: cron.' });
		await addMemory(t.apiKey, { projectId: t.projectId, kind: 'discovery', content: 'body text', metadata: { title: 'FTS5 needs a stable rowid' } });
		await addMemory(t.apiKey, { projectId: t.projectId, kind: 'manual', content: '\n\nFirst real line\nsecond' });
		// Newest-first order is by created_at; make it deterministic.
		const rows = await env.DB.prepare('SELECT id, content FROM observations WHERE project_id = ?1 ORDER BY seq').bind(t.projectId).all<{ id: string }>();
		for (const [i, row] of rows.results.entries()) {
			await env.DB.prepare('UPDATE observations SET created_at = ?2 WHERE id = ?1').bind(row.id, Date.UTC(2026, 0, 1 + i)).run();
		}

		const res = await api('GET', `/v1/context/inject?projectId=${t.projectId}`, t.apiKey);
		expect(res.status).toBe(200);
		const markdown = await res.text();
		const lines = markdown.split('\n');
		expect(lines[0]).toMatch(/^# \[my-repo\] recent context \(server\), \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
		expect(markdown).toContain('## Last session (2026-01-02)\n\nImplemented the D1 port.\nNext: cron.');
		expect(markdown).not.toContain('Old summary');
		expect(markdown).toContain('## Recent observations\n\n- 2026-01-04 [manual] First real line\n- 2026-01-03 [discovery] FTS5 needs a stable rowid\n');
	});

	it('400 without projectId; 403 for another project', async () => {
		const t = await bootstrap();
		expect((await api('GET', '/v1/context/inject', t.apiKey)).status).toBe(400);
		expect((await api('GET', '/v1/context/inject?projectId=someone-else', t.apiKey)).status).toBe(403);
	});
});
