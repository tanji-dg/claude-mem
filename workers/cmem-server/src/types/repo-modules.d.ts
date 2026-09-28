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

// ─── Observation generation (src/generation/*) ──────────────────────────────
// Structural stand-ins for the Postgres row types the providers are typed
// against (PostgresAgentEvent / PostgresObservationGenerationJob); the D1
// AgentEvent / ObservationGenerationJob shapes satisfy them.

declare module '@claude-mem/generation-types' {
	export interface GenerationAgentEvent {
		readonly id: string;
		readonly eventType: string;
		readonly sourceAdapter: string;
		readonly occurredAtEpoch: number;
		readonly payload: unknown;
	}

	export interface GenerationJobRef {
		readonly id: string;
		readonly sourceType: 'agent_event' | 'session_summary' | 'observation_reindex';
	}

	// src/server/generation/providers/shared/types.ts
	export interface ServerGenerationContext {
		readonly job: GenerationJobRef;
		readonly events: readonly GenerationAgentEvent[];
		readonly project: {
			readonly projectId: string;
			readonly teamId: string;
			readonly serverSessionId: string | null;
			readonly projectName?: string | null;
		};
	}

	export interface ServerGenerationResult {
		readonly rawText: string;
		readonly tokensUsed?: number;
		readonly providerLabel: string;
		readonly modelId?: string;
	}

	export interface ServerGenerationProvider {
		readonly providerLabel: 'claude' | 'gemini' | 'openrouter';
		generate(context: ServerGenerationContext, signal?: AbortSignal): Promise<ServerGenerationResult>;
	}
}

// src/server/generation/providers/ClaudeObservationProvider.ts
declare module '@claude-mem/claude-provider' {
	import type { ServerGenerationContext, ServerGenerationProvider, ServerGenerationResult } from '@claude-mem/generation-types';

	export const DEFAULT_SERVER_CLAUDE_MODEL: string;
	export interface ClaudeObservationProviderOptions {
		apiKey: string;
		model?: string;
		maxOutputTokens?: number;
		fetchImpl?: typeof fetch;
	}
	export class ClaudeObservationProvider implements ServerGenerationProvider {
		readonly providerLabel: 'claude';
		constructor(options: ClaudeObservationProviderOptions);
		generate(context: ServerGenerationContext, signal?: AbortSignal): Promise<ServerGenerationResult>;
	}
}

// src/server/generation/providers/GeminiObservationProvider.ts
declare module '@claude-mem/gemini-provider' {
	import type { ServerGenerationContext, ServerGenerationProvider, ServerGenerationResult } from '@claude-mem/generation-types';

	export interface GeminiObservationProviderOptions {
		apiKey: string;
		model?: string;
		maxOutputTokens?: number;
		fetchImpl?: typeof fetch;
	}
	export class GeminiObservationProvider implements ServerGenerationProvider {
		readonly providerLabel: 'gemini';
		constructor(options: GeminiObservationProviderOptions);
		generate(context: ServerGenerationContext, signal?: AbortSignal): Promise<ServerGenerationResult>;
	}
}

// src/server/generation/providers/OpenRouterObservationProvider.ts
declare module '@claude-mem/openrouter-provider' {
	import type { ServerGenerationContext, ServerGenerationProvider, ServerGenerationResult } from '@claude-mem/generation-types';

	export interface OpenRouterObservationProviderOptions {
		apiKey: string;
		model?: string;
		baseUrl?: string;
		maxOutputTokens?: number;
		siteUrl?: string;
		appName?: string;
		fetchImpl?: typeof fetch;
	}
	export class OpenRouterObservationProvider implements ServerGenerationProvider {
		readonly providerLabel: 'openrouter';
		constructor(options: OpenRouterObservationProviderOptions);
		generate(context: ServerGenerationContext, signal?: AbortSignal): Promise<ServerGenerationResult>;
	}
}

// src/server/generation/providers/shared/prompt-builder.ts
declare module '@claude-mem/prompt-builder' {
	import type { GenerationAgentEvent, ServerGenerationContext } from '@claude-mem/generation-types';

	export interface BuildServerPromptResult {
		readonly prompt: string;
		readonly hadPrivateContent: boolean;
		readonly skippedAll: boolean;
	}
	export function buildServerGenerationPrompt(context: ServerGenerationContext, options?: { mode?: unknown }): BuildServerPromptResult;
	export function eventBlockBytes(event: GenerationAgentEvent): number;
}

// src/sdk/parser.ts
declare module '@claude-mem/agent-xml-parser' {
	export interface ParsedObservation {
		type: string;
		title: string | null;
		subtitle: string | null;
		facts: string[];
		narrative: string | null;
		concepts: string[];
		files_read: string[];
		files_modified: string[];
	}
	export interface ParsedSummary {
		request: string | null;
		investigated: string | null;
		learned: string | null;
		completed: string | null;
		next_steps: string | null;
		notes: string | null;
		skipped?: boolean;
		skip_reason?: string | null;
	}
	export type ParseResult = { valid: true; observations: ParsedObservation[]; summary: ParsedSummary | null } | { valid: false };
	export function parseAgentXml(raw: string, correlationId?: string | number): ParseResult;
}

// src/server/jobs/types.ts
declare module '@claude-mem/server-job-types' {
	interface ServerGenerationJob {
		kind: 'event' | 'summary';
		team_id: string;
		project_id: string;
		source_type: 'agent_event' | 'session_summary' | 'observation_reindex';
		source_id: string;
		generation_job_id: string;
		api_key_id: string | null;
		actor_id: string | null;
		source_adapter: string;
		request_id?: string | null;
	}
	export interface GenerateObservationsForEventJob extends ServerGenerationJob {
		kind: 'event';
		agent_event_id: string;
	}
	export interface GenerateSessionSummaryJob extends ServerGenerationJob {
		kind: 'summary';
		server_session_id: string;
	}
	export type ServerGenerationJobPayload = GenerateObservationsForEventJob | GenerateSessionSummaryJob;
	export class ServerGenerationJobPayloadValidationError extends Error {
		readonly issues: Array<{ message: string; path: PropertyKey[] }>;
	}
	export function assertServerGenerationJobPayload(candidate: unknown): ServerGenerationJobPayload;
}

// src/utils/tag-stripping.ts
declare module '@claude-mem/tag-stripping' {
	export function stripTags(input: string): { stripped: string; counts: Record<string, number> };
}
