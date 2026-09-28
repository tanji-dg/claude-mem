// SPDX-License-Identifier: Apache-2.0
//
// Memory read/write routes: POST /v1/memories, DELETE /v1/memories/:id,
// POST /v1/search, POST /v1/context (ports of ServerV1PostgresRoutes) and the
// SessionStart injection route GET /v1/context/inject.

import { z } from 'zod';
import { normalizePlatformSource, normalizePlatformSourceOrNull } from '../../../../src/shared/platform-source';
import { ensureProjectAllowed, ROUTE_SCOPES } from '../auth';
import { dbErrorResponse, errorResponse, json, text } from '../http';
import type { RouteContext } from '../router';
import { CONTEXT_INJECT_LIMIT, renderContextInjectMarkdown } from '../services/context-inject';
import { AuthRepository } from '../storage/auth';
import { ObservationRepository } from '../storage/observations';
import { ServerSessionsRepository } from '../storage/server-sessions';
import { authorize, parseBody, sessionLookupPlatformScope } from './common';
import { serializeObservation } from './serializers';

const AddMemorySchema = z
	.object({
		projectId: z.string().min(1),
		serverSessionId: z.string().min(1).nullable().optional(),
		contentSessionId: z.string().min(1).nullable().optional(),
		platformSource: z.string().min(1).nullable().optional(),
		kind: z.string().min(1).optional(),
		content: z.string().min(1).optional(),
		// ServerClient.buildAddObservationPayload sends the text as `narrative`
		// (+ optional `title`), not `content`; the Express route requires
		// `content` and 400s that client. Accept both here.
		narrative: z.string().min(1).optional(),
		title: z.string().min(1).optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.refine((body) => Boolean(body.content ?? body.narrative ?? body.title), {
		message: 'content is required',
		path: ['content'],
	});

const SearchSchema = z.object({
	projectId: z.string().min(1),
	query: z.string().min(1),
	limit: z.number().int().positive().max(100).optional(),
	platformSource: z.string().min(1).nullable().optional(),
});

const ContextSchema = SearchSchema.extend({
	limit: z.number().int().positive().max(50).optional(),
});

/** Direct/manual observation insert. Never creates a generation job. */
export async function postMemory(rc: RouteContext): Promise<Response> {
	const authz = await authorize(rc, ROUTE_SCOPES.memoriesWrite);
	if (authz instanceof Response) return authz;
	const parsed = await parseBody(rc, AddMemorySchema);
	if (parsed instanceof Response) return parsed;
	const body = parsed.data;
	const denied = ensureProjectAllowed(authz.auth, body.projectId);
	if (denied) return denied;

	const content = (body.content ?? body.narrative ?? body.title)!;
	const metadata = { ...(body.title && !body.metadata?.title ? { title: body.title } : {}), ...(body.metadata ?? {}) };
	const serverSessionId = await resolveMemorySessionLink(rc.env.DB, {
		serverSessionId: body.serverSessionId ?? null,
		contentSessionId: body.contentSessionId ?? null,
		projectId: body.projectId,
		teamId: authz.teamId,
		...sessionLookupPlatformScope(parsed.raw, normalizePlatformSource),
	});
	try {
		const observation = await new ObservationRepository(rc.env.DB).create({
			projectId: body.projectId,
			teamId: authz.teamId,
			serverSessionId,
			kind: body.kind ?? 'manual',
			content,
			metadata,
		});
		return json(201, { memory: serializeObservation(observation) });
	} catch (error) {
		return dbErrorResponse(error, 'memory.write');
	}
}

export async function postSearch(rc: RouteContext): Promise<Response> {
	const authz = await authorize(rc, ROUTE_SCOPES.observationsRead);
	if (authz instanceof Response) return authz;
	const parsed = await parseBody(rc, SearchSchema);
	if (parsed instanceof Response) return parsed;
	const body = parsed.data;
	const denied = ensureProjectAllowed(authz.auth, body.projectId);
	if (denied) return denied;
	try {
		const results = await new ObservationRepository(rc.env.DB).search({
			projectId: body.projectId,
			teamId: authz.teamId,
			query: body.query,
			limit: body.limit ?? 20,
			platformSource: normalizePlatformSourceOrNull(body.platformSource),
		});
		return json(200, { observations: results.map(serializeObservation) });
	} catch (error) {
		return dbErrorResponse(error, 'observation.search');
	}
}

/** Same FTS path as /v1/search plus the concatenated `context` string. */
export async function postContext(rc: RouteContext): Promise<Response> {
	const authz = await authorize(rc, ROUTE_SCOPES.observationsRead);
	if (authz instanceof Response) return authz;
	const parsed = await parseBody(rc, ContextSchema);
	if (parsed instanceof Response) return parsed;
	const body = parsed.data;
	const denied = ensureProjectAllowed(authz.auth, body.projectId);
	if (denied) return denied;
	try {
		const results = await new ObservationRepository(rc.env.DB).search({
			projectId: body.projectId,
			teamId: authz.teamId,
			query: body.query,
			limit: body.limit ?? 10,
			platformSource: normalizePlatformSourceOrNull(body.platformSource),
		});
		const context = results
			.map((o) => o.content)
			.filter((t) => typeof t === 'string' && t.length > 0)
			.join('\n\n');
		return json(200, { observations: results.map(serializeObservation), context });
	} catch (error) {
		return dbErrorResponse(error, 'observation.context');
	}
}

/**
 * GET /v1/context/inject?projectId=&platformSource= → text/plain markdown of
 * recent project memory ('' when there is none). Contract shared with the
 * Express runtime and ServerClient.contextInject. platformSource is accepted
 * but, as on Express, does not filter (a project's memory is shared across
 * the agents working on it).
 *
 * Reads at most CONTEXT_INJECT_LIMIT rows via idx_observations_team_project_created,
 * plus one indexed probe for the latest summary when it fell outside that window.
 */
export async function getContextInject(rc: RouteContext): Promise<Response> {
	const authz = await authorize(rc, ROUTE_SCOPES.observationsRead);
	if (authz instanceof Response) return authz;
	const projectId = rc.url.searchParams.get('projectId')?.trim() ?? '';
	if (!projectId) return errorResponse(400, 'ValidationError', 'projectId required');
	const denied = ensureProjectAllowed(authz.auth, projectId);
	if (denied) return denied;
	try {
		const repo = new ObservationRepository(rc.env.DB);
		const rows = await repo.listByProject({ projectId, teamId: authz.teamId, limit: CONTEXT_INJECT_LIMIT });
		if (rows.length === 0) return text(200, '');
		if (!rows.some((o) => o.kind === 'summary')) {
			const summary = await repo.latestByKind({ projectId, teamId: authz.teamId, kind: 'summary' });
			if (summary) rows.push(summary);
		}
		const project = await new AuthRepository(rc.env.DB).getProjectForTeam(projectId, authz.teamId);
		return text(200, renderContextInjectMarkdown(rows, { projectName: project?.name ?? projectId }));
	} catch (error) {
		return dbErrorResponse(error, 'observation.context_inject');
	}
}

/** Forget one observation (sources cascade; FTS row removed by trigger). */
export async function deleteMemory(rc: RouteContext): Promise<Response> {
	const authz = await authorize(rc, ROUTE_SCOPES.memoriesDelete);
	if (authz instanceof Response) return authz;
	const id = rc.params.id ?? '';
	const projectScope = authz.auth.projectId ?? null;
	try {
		const deleted = await new ObservationRepository(rc.env.DB).deleteForScope({ id, teamId: authz.teamId, projectId: projectScope });
		if (!deleted) return json(404, { error: 'not_found' });
		// Deletions are the one write worth an audit row on a personal deployment.
		rc.ctx.waitUntil(
			new AuthRepository(rc.env.DB)
				.createAuditLog({
					teamId: authz.teamId,
					projectId: projectScope,
					actorId: authz.auth.actorId,
					apiKeyId: authz.auth.apiKeyId,
					action: 'observation.deleted',
					resourceType: 'observation',
					resourceId: id,
					details: { via: 'api', requestId: rc.requestId },
				})
				.catch((err: unknown) => console.warn(JSON.stringify({ level: 'WARN', message: 'audit log insert failed', error: String(err) }))),
		);
		return json(200, { deleted: true, id });
	} catch (error) {
		return dbErrorResponse(error, 'observation.delete');
	}
}

/**
 * Explicit serverSessionId wins; otherwise resolve contentSessionId like the
 * ingest path. Best-effort: a lookup failure stores the memory unlinked.
 */
async function resolveMemorySessionLink(
	db: D1Database,
	input: { serverSessionId: string | null; contentSessionId: string | null; projectId: string; teamId: string; platformSource?: string | null },
): Promise<string | null> {
	if (input.serverSessionId) return input.serverSessionId;
	if (!input.contentSessionId) return null;
	const platformScope = Object.prototype.hasOwnProperty.call(input, 'platformSource') ? { platformSource: input.platformSource ?? null } : {};
	try {
		return await new ServerSessionsRepository(db).findIdByContentSessionId({
			contentSessionId: input.contentSessionId,
			projectId: input.projectId,
			teamId: input.teamId,
			...platformScope,
		});
	} catch (err) {
		console.warn(JSON.stringify({ level: 'WARN', message: 'session linkage lookup failed; storing memory unlinked', error: String(err) }));
		return null;
	}
}
