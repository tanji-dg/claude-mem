// SPDX-License-Identifier: Apache-2.0
//
// D1 counterparts of src/storage/postgres/utils.ts. Differences that matter:
//   - JSON columns are TEXT, so rows carry strings that mapRow parses.
//   - Timestamps are INTEGER epoch ms written by the Worker (no now()).
//   - Hashing uses crypto.subtle, so key builders are async. The digest input
//     (canonical JSON of the parts) is byte-identical to the Postgres runtime,
//     so idempotency keys match across runtimes.

export type JsonObject = Record<string, unknown>;
export type JsonValue = unknown;

export function newId(): string {
	return crypto.randomUUID();
}

export function nowMs(): number {
	return Date.now();
}

export function parseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value ?? null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

export function toJsonObject(value: unknown): JsonObject {
	const parsed = parseJson(value);
	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		return parsed as JsonObject;
	}
	return {};
}

export function toJsonArray(value: unknown): unknown[] {
	const parsed = parseJson(value);
	return Array.isArray(parsed) ? parsed : [];
}

export function toEpochOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function deterministicKey(parts: readonly unknown[]): Promise<string> {
	return sha256Hex(canonicalJson(parts));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortJson);
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return Object.keys(record)
			.sort()
			.reduce<Record<string, unknown>>((acc, key) => {
				acc[key] = sortJson(record[key]);
				return acc;
			}, {});
	}
	return value;
}

/** Ownership errors carry the Postgres repo's messages so routes map them to 403 identically. */
export class ScopeError extends Error {}

export async function assertProjectOwnership(db: D1Database, projectId: string, teamId: string): Promise<void> {
	const row = await db.prepare('SELECT id FROM projects WHERE id = ?1 AND team_id = ?2').bind(projectId, teamId).first();
	if (!row) throw new ScopeError('project_id must belong to team_id');
}

export async function assertSessionOwnership(
	db: D1Database,
	serverSessionId: string,
	projectId: string,
	teamId: string,
): Promise<void> {
	const row = await db
		.prepare('SELECT id FROM server_sessions WHERE id = ?1 AND project_id = ?2 AND team_id = ?3')
		.bind(serverSessionId, projectId, teamId)
		.first();
	if (!row) throw new ScopeError('server_session_id must belong to project_id and team_id');
}

export function isUniqueConstraintError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('UNIQUE constraint failed');
}
