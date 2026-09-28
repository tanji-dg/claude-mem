// SPDX-License-Identifier: Apache-2.0
//
// cmem-server — the claude-mem server runtime (`CLAUDE_MEM_RUNTIME=server`)
// as a single Cloudflare Worker on the Free plan: D1 for storage, the
// observation_generation_jobs table as the queue, a 1/min cron for retries.
//
// Wire-compatible with the Express runtime's /v1 routes
// (src/server/routes/v1/ServerV1PostgresRoutes.ts) that the hooks client
// (src/services/hooks/server-client.ts) and MCP clients use.

import { runDueJobs } from './generation/runner';
import { errorResponse } from './http';
import { Router } from './router';
import { postAdminBootstrap } from './routes/admin';
import { postEvent, postEventsBatch } from './routes/events';
import { getJob } from './routes/jobs';
import { handleMcp } from './routes/mcp';
import { deleteMemory, getContextInject, postContext, postMemory, postSearch } from './routes/memories';
import { getHealthz, getInfo } from './routes/meta';
import { endSessionRoute, startSession } from './routes/sessions';

export const router = new Router()
	.on('GET', '/healthz', getHealthz)
	.on('GET', '/v1/info', getInfo)
	.on('POST', '/v1/admin/bootstrap', postAdminBootstrap)
	.on('POST', '/v1/sessions/start', startSession)
	.on('POST', '/v1/sessions/:id/end', endSessionRoute)
	.on('POST', '/v1/events', postEvent)
	.on('POST', '/v1/events/batch', postEventsBatch)
	.on('POST', '/v1/memories', postMemory)
	.on('DELETE', '/v1/memories/:id', deleteMemory)
	.on('POST', '/v1/search', postSearch)
	.on('POST', '/v1/context', postContext)
	.on('GET', '/v1/context/inject', getContextInject)
	.on('GET', '/v1/jobs/:id', getJob)
	.on(['POST', 'GET'], '/v1/mcp', handleMcp);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		try {
			return await router.handle(request, env, ctx);
		} catch (error) {
			console.error(JSON.stringify({ level: 'ERROR', message: 'unhandled route error', error: error instanceof Error ? error.stack : String(error) }));
			return errorResponse(500, 'InternalError', 'Unexpected server error');
		}
	},

	async scheduled(_controller, env, ctx): Promise<void> {
		await runDueJobs(env, ctx);
	},
} satisfies ExportedHandler<Env>;
