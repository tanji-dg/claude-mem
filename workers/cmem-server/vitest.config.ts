/**
 * Vitest config — @cloudflare/vitest-pool-workers ≥0.18 Vite-plugin form (same
 * setup as workers/sync-hub). Tests import their APIs from "cloudflare:test".
 *
 * D1: migrations/ is read here (Node side) and applied inside the Workers
 * runtime by test/apply-migrations.ts (the standard readD1Migrations +
 * applyD1Migrations pattern).
 *
 * Module aliases: the `cmem-repo-modules` plugin applies build/aliases.mjs —
 * the SAME config scripts/build.mjs applies for `wrangler deploy` — so tests
 * run the bundle graph production runs (logger shim, recall MCP alias, bare
 * packages resolved from this package's node_modules).
 *
 * Outbound fetch: miniflare's `outboundService` intercepts every fetch the
 * Worker makes. Nothing in the core routes calls out; LLM provider mocks for
 * the generation tests belong in `mockOutbound`.
 */

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
// Plain .mjs shared with scripts/build.mjs (typed via allowJs).
import { BARE_ALIASES, PACKAGE_ROOT, REPO_ROOT, isBareSpecifier, isOutsidePackage, shimFor } from './build/aliases.mjs';

const aliases = BARE_ALIASES as Record<string, string>;

const repoModulesPlugin: Plugin = {
	name: 'cmem-repo-modules',
	enforce: 'pre',
	async resolveId(source, importer, options) {
		if (Object.hasOwn(aliases, source)) return aliases[source];
		if (!importer) return null;
		const importerPath = importer.split('?')[0]!;
		if (source.startsWith('.')) {
			return (shimFor(resolve(dirname(importerPath), source)) as string | null) ?? null;
		}
		// Repo files (outside this package) import zod / the MCP SDK; resolve
		// them as if imported from here, since the repo root may lack node_modules.
		if (isBareSpecifier(source) && isOutsidePackage(importerPath)) {
			return this.resolve(source, resolve(PACKAGE_ROOT, 'src/index.ts'), { ...options, skipSelf: true });
		}
		return null;
	},
};

async function mockOutbound(request: Request): Promise<Response> {
	return new Response(`unexpected outbound fetch in tests: ${request.method} ${request.url}`, { status: 599 });
}

export default defineConfig(async () => {
	const migrations = await readD1Migrations(resolve(PACKAGE_ROOT as string, 'migrations'));
	return {
		plugins: [
			repoModulesPlugin,
			cloudflareTest({
				// Source entry (wrangler.jsonc `main` points at the custom-build output).
				main: './src/index.ts',
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						CMEM_ADMIN_TOKEN: 'test-admin-token',
					},
					outboundService: mockOutbound,
				},
			}),
		],
		server: { fs: { allow: [REPO_ROOT as string] } },
		test: {
			setupFiles: ['./test/apply-migrations.ts'],
		},
	};
});
