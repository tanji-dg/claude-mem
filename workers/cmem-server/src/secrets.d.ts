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
	/** Fallback names accepted by the Node runtime (create-server-service.ts). */
	CLAUDE_MEM_ANTHROPIC_API_KEY?: string;
	CLAUDE_MEM_GEMINI_API_KEY?: string;
	CLAUDE_MEM_OPENROUTER_API_KEY?: string;
	/**
	 * Optional OpenAI-compatible base URL for the openrouter provider (e.g.
	 * https://api.deepseek.com). Secret or `--var`; unset ⇒ openrouter.ai.
	 */
	CLAUDE_MEM_OPENROUTER_BASE_URL?: string;
	OPENROUTER_BASE_URL?: string;
	/** Session-summary input cap in bytes (default 600000), as on the Node runtime. */
	CLAUDE_MEM_SUMMARY_INPUT_BUDGET_BYTES?: string;
	/**
	 * Operator token for POST /v1/admin/bootstrap. When unset the route answers
	 * 404, so a fresh deploy exposes no admin surface until you opt in.
	 */
	CMEM_ADMIN_TOKEN?: string;
}
