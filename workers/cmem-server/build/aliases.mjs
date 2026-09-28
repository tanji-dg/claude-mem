// SPDX-License-Identifier: Apache-2.0
//
// Single source of truth for how the Worker bundle reuses modules from the
// repo's root `src/` tree. Consumed by BOTH bundlers:
//   - scripts/build.mjs  (esbuild; what `wrangler deploy` / `wrangler dev` run)
//   - vitest.config.ts   (Vite; what vitest-pool-workers runs)
//
// Why not wrangler's built-in `alias`? It is esbuild's `alias`, which only
// matches bare package specifiers. The Node-bound modules we must replace are
// reached through RELATIVE imports inside the repo (e.g. recall-mcp-server.ts
// does `import { logger } from '../../utils/logger.js'`), so they can only be
// swapped after resolution, by absolute path — hence the tiny plugins below.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

const repo = (p) => resolve(REPO_ROOT, p);
const pkg = (p) => resolve(PACKAGE_ROOT, p);

/**
 * Repo modules replaced by Worker-safe shims, keyed by the absolute path of
 * the ORIGINAL module (as it resolves on disk). Add an entry to swap another
 * Node-bound module — both bundlers pick it up.
 *
 * Agent C: add `[repo('src/services/domain/ModeManager.ts')]: pkg('src/shims/mode-manager.ts')`.
 */
export const MODULE_SHIMS = {
	[repo('src/utils/logger.ts')]: pkg('src/shims/logger.ts'),
};

/**
 * Bare specifiers the Worker source imports instead of a relative path into
 * the repo, so `tsc` (which follows every relative import it sees) type-checks
 * against a hand-written declaration in src/types/repo-modules.d.ts rather
 * than walking into Node-only code. Bundlers map them to the real file.
 */
export const BARE_ALIASES = {
	'@claude-mem/recall-mcp-server': repo('src/server/mcp/recall-mcp-server.ts'),
};

/**
 * Candidate on-disk files for a relative import (`.js` specifiers are how the
 * repo's ESM TypeScript refers to `.ts` files).
 */
export function candidateFiles(absPath) {
	const out = [absPath];
	if (absPath.endsWith('.js')) out.push(`${absPath.slice(0, -3)}.ts`);
	else if (!/\.[cm]?[jt]s$/.test(absPath)) out.push(`${absPath}.ts`, `${absPath}/index.ts`);
	return out;
}

export function shimFor(absPath) {
	for (const candidate of candidateFiles(absPath)) {
		if (MODULE_SHIMS[candidate]) return MODULE_SHIMS[candidate];
	}
	return null;
}

/** True for files outside this package (i.e. reused from the repo's src/). */
export function isOutsidePackage(file) {
	return !file.startsWith(`${PACKAGE_ROOT}/`);
}

export function isBareSpecifier(spec) {
	return !spec.startsWith('.') && !spec.startsWith('/') && !spec.includes(':') && !spec.startsWith('\0');
}
