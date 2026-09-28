// SPDX-License-Identifier: Apache-2.0
//
// API-key auth, ported from src/server/middleware/postgres-auth.ts:
//   Bearer (canonical) or X-Api-Key → SHA-256 hex → api_keys.key_hash lookup.
//   missing key                                  → 401
//   unknown / revoked / expired / missing scope  → 403
// Scope rule: every required scope must be granted exactly, or "*" is held.
//
// Installer scope aliases. The server-mode installer
// (src/services/hooks/server-bootstrap.ts HOOK_API_KEY_SCOPES) mints keys with
// events:write / sessions:write / observations:read / jobs:read, while every
// /v1 route requires memories:write or memories:read. Each route may name the
// narrower installer scope that is "appropriate" for it (see ROUTE_SCOPES),
// which then satisfies the canonical requirement for that route only. The
// Express runtime applies the same table (`aliasScope` in
// src/server/middleware/postgres-auth.ts).

import { errorResponse } from './http';
import { AuthRepository } from './storage/auth';
import { sha256Hex } from './storage/utils';

export type RequiredScope = 'memories:read' | 'memories:write';
export type InstallerScope = 'events:write' | 'sessions:write' | 'observations:read' | 'jobs:read';

export interface ScopeRequirement {
	/** Canonical scope (exact match or "*"), as in the Express runtime. */
	scope: RequiredScope;
	/** Installer-issued scope that is accepted instead for this route. */
	alias?: InstallerScope;
}

/** Scope requirement per route family. */
export const ROUTE_SCOPES = {
	sessionsWrite: { scope: 'memories:write', alias: 'sessions:write' },
	eventsWrite: { scope: 'memories:write', alias: 'events:write' },
	// Manual memory inserts come from the same hook/MCP client as events.
	memoriesWrite: { scope: 'memories:write', alias: 'events:write' },
	// Deleting memory is never granted by an installer scope.
	memoriesDelete: { scope: 'memories:write' },
	observationsRead: { scope: 'memories:read', alias: 'observations:read' },
	jobsRead: { scope: 'memories:read', alias: 'jobs:read' },
	// Find-or-create by name happens where the hooks client starts sessions.
	projectsResolve: { scope: 'memories:write', alias: 'sessions:write' },
} as const satisfies Record<string, ScopeRequirement>;

export interface AuthContext {
	apiKeyId: string;
	actorId: string;
	teamId: string | null;
	projectId: string | null;
	scopes: string[];
}

export function parseBearerToken(header: string | null): string {
	if (!header) return '';
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? match[1]!.trim() : '';
}

export function hasRequiredScope(granted: readonly string[], requirement: ScopeRequirement): boolean {
	if (granted.includes('*') || granted.includes(requirement.scope)) return true;
	return requirement.alias !== undefined && granted.includes(requirement.alias);
}

export async function hashApiKey(rawKey: string): Promise<string> {
	return sha256Hex(rawKey);
}

/** Returns the caller's AuthContext, or the 401/403 Response to send. */
export async function authenticate(request: Request, db: D1Database, requirement: ScopeRequirement): Promise<AuthContext | Response> {
	const rawKey = parseBearerToken(request.headers.get('Authorization')) || request.headers.get('X-Api-Key')?.trim() || '';
	if (!rawKey) {
		return errorResponse(401, 'Unauthorized', 'Missing API key (Authorization: Bearer <key> or X-Api-Key: <key>)');
	}
	const key = await new AuthRepository(db).getApiKeyByHash(await hashApiKey(rawKey));
	const now = Date.now();
	const scopes = (key?.scopes ?? []).filter((s): s is string => typeof s === 'string');
	if (!key || key.revokedAtEpoch !== null || (key.expiresAtEpoch !== null && key.expiresAtEpoch <= now) || !hasRequiredScope(scopes, requirement)) {
		return errorResponse(403, 'Forbidden', 'Invalid API key or insufficient scope');
	}
	return { apiKeyId: key.id, actorId: key.actorId, teamId: key.teamId, projectId: key.projectId, scopes };
}

/** 403 when the key is not bound to a team (same message as Postgres routes). */
export function requireTeamId(auth: AuthContext): string | Response {
	return auth.teamId ?? errorResponse(403, 'Forbidden', 'API key is not bound to a team');
}

/** 403 when a project-scoped key targets another project; null when allowed. */
export function ensureProjectAllowed(auth: AuthContext, projectId: string): Response | null {
	if (auth.projectId && auth.projectId !== projectId) {
		return errorResponse(403, 'Forbidden', 'API key is scoped to a different project');
	}
	return null;
}

/** Constant-time string equality (hash first so lengths always match). */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [da, db] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(da, db);
}
