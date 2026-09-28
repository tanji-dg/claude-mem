import { describe, expect, it } from 'vitest';
// Resolved through the alias config: this relative import of the repo logger
// must land on the Worker shim (proves build/aliases.mjs is applied).
import { logger } from '../../../src/utils/logger';
import { api, bootstrap } from './helpers';

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };

async function rpc(key: string, method: string, params: Record<string, unknown> = {}, id = 1) {
	const res = await api('POST', '/v1/mcp', key, { jsonrpc: '2.0', id, method, params }, MCP_HEADERS);
	expect(res.status).toBe(200);
	return (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
}

describe('module aliases', () => {
	it('swaps src/utils/logger.ts for the Worker shim', () => {
		expect(logger.constructor.name).toBe('WorkerLogger');
	});
});

describe('/v1/mcp (streamable HTTP, stateless)', () => {
	it('requires auth', async () => {
		const res = await api('POST', '/v1/mcp', null, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, MCP_HEADERS);
		expect(res.status).toBe(401);
	});

	it('initializes and lists the recall tools', async () => {
		const t = await bootstrap();
		const init = await rpc(t.apiKey, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'test', version: '0' },
		});
		expect(init.result).toMatchObject({ serverInfo: { name: 'claude-mem' }, capabilities: { tools: {} } });

		const list = await rpc(t.apiKey, 'tools/list');
		const names = (list.result!.tools as { name: string }[]).map((tool) => tool.name).sort();
		expect(names).toEqual(['context', 'recent', 'search']);
	});

	it('tools/call search and recent read D1 within the key scope', async () => {
		const t = await bootstrap();
		const add = await api('POST', '/v1/memories', t.apiKey, { projectId: t.projectId, content: 'MCP recall over workers' });
		const { memory } = (await add.json()) as { memory: { id: string } };

		const search = await rpc(t.apiKey, 'tools/call', { name: 'search', arguments: { projectId: t.projectId, query: 'recall workers' } });
		const content = search.result!.content as { type: string; text: string }[];
		const payload = JSON.parse(content[0]!.text) as { observations: { id: string }[] };
		expect(payload.observations.map((o) => o.id)).toEqual([memory.id]);

		const hostile = await rpc(t.apiKey, 'tools/call', { name: 'search', arguments: { projectId: t.projectId, query: '"foo AND (' } });
		expect(hostile.result!.isError).toBeUndefined();

		const recent = await rpc(t.apiKey, 'tools/call', { name: 'recent', arguments: { projectId: t.projectId } });
		expect(JSON.parse((recent.result!.content as { text: string }[])[0]!.text).observations).toHaveLength(1);

		const foreign = await rpc(t.apiKey, 'tools/call', { name: 'search', arguments: { projectId: 'other', query: 'x' } });
		expect(foreign.result).toMatchObject({ isError: true });
	});
});
