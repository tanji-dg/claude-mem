/**
 * Secret bindings — set via `wrangler secret put <NAME>`, deliberately NOT
 * declared in wrangler.jsonc vars (a var and a secret share one namespace, so
 * a committed var would shadow the secret). `wrangler types` only generates
 * config-declared bindings, so secrets are typed here via global interface
 * merging with the generated `Env` (worker-configuration.d.ts). All optional:
 * only the key for the configured CLAUDE_MEM_SERVER_PROVIDER is required.
 */
interface Env {
	/** Claude provider (CLAUDE_MEM_SERVER_PROVIDER=claude). */
	ANTHROPIC_API_KEY?: string;
	/** Gemini provider (CLAUDE_MEM_SERVER_PROVIDER=gemini). */
	GEMINI_API_KEY?: string;
	/** OpenRouter provider (CLAUDE_MEM_SERVER_PROVIDER=openrouter). */
	OPENROUTER_API_KEY?: string;
	/**
	 * Operator token for POST /v1/admin/bootstrap. When unset the route answers
	 * 404, so a fresh deploy exposes no admin surface until you opt in.
	 */
	CMEM_ADMIN_TOKEN?: string;
}
