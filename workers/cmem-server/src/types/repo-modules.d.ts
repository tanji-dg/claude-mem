/**
 * Type surface of repo modules the Worker imports through a bare alias
 * (build/aliases.mjs BARE_ALIASES). tsc would otherwise follow the real file's
 * relative imports into Node-only code (fs, path, …) that the bundlers replace
 * with shims but the type checker cannot. Keep in sync with the source file
 * named on each `declare module`.
 */

// src/server/mcp/recall-mcp-server.ts
declare module '@claude-mem/recall-mcp-server' {
	import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
	import type { Tool } from '@modelcontextprotocol/sdk/types.js';

	export interface RecallBackend {
		search(args: { projectId: string; query: string; limit: number }): Promise<unknown[]>;
		context(args: { projectId: string; query: string; limit: number }): Promise<unknown[]>;
		recent(args: { projectId: string; limit: number }): Promise<unknown[]>;
	}

	export function createRecallMcpServer(backend: RecallBackend, version: string): Server;
	export const RECALL_MCP_TOOLS: Tool[];
}
