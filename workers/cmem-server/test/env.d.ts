/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Test-only bindings supplied by vitest.config.ts (miniflare.bindings).
declare namespace Cloudflare {
	interface Env {
		TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
		TEST_MODE_IDS: string[];
	}
}
