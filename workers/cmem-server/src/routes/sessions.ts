// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/sessions/start and POST /v1/sessions/:id/end — ports of the
// ServerV1PostgresRoutes handlers (same status codes and bodies).

import { z } from 'zod';
import { normalizePlatformSourceOrNull } from '../../../../src/shared/platform-source';
import { ensureProjectAllowed, ROUTE_SCOPES } from '../auth';
import { scheduleGeneration } from '../generation/enqueue';
import { dbErrorResponse, errorResponse, json } from '../http';
import type { RouteContext } from '../router';
import { endSession } from '../services/ingest';
import { ServerSessionsRepository } from '../storage/server-sessions';
import { isUniqueConstraintError } from '../storage/utils';
import { authorize, loadScopedProjectId, parseBody } from './common';
import { serializeGenerationJob, serializeSession } from './serializers';

const StartSessionSchema = z.object({
	projectId: z.string().min(1),
	externalSessionId: z.string().min(1).optional(),
	contentSessionId: z.string().min(1).nullable().optional(),
	agentId: z.string().min(1).nullable().optional(),
	agentType: z.string().min(1).nullable().optional(),
	platformSource: z.string().min(1).nullable().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Create-or-find: 200 with the existing session, 201 when newly created. */
export async function startSession(rc: RouteContext): Promise<Response> {
	const authz = await authorize(rc, ROUTE_SCOPES.sessionsWrite);
	if (authz instanceof Response) return authz;
	const parsed = await parseBody(rc, StartSessionSchema);
	if (parsed instanceof Response) return parsed;
	const body = parsed.data;
	const denied = ensureProjectAllowed(authz.auth, body.projectId);
	if (denied) return denied;

	const repo = new ServerSessionsRepository(rc.env.DB);
	const platformSource = normalizePlatformSourceOrNull(body.platformSource);
	const findExisting = () =>
		repo.findByExternalIdForScope({
			externalSessionId: body.externalSessionId!,
			projectId: body.projectId,
			teamId: authz.teamId,
			platformSource,
		});
	try {
		if (body.externalSessionId) {
			const existing = await findExisting();
			if (existing) return json(200, { session: serializeSession(existing) });
		}
		try {
			const session = await repo.create({
				projectId: body.projectId,
				teamId: authz.teamId,
				externalSessionId: body.externalSessionId ?? null,
				contentSessionId: body.contentSessionId ?? null,
				agentId: body.agentId ?? null,
				agentType: body.agentType ?? null,
				platformSource,
				metadata: body.metadata ?? {},
			});
			return json(201, { session: serializeSession(session) });
		} catch (error) {
			// A concurrent start with the same externalSessionId can race past
			// the lookup and trip a platform-scoped unique index: answer with
			// the winner's row, never a spurious 500.
			if (body.externalSessionId && isUniqueConstraintError(error)) {
				const raced = await findExisting();
				if (raced) return json(200, { session: serializeSession(raced) });
			}
			throw error;
		}
	} catch (error) {
		return dbErrorResponse(error, 'session.write');
	}
}

/** Idempotently end the session and queue its summary job (one per session). */
export async function endSessionRoute(rc: RouteContext): Promise<Response> {
	const authz = await authorize(rc, ROUTE_SCOPES.sessionsWrite);
	if (authz instanceof Response) return authz;
	const id = rc.params.id ?? '';
	const projectId = await loadScopedProjectId(rc, authz, { id, table: 'server_sessions', notFound: 'Session not found' });
	if (projectId instanceof Response) return projectId;

	let result;
	try {
		result = await endSession(rc.env.DB, {
			sessionId: id,
			projectId,
			teamId: authz.teamId,
			apiKeyId: authz.auth.apiKeyId,
			actorId: authz.auth.actorId,
			sourceAdapter: 'api',
			requestId: rc.requestId,
		});
	} catch (error) {
		return dbErrorResponse(error, 'session.end');
	}
	if (!result.session) return errorResponse(404, 'NotFound', 'Session not found');

	let transport: 'enqueued' | 'skipped' = 'skipped';
	if (result.outbox && result.outbox.status === 'queued') {
		scheduleGeneration(rc.env, rc.ctx, result.outbox.id);
		transport = 'enqueued';
	}
	return json(200, {
		session: serializeSession(result.session),
		...(result.outbox ? { generationJob: serializeGenerationJob(result.outbox, transport) } : {}),
	});
}
