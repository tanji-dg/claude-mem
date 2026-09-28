// SPDX-License-Identifier: Apache-2.0
//
// Per-request helpers shared by the /v1 route modules (the Express runtime's
// requireTeamId / ensureProjectAllowed / loadScopedById / handleCreate).

import type { z } from 'zod';
import type { AuthContext, ScopeRequirement } from '../auth';
import { authenticate, ensureProjectAllowed, requireTeamId } from '../auth';
import { errorResponse, readJsonBody, validationError } from '../http';
import type { RouteContext } from '../router';

export interface Authorized {
	auth: AuthContext;
	teamId: string;
}

/** Authenticate + require a team-bound key. Returns the Response to send on failure. */
export async function authorize(rc: RouteContext, requirement: ScopeRequirement): Promise<Authorized | Response> {
	const auth = await authenticate(rc.request, rc.env.DB, requirement);
	if (auth instanceof Response) return auth;
	const teamId = requireTeamId(auth);
	if (teamId instanceof Response) return teamId;
	return { auth, teamId };
}

/** Parse + validate a JSON body; also returns the raw value (some fields are read pre-validation). */
export async function parseBody<S extends z.ZodType>(rc: RouteContext, schema: S): Promise<{ data: z.infer<S>; raw: unknown } | Response> {
	const body = await readJsonBody(rc.request);
	if (!body.ok) return body.response;
	const result = schema.safeParse(body.value);
	if (!result.success) return validationError(result.error.issues);
	return { data: result.data, raw: body.value };
}

type ScopedTable = 'agent_events' | 'server_sessions' | 'observation_generation_jobs';

/**
 * Resolve a row's project by (id, team) — 404 cross-tenant so existence never
 * leaks — then enforce the key's project scope: 403 by default, or 404 when
 * `scopeMismatch: 'not-found'` (routes that must not disclose sibling
 * projects). Returns the row's project id.
 */
export async function loadScopedProjectId(
	rc: RouteContext,
	authz: Authorized,
	input: { id: string; table: ScopedTable; notFound: string; scopeMismatch?: 'not-found' },
): Promise<string | Response> {
	const row = await rc.env.DB.prepare(`SELECT project_id FROM ${input.table} WHERE id = ?1 AND team_id = ?2`)
		.bind(input.id, authz.teamId)
		.first<{ project_id: string }>();
	if (!row) return errorResponse(404, 'NotFound', input.notFound);
	if (input.scopeMismatch === 'not-found') {
		if (authz.auth.projectId && authz.auth.projectId !== row.project_id) {
			return errorResponse(404, 'NotFound', input.notFound);
		}
	} else {
		const denied = ensureProjectAllowed(authz.auth, row.project_id);
		if (denied) return denied;
	}
	return row.project_id;
}

/**
 * Platform scope for a session lookup, derived from the RAW body so an omitted
 * `platformSource` (match any platform) and an explicit null (match
 * platform-less rows only) keep meaning different things.
 */
export function sessionLookupPlatformScope(body: unknown, normalize: (value: string) => string): { platformSource?: string | null } {
	if (!body || typeof body !== 'object') return {};
	if (!Object.prototype.hasOwnProperty.call(body, 'platformSource')) return {};
	const value = (body as { platformSource?: unknown }).platformSource;
	return { platformSource: typeof value === 'string' ? normalize(value) : null };
}
