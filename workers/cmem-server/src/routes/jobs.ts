// SPDX-License-Identifier: Apache-2.0
//
// GET /v1/jobs/:id — generation job status, scoped to the key's team and
// project. A sibling project's job answers 404 (not 403), as on Express, so
// job ids never disclose other projects.

import { ROUTE_SCOPES } from '../auth';
import { errorResponse, json } from '../http';
import type { RouteContext } from '../router';
import { GenerationJobsRepository } from '../storage/generation-jobs';
import { authorize, loadScopedProjectId } from './common';
import { serializeGenerationJobStatus } from './serializers';

export async function getJob(rc: RouteContext): Promise<Response> {
	const authz = await authorize(rc, ROUTE_SCOPES.jobsRead);
	if (authz instanceof Response) return authz;
	const id = rc.params.id ?? '';
	const notFound = 'Generation job not found';
	const projectId = await loadScopedProjectId(rc, authz, { id, table: 'observation_generation_jobs', notFound, scopeMismatch: 'not-found' });
	if (projectId instanceof Response) return projectId;
	const job = await new GenerationJobsRepository(rc.env.DB).getByIdForScope({ id, projectId, teamId: authz.teamId });
	if (!job) return errorResponse(404, 'NotFound', notFound);
	return json(200, { generationJob: serializeGenerationJobStatus(job) });
}
