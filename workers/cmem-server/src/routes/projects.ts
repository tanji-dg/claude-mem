// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/projects/resolve — map a client-side project name (the name the
// local worker files memories under) to a server project in the key's team,
// creating it on first use. Lets one team-scoped key serve every local project
// instead of pinning all of them to CLAUDE_MEM_SERVER_PROJECT_ID.

import { z } from 'zod';
import { ROUTE_SCOPES } from '../auth';
import { errorResponse, json } from '../http';
import type { RouteContext } from '../router';
import { AuthRepository } from '../storage/auth';
import { authorize, parseBody } from './common';

const ResolveProjectSchema = z.object({
	name: z.string().trim().min(1).max(200),
});

export async function postResolveProject(rc: RouteContext): Promise<Response> {
	const authz = await authorize(rc, ROUTE_SCOPES.projectsResolve);
	if (authz instanceof Response) return authz;
	// A project-scoped key may only ever touch its own project.
	if (authz.auth.projectId) {
		return errorResponse(403, 'Forbidden', 'API key is scoped to one project; resolving projects needs a team-scoped key');
	}
	const parsed = await parseBody(rc, ResolveProjectSchema);
	if (parsed instanceof Response) return parsed;
	const { project, created } = await new AuthRepository(rc.env.DB).findOrCreateProjectByName(authz.teamId, parsed.data.name);
	return json(created ? 201 : 200, { project: { id: project.id, name: project.name }, created });
}
