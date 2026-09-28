import { env, SELF } from 'cloudflare:test';

export const BASE = 'https://cmem.test';
export const ADMIN_TOKEN = 'test-admin-token';

export interface Tenant {
	teamId: string;
	projectId: string;
	apiKey: string;
}

export async function bootstrap(body: Record<string, unknown> = {}): Promise<Tenant> {
	const res = await SELF.fetch(`${BASE}/v1/admin/bootstrap`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (res.status !== 201) throw new Error(`bootstrap failed: ${res.status} ${await res.text()}`);
	return (await res.json()) as Tenant;
}

export function api(method: string, path: string, key: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return SELF.fetch(`${BASE}${path}`, {
		method,
		headers: {
			...(key ? { Authorization: `Bearer ${key}` } : {}),
			...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Insert an API key row directly (scopes/revocation/expiry the bootstrap route never mints). */
export async function insertApiKey(input: {
	teamId: string | null;
	projectId?: string | null;
	scopes: string[];
	revokedAt?: number | null;
	expiresAt?: number | null;
}): Promise<string> {
	const raw = `test_${crypto.randomUUID()}`;
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO api_keys (id, key_hash, team_id, project_id, actor_id, scopes, revoked_at, expires_at, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, 'test', ?5, ?6, ?7, ?8, ?8)`,
	)
		.bind(
			crypto.randomUUID(),
			await sha256Hex(raw),
			input.teamId,
			input.projectId ?? null,
			JSON.stringify(input.scopes),
			input.revokedAt ?? null,
			input.expiresAt ?? null,
			now,
		)
		.run();
	return raw;
}

export async function addProject(teamId: string, name = 'second'): Promise<string> {
	const id = crypto.randomUUID();
	const now = Date.now();
	await env.DB.prepare('INSERT INTO projects (id, team_id, name, metadata, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)')
		.bind(id, teamId, name, '{}', now)
		.run();
	return id;
}

export function eventBody(projectId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		projectId,
		sourceType: 'hook',
		eventType: 'PostToolUse',
		occurredAtEpoch: 1_700_000_000_000,
		payload: { tool: 'Read', input: { file: 'a.ts' } },
		...extra,
	};
}
