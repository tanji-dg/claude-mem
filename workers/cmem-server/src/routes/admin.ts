// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/admin/bootstrap — first-run setup for a fresh deployment. Creates a
// team, a project and a project-scoped API key with memories:read +
// memories:write, returning the raw key ONCE (only its SHA-256 is stored).
//
// Gated by the CMEM_ADMIN_TOKEN secret (constant-time compare). With the
// secret unset the route answers 404, so a deploy exposes no admin surface
// until the operator opts in.

import { z } from 'zod';
import { hashApiKey, parseBearerToken, timingSafeEqualStrings } from '../auth';
import { errorResponse, json, readJsonBody, validationError } from '../http';
import type { RouteContext } from '../router';
import { AuthRepository } from '../storage/auth';
import { newId } from '../storage/utils';

const BootstrapSchema = z.object({
	teamName: z.string().trim().min(1).max(200).optional(),
	projectName: z.string().trim().min(1).max(200).optional(),
	// "team" mints a key with no project, for clients that resolve one project
	// per local name through POST /v1/projects/resolve.
	keyScope: z.enum(['project', 'team']).optional(),
});

export const BOOTSTRAP_KEY_SCOPES = ['memories:read', 'memories:write'] as const;

export async function postAdminBootstrap(rc: RouteContext): Promise<Response> {
	const adminToken = rc.env.CMEM_ADMIN_TOKEN ?? '';
	if (!adminToken) return errorResponse(404, 'NotFound');
	const presented = parseBearerToken(rc.request.headers.get('Authorization'));
	if (!presented) return errorResponse(401, 'Unauthorized', 'Missing admin token (Authorization: Bearer <CMEM_ADMIN_TOKEN>)');
	if (!(await timingSafeEqualStrings(presented, adminToken))) return errorResponse(403, 'Forbidden', 'Invalid admin token');

	const body = await readJsonBody(rc.request);
	if (!body.ok) return body.response;
	const parsed = BootstrapSchema.safeParse(body.value);
	if (!parsed.success) return validationError(parsed.error.issues);

	const teamId = newId();
	const projectId = parsed.data.keyScope === 'team' ? null : newId();
	const apiKey = generateApiKey();
	const repo = new AuthRepository(rc.env.DB);
	// One batch = one transaction: never a team without its key.
	await rc.env.DB.batch([
		repo.createTeamStatement({ id: teamId, name: parsed.data.teamName ?? 'default' }),
		...(projectId ? [repo.createProjectStatement({ id: projectId, teamId, name: parsed.data.projectName ?? 'default' })] : []),
		repo.createApiKeyStatement({
			keyHash: await hashApiKey(apiKey),
			teamId,
			projectId,
			actorId: 'system:admin-bootstrap',
			scopes: [...BOOTSTRAP_KEY_SCOPES],
		}),
		repo.createAuditLogStatement({
			teamId,
			projectId,
			actorId: 'system:admin-bootstrap',
			action: 'api_key.bootstrap',
			resourceType: 'api_key',
			details: { requestId: rc.requestId },
		}),
	]);
	return json(201, { teamId, projectId, apiKey, scopes: BOOTSTRAP_KEY_SCOPES });
}

/** `cmem_` + 32 random bytes as hex. */
function generateApiKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `cmem_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
