// SPDX-License-Identifier: Apache-2.0
//
// Unauthenticated liveness/info routes (same shape as the Express runtime's
// ServerRuntimeInfoRoutes, minus the Postgres/BullMQ internals).

import { json } from '../http';
import type { RouteContext } from '../router';

const SERVER_RUNTIME = 'server-beta';

export function getHealthz(): Response {
	return json(200, { status: 'ok', runtime: SERVER_RUNTIME });
}

export function getInfo(rc: RouteContext): Response {
	return json(200, {
		name: 'claude-mem-server',
		runtime: SERVER_RUNTIME,
		platform: 'cloudflare-workers',
		authMode: 'api-key',
		storage: { kind: 'd1' },
		generation: {
			provider: rc.env.CLAUDE_MEM_SERVER_PROVIDER || 'claude',
			model: rc.env.CLAUDE_MEM_SERVER_MODEL || null,
			mode: rc.env.CLAUDE_MEM_MODE || 'code',
		},
	});
}
