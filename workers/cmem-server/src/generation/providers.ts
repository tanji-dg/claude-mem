// SPDX-License-Identifier: Apache-2.0
//
// Provider selection — port of buildServerGenerationProviderFromEnv /
// instantiateServerGenerationProvider / resolveServerMaxOutputTokens in
// src/server/runtime/create-server-service.ts. The three provider classes are
// the repo's own (plain fetch, no SDK), reused unchanged through the
// build/aliases.mjs bare aliases.
//
// Differences from the Node runtime, both deliberate:
//   - Config comes from the Worker `env` (vars + secrets), never process.env.
//   - CLAUDE_MEM_SERVER_PROVIDER defaults to `claude` (Node: unset ⇒ generation
//     disabled). The Worker exists to generate; the key is what gates it.
// A missing API key still disables generation (returns null): jobs stay
// `queued` and are picked up by the cron once the secret is set.

import { ClaudeObservationProvider } from '@claude-mem/claude-provider';
import type { ServerGenerationProvider } from '@claude-mem/generation-types';
import { GeminiObservationProvider } from '@claude-mem/gemini-provider';
import { OpenRouterObservationProvider } from '@claude-mem/openrouter-provider';

export type ProviderName = 'claude' | 'gemini' | 'openrouter';

export const DEFAULT_PROVIDER: ProviderName = 'claude';

/** Normalized CLAUDE_MEM_SERVER_PROVIDER (`anthropic` is an alias of `claude`); null if unknown. */
export function resolveProviderName(env: Env): ProviderName | null {
	const raw = (env.CLAUDE_MEM_SERVER_PROVIDER ?? '').trim().toLowerCase();
	if (!raw) return DEFAULT_PROVIDER;
	if (raw === 'claude' || raw === 'anthropic') return 'claude';
	if (raw === 'gemini' || raw === 'openrouter') return raw;
	return null;
}

/** Same rule as resolveServerMaxOutputTokens: a positive integer, else the provider default. */
export function resolveMaxOutputTokens(env: Env): number | undefined {
	const raw = (env.CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS ?? '').trim();
	if (!raw) return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		console.warn(JSON.stringify({ level: 'WARN', message: 'ignoring invalid CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS', value: raw }));
		return undefined;
	}
	return parsed;
}

/**
 * Build the configured provider, or null when generation is not configured
 * (unknown provider name or no API key for it). Never throws.
 */
export function buildProvider(env: Env): ServerGenerationProvider | null {
	const name = resolveProviderName(env);
	if (!name) {
		console.warn(JSON.stringify({ level: 'WARN', message: 'unknown CLAUDE_MEM_SERVER_PROVIDER; generation disabled', provider: env.CLAUDE_MEM_SERVER_PROVIDER }));
		return null;
	}
	const model = env.CLAUDE_MEM_SERVER_MODEL?.trim() || undefined;
	const maxOutputTokens = resolveMaxOutputTokens(env);
	const common = {
		// Bound wrapper: the providers store `fetch` and call it as a method
		// (this.fetchImpl(...)); workerd rejects the global fetch invoked with a
		// foreign `this` ("Illegal invocation").
		fetchImpl: ((input, init) => fetch(input, init)) as typeof fetch,
		...(model ? { model } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	};
	try {
		if (name === 'claude') {
			const apiKey = env.ANTHROPIC_API_KEY ?? env.CLAUDE_MEM_ANTHROPIC_API_KEY ?? '';
			return apiKey ? new ClaudeObservationProvider({ apiKey, ...common }) : missingKey(name);
		}
		if (name === 'gemini') {
			const apiKey = env.GEMINI_API_KEY ?? env.CLAUDE_MEM_GEMINI_API_KEY ?? '';
			return apiKey ? new GeminiObservationProvider({ apiKey, ...common }) : missingKey(name);
		}
		const apiKey = env.OPENROUTER_API_KEY ?? env.CLAUDE_MEM_OPENROUTER_API_KEY ?? '';
		if (!apiKey) return missingKey(name);
		const baseUrl = env.CLAUDE_MEM_OPENROUTER_BASE_URL ?? env.OPENROUTER_BASE_URL;
		return new OpenRouterObservationProvider({ apiKey, ...common, ...(baseUrl ? { baseUrl } : {}) });
	} catch (error) {
		console.warn(
			JSON.stringify({
				level: 'WARN',
				message: 'failed to construct generation provider; generation disabled',
				provider: name,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		return null;
	}
}

function missingKey(name: ProviderName): null {
	console.warn(JSON.stringify({ level: 'WARN', message: 'generation provider has no API key secret; jobs stay queued', provider: name }));
	return null;
}
