import { describe, expect, it } from 'vitest';
import { api, bootstrap, insertApiKey } from './helpers';

async function resolve(key: string, name: string) {
	const res = await api('POST', '/v1/projects/resolve', key, { name });
	return { status: res.status, body: (await res.json()) as { project?: { id: string; name: string }; created?: boolean } };
}

describe('POST /v1/admin/bootstrap keyScope', () => {
	it('mints a team-scoped key without a project', async () => {
		const t = await bootstrap({ keyScope: 'team' });
		expect(t.projectId).toBeNull();
		expect((await resolve(t.apiKey, 'alpha')).status).toBe(201);
	});
});

describe('POST /v1/projects/resolve', () => {
	it('creates a project once, then returns the same one', async () => {
		const t = await bootstrap({ keyScope: 'team' });
		const first = await resolve(t.apiKey, 'kozekachi_ai');
		expect(first.status).toBe(201);
		expect(first.body).toMatchObject({ created: true, project: { name: 'kozekachi_ai' } });
		const again = await resolve(t.apiKey, '  kozekachi_ai ');
		expect(again.status).toBe(200);
		expect(again.body).toMatchObject({ created: false, project: { id: first.body.project!.id } });
		const other = await resolve(t.apiKey, 'claude-mem');
		expect(other.body.project!.id).not.toBe(first.body.project!.id);
	});

	it('never creates duplicates under concurrent resolves', async () => {
		const t = await bootstrap({ keyScope: 'team' });
		const results = await Promise.all(Array.from({ length: 8 }, () => resolve(t.apiKey, 'racy')));
		expect(new Set(results.map((r) => r.body.project!.id)).size).toBe(1);
		expect(results.filter((r) => r.body.created).length).toBe(1);
	});

	it('keeps teams apart', async () => {
		const a = await bootstrap({ keyScope: 'team' });
		const b = await bootstrap({ keyScope: 'team' });
		const pa = (await resolve(a.apiKey, 'shared-name')).body.project!.id;
		const pb = (await resolve(b.apiKey, 'shared-name')).body.project!.id;
		expect(pa).not.toBe(pb);
		// b's key cannot write into a's project.
		const res = await api('POST', '/v1/memories', b.apiKey, { projectId: pa, content: 'x' });
		expect(res.status).toBe(403);
	});

	it('rejects project-scoped keys', async () => {
		const t = await bootstrap();
		expect((await resolve(t.apiKey, 'anything')).status).toBe(403);
	});

	it('accepts the installer sessions:write scope but not read-only keys', async () => {
		const t = await bootstrap({ keyScope: 'team' });
		const hookKey = await insertApiKey({ teamId: t.teamId, scopes: ['sessions:write', 'events:write', 'observations:read'] });
		expect((await resolve(hookKey, 'hooks')).status).toBe(201);
		const readKey = await insertApiKey({ teamId: t.teamId, scopes: ['observations:read'] });
		expect((await resolve(readKey, 'hooks')).status).toBe(403);
	});

	it('validates the name', async () => {
		const t = await bootstrap({ keyScope: 'team' });
		expect((await resolve(t.apiKey, '   ')).status).toBe(400);
		expect((await resolve(t.apiKey, 'x'.repeat(201))).status).toBe(400);
	});

	it('scopes memories and context to the resolved project', async () => {
		const t = await bootstrap({ keyScope: 'team' });
		const one = (await resolve(t.apiKey, 'one')).body.project!.id;
		const two = (await resolve(t.apiKey, 'two')).body.project!.id;
		expect((await api('POST', '/v1/memories', t.apiKey, { projectId: one, title: 'only in one', content: 'only in one' })).status).toBe(201);
		const injectOne = await (await api('GET', `/v1/context/inject?projectId=${one}`, t.apiKey)).text();
		const injectTwo = await (await api('GET', `/v1/context/inject?projectId=${two}`, t.apiKey)).text();
		expect(injectOne).toContain('[one]');
		expect(injectOne).toContain('only in one');
		expect(injectTwo).toBe('');
	});
});
