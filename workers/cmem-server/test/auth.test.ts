import { createExecutionContext, env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { router } from '../src/index';
import { ADMIN_TOKEN, addProject, api, BASE, bootstrap, eventBody, insertApiKey } from './helpers';

describe('admin bootstrap', () => {
	it('creates team, project and a working key, storing only its hash', async () => {
		const tenant = await bootstrap({ teamName: 'me', projectName: 'repo' });
		expect(tenant.apiKey).toMatch(/^cmem_[0-9a-f]{64}$/);
		const rows = await env.DB.prepare('SELECT key_hash, scopes FROM api_keys WHERE team_id = ?1').bind(tenant.teamId).all<{ key_hash: string; scopes: string }>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results[0]!.key_hash).not.toContain(tenant.apiKey);
		expect(JSON.parse(rows.results[0]!.scopes)).toEqual(['memories:read', 'memories:write']);
		const project = await env.DB.prepare('SELECT name FROM projects WHERE id = ?1').bind(tenant.projectId).first<{ name: string }>();
		expect(project?.name).toBe('repo');

		const res = await api('POST', '/v1/search', tenant.apiKey, { projectId: tenant.projectId, query: 'anything' });
		expect(res.status).toBe(200);
	});

	it('401 without a token, 403 with a wrong one', async () => {
		const missing = await SELF.fetch(`${BASE}/v1/admin/bootstrap`, { method: 'POST' });
		expect(missing.status).toBe(401);
		const wrong = await SELF.fetch(`${BASE}/v1/admin/bootstrap`, { method: 'POST', headers: { Authorization: 'Bearer nope' } });
		expect(wrong.status).toBe(403);
	});

	it('404 when CMEM_ADMIN_TOKEN is not configured', async () => {
		const request = new Request(`${BASE}/v1/admin/bootstrap`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
		const res = await router.handle(request, { ...env, CMEM_ADMIN_TOKEN: undefined }, createExecutionContext());
		expect(res.status).toBe(404);
	});
});

describe('API key auth', () => {
	it('401 when no key is presented', async () => {
		const res = await api('POST', '/v1/search', null, { projectId: 'p', query: 'q' });
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ error: 'Unauthorized' });
	});

	it('403 for an unknown, revoked or expired key', async () => {
		const tenant = await bootstrap();
		const revoked = await insertApiKey({ teamId: tenant.teamId, scopes: ['*'], revokedAt: Date.now() - 1 });
		const expired = await insertApiKey({ teamId: tenant.teamId, scopes: ['*'], expiresAt: Date.now() - 1 });
		for (const key of ['cmem_unknown', revoked, expired]) {
			const res = await api('POST', '/v1/search', key, { projectId: tenant.projectId, query: 'q' });
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ error: 'Forbidden', message: 'Invalid API key or insufficient scope' });
		}
	});

	it('accepts X-Api-Key as a fallback header', async () => {
		const tenant = await bootstrap();
		const res = await api('POST', '/v1/search', null, { projectId: tenant.projectId, query: 'q' }, { 'X-Api-Key': tenant.apiKey });
		expect(res.status).toBe(200);
	});

	it('enforces exact scopes, with "*" as a wildcard', async () => {
		const tenant = await bootstrap();
		const readOnly = await insertApiKey({ teamId: tenant.teamId, scopes: ['memories:read'] });
		const star = await insertApiKey({ teamId: tenant.teamId, scopes: ['*'] });
		expect((await api('POST', '/v1/events', readOnly, eventBody(tenant.projectId))).status).toBe(403);
		expect((await api('POST', '/v1/events', star, eventBody(tenant.projectId))).status).toBe(201);
	});

	it('maps installer-issued scopes onto the matching routes only', async () => {
		const tenant = await bootstrap();
		const events = await insertApiKey({ teamId: tenant.teamId, scopes: ['events:write'] });
		const sessions = await insertApiKey({ teamId: tenant.teamId, scopes: ['sessions:write'] });
		const observations = await insertApiKey({ teamId: tenant.teamId, scopes: ['observations:read'] });
		const jobs = await insertApiKey({ teamId: tenant.teamId, scopes: ['jobs:read'] });
		const installer = await insertApiKey({
			teamId: tenant.teamId,
			projectId: tenant.projectId,
			scopes: ['events:write', 'sessions:write', 'observations:read', 'jobs:read'],
		});
		const start = { projectId: tenant.projectId, externalSessionId: 'scope-test' };
		const search = { projectId: tenant.projectId, query: 'q' };

		expect((await api('POST', '/v1/events', events, eventBody(tenant.projectId))).status).toBe(201);
		expect((await api('POST', '/v1/sessions/start', events, start)).status).toBe(403);
		expect((await api('POST', '/v1/sessions/start', sessions, start)).status).toBe(201);
		expect((await api('POST', '/v1/events', sessions, eventBody(tenant.projectId))).status).toBe(403);
		expect((await api('POST', '/v1/search', observations, search)).status).toBe(200);
		expect((await api('POST', '/v1/search', jobs, search)).status).toBe(403);
		expect((await api('GET', '/v1/jobs/none', jobs)).status).toBe(404);
		expect((await api('GET', '/v1/jobs/none', observations)).status).toBe(403);
		// No installer scope grants deletion.
		expect((await api('DELETE', '/v1/memories/none', installer)).status).toBe(403);

		// The full installer key drives the whole hook flow.
		const session = await api('POST', '/v1/sessions/start', installer, { ...start, externalSessionId: 'installer' });
		expect(session.status).toBe(201);
		expect((await api('POST', '/v1/events', installer, eventBody(tenant.projectId, { contentSessionId: 'installer' }))).status).toBe(201);
		expect((await api('POST', '/v1/memories', installer, { projectId: tenant.projectId, narrative: 'from hook' })).status).toBe(201);
		expect((await api('GET', `/v1/context/inject?projectId=${tenant.projectId}`, installer)).status).toBe(200);
	});

	it('403 when a project-scoped key targets another project, or a key has no team', async () => {
		const tenant = await bootstrap();
		const other = await addProject(tenant.teamId);
		const res = await api('POST', '/v1/search', tenant.apiKey, { projectId: other, query: 'q' });
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ message: 'API key is scoped to a different project' });

		const teamless = await insertApiKey({ teamId: null, scopes: ['*'] });
		const noTeam = await api('POST', '/v1/search', teamless, { projectId: tenant.projectId, query: 'q' });
		expect(noTeam.status).toBe(403);
		expect(await noTeam.json()).toMatchObject({ message: 'API key is not bound to a team' });
	});

	it('403 when a team-scoped key writes into a project of another team', async () => {
		const a = await bootstrap();
		const b = await bootstrap();
		const teamKey = await insertApiKey({ teamId: a.teamId, scopes: ['*'] });
		const res = await api('POST', '/v1/events', teamKey, eventBody(b.projectId));
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ message: 'project_id must belong to team_id' });
	});
});

describe('meta routes', () => {
	it('serves /healthz and /v1/info without auth, 404/405 otherwise', async () => {
		expect(await (await SELF.fetch(`${BASE}/healthz`)).json()).toEqual({ status: 'ok', runtime: 'server-beta' });
		expect(await (await SELF.fetch(`${BASE}/v1/info`)).json()).toMatchObject({ name: 'claude-mem-server', platform: 'cloudflare-workers' });
		expect((await SELF.fetch(`${BASE}/nope`)).status).toBe(404);
		expect((await SELF.fetch(`${BASE}/v1/search`)).status).toBe(405);
	});
});
