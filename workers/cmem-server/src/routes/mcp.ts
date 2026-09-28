// SPDX-License-Identifier: Apache-2.0
//
// POST|GET /v1/mcp — the remote recall MCP endpoint ("secure MCP link"):
//   claude mcp add --transport http claude-mem <base>/v1/mcp \
//     --header "Authorization: Bearer <key>"
//
// Reuses createRecallMcpServer from src/server/mcp/recall-mcp-server.ts (via
// the '@claude-mem/recall-mcp-server' alias, see build/aliases.mjs) with a
// D1-backed RecallBackend, served by the MCP SDK's Web-standard streamable
// HTTP transport in stateless mode: one server + transport per request, bound
// to this key's team (and project scope, when the key has one).

import { createRecallMcpServer, type RecallBackend } from '@claude-mem/recall-mcp-server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ROUTE_SCOPES } from '../auth';
import type { RouteContext } from '../router';
import { ObservationRepository } from '../storage/observations';
import { authorize } from './common';
import { serializeObservation } from './serializers';

export const MCP_SERVER_VERSION = '0.0.0-workers';

export async function handleMcp(rc: RouteContext): Promise<Response> {
	const authz = await authorize(rc, ROUTE_SCOPES.observationsRead);
	if (authz instanceof Response) return authz;
	const { teamId } = authz;
	const projectScope = authz.auth.projectId;
	const repo = new ObservationRepository(rc.env.DB);
	const assertProjectAllowed = (projectId: string): void => {
		if (projectScope && projectScope !== projectId) {
			throw new Error('API key is scoped to a different project');
		}
	};
	const backend: RecallBackend = {
		search: async ({ projectId, query, limit }) => {
			assertProjectAllowed(projectId);
			return (await repo.search({ projectId, teamId, query, limit })).map(serializeObservation);
		},
		context: async ({ projectId, query, limit }) => {
			assertProjectAllowed(projectId);
			return (await repo.search({ projectId, teamId, query, limit })).map(serializeObservation);
		},
		recent: async ({ projectId, limit }) => {
			assertProjectAllowed(projectId);
			return (await repo.listByProject({ projectId, teamId, limit })).map(serializeObservation);
		},
	};

	const server = createRecallMcpServer(backend, MCP_SERVER_VERSION);
	// JSON responses (not SSE) for POST: every recall tool answers in one shot.
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(rc.request);
	} finally {
		rc.ctx.waitUntil(Promise.allSettled([transport.close(), server.close()]));
	}
}
