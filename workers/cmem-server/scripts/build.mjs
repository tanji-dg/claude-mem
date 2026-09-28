// SPDX-License-Identifier: Apache-2.0
//
// Custom build for `wrangler deploy` / `wrangler dev` (wrangler.jsonc `build`).
// Bundles src/index.ts with esbuild, applying the shared alias config in
// build/aliases.mjs, into dist/index.js; wrangler then uploads that file.
//
// Two things wrangler's own bundler cannot do (see build/aliases.mjs):
//   1. swap repo modules reached by RELATIVE imports (logger → shim);
//   2. resolve bare packages (zod, @modelcontextprotocol/sdk) imported by files
//      under the repo's root src/ from THIS package's node_modules, so the
//      Worker builds without installing the root package's dependencies.

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BARE_ALIASES, PACKAGE_ROOT, shimFor } from '../build/aliases.mjs';

/** @type {import('esbuild').Plugin} */
const repoModulesPlugin = {
	name: 'cmem-repo-modules',
	setup(b) {
		b.onResolve({ filter: /.*/ }, (args) => {
			if (Object.hasOwn(BARE_ALIASES, args.path)) {
				return { path: BARE_ALIASES[args.path] };
			}
			if (args.path.startsWith('.') && args.importer) {
				const shim = shimFor(resolve(dirname(args.importer), args.path));
				if (shim) return { path: shim };
			}
			return undefined;
		});
	},
};

const outfile = resolve(PACKAGE_ROOT, 'dist/index.js');

await build({
	entryPoints: [resolve(PACKAGE_ROOT, 'src/index.ts')],
	outfile,
	bundle: true,
	format: 'esm',
	target: 'es2024',
	platform: 'neutral',
	mainFields: ['module', 'main'],
	conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
	// Bare imports from files outside this package fall back to our own
	// node_modules (the repo root may have no node_modules at all).
	nodePaths: [resolve(PACKAGE_ROOT, 'node_modules')],
	external: ['cloudflare:*', 'node:*'],
	minify: true,
	sourcemap: true,
	logLevel: 'warning',
	plugins: [repoModulesPlugin],
});

if (!existsSync(outfile)) {
	throw new Error(`build did not produce ${outfile}`);
}
