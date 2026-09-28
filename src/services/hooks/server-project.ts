// SPDX-License-Identifier: Apache-2.0
//
// Server project for a hook call. With CLAUDE_MEM_SERVER_PROJECT_ID set every
// call uses that one project (the original behavior). Without it, each local
// project name — the same name the local worker files memories under,
// getProjectContext(cwd).primary — maps to its own server project, found or
// created through POST /v1/projects/resolve with a team-scoped key.
//
// Resolved ids are cached per server + key in <DATA_DIR>/server-projects.json
// so steady-state hooks skip the extra round trip.

import { existsSync } from 'fs';
import { join } from 'path';
import { readJsonFileWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { resolveDataDir } from '../../shared/paths.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import type { ServerRuntimeContext } from './runtime-selector.js';

type ProjectCache = Record<string, Record<string, string>>;

const memoryCache = new Map<string, string>();

/** Test hook: forget ids cached in this process. */
export function clearServerProjectMemoryCache(): void {
  memoryCache.clear();
}

function cachePath(): string {
  return join(resolveDataDir(), 'server-projects.json');
}

function readCache(): ProjectCache {
  try {
    return existsSync(cachePath()) ? readJsonFileWithBom<ProjectCache>(cachePath()) : {};
  } catch (error) {
    logger.debug('HOOK', 'server project cache unreadable; resolving again', {}, error as Error);
    return {};
  }
}

function writeCache(scope: string, name: string, id: string): void {
  try {
    const cache = readCache();
    cache[scope] = { ...(cache[scope] ?? {}), [name]: id };
    writeJsonFileAtomic(cachePath(), cache);
  } catch (error) {
    // A lost cache entry only costs one more resolve on the next hook.
    logger.debug('HOOK', 'server project cache write failed', {}, error as Error);
  }
}

/** Server project name for a hook's cwd (matches the local worker's project). */
export function serverProjectName(cwd: string): string {
  return getProjectContext(cwd).primary;
}

/**
 * Throws ServerClientError when resolving fails (e.g. 403 for a
 * project-scoped key); callers treat that like any other server error.
 */
export async function resolveServerProjectId(runtime: ServerRuntimeContext, cwd: string): Promise<string> {
  if (runtime.projectId) return runtime.projectId;
  return resolveServerProjectIdForName(runtime, serverProjectName(cwd));
}

/** Same as resolveServerProjectId, for callers that already hold the local project name. */
export async function resolveServerProjectIdForName(runtime: ServerRuntimeContext, name: string): Promise<string> {
  if (runtime.projectId) return runtime.projectId;
  const key = `${runtime.cacheScope}\n${name}`;
  const cached = memoryCache.get(key) ?? readCache()[runtime.cacheScope]?.[name];
  if (cached) {
    memoryCache.set(key, cached);
    return cached;
  }
  const { project } = await runtime.client.resolveProject(name);
  memoryCache.set(key, project.id);
  writeCache(runtime.cacheScope, name, project.id);
  return project.id;
}
