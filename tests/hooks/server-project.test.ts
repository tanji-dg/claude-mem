// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ServerRuntimeContext } from '../../src/services/hooks/runtime-selector.js';
import { ServerClient, ServerClientError } from '../../src/services/hooks/server-client.js';
import {
  clearServerProjectMemoryCache,
  resolveServerProjectIdForName,
} from '../../src/services/hooks/server-project.js';

function runtime(overrides: Partial<ServerRuntimeContext> & { resolve?: (name: string) => Promise<string> }): {
  ctx: ServerRuntimeContext;
  calls: string[];
} {
  const calls: string[] = [];
  const client = new ServerClient({ serverBaseUrl: 'http://127.0.0.1:1', apiKey: 'k' });
  client.resolveProject = async (name: string) => {
    calls.push(name);
    const id = overrides.resolve ? await overrides.resolve(name) : `id-${name}`;
    return { project: { id, name }, created: false };
  };
  return {
    ctx: { runtime: 'server', client, projectId: null, serverBaseUrl: 'http://x', cacheScope: 'scope-a', ...overrides },
    calls,
  };
}

describe('resolveServerProjectIdForName', () => {
  let dataDir: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.CLAUDE_MEM_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'cmem-server-project-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    clearServerProjectMemoryCache();
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('uses the fixed project id without calling the server', async () => {
    const { ctx, calls } = runtime({ projectId: 'fixed' });
    expect(await resolveServerProjectIdForName(ctx, 'anything')).toBe('fixed');
    expect(calls).toEqual([]);
  });

  it('resolves once, then serves the memory cache and the file cache', async () => {
    const { ctx, calls } = runtime({});
    expect(await resolveServerProjectIdForName(ctx, 'kozekachi_ai')).toBe('id-kozekachi_ai');
    expect(await resolveServerProjectIdForName(ctx, 'kozekachi_ai')).toBe('id-kozekachi_ai');
    expect(calls).toEqual(['kozekachi_ai']);

    // A fresh hook process only has the file.
    clearServerProjectMemoryCache();
    expect(await resolveServerProjectIdForName(ctx, 'kozekachi_ai')).toBe('id-kozekachi_ai');
    expect(calls).toEqual(['kozekachi_ai']);
    const file = JSON.parse(readFileSync(join(dataDir, 'server-projects.json'), 'utf-8'));
    expect(file).toEqual({ 'scope-a': { kozekachi_ai: 'id-kozekachi_ai' } });
  });

  it('keeps separate caches per server + key', async () => {
    const a = runtime({ cacheScope: 'scope-a', resolve: async () => 'from-a' });
    const b = runtime({ cacheScope: 'scope-b', resolve: async () => 'from-b' });
    expect(await resolveServerProjectIdForName(a.ctx, 'p')).toBe('from-a');
    expect(await resolveServerProjectIdForName(b.ctx, 'p')).toBe('from-b');
  });

  it('propagates server errors and caches nothing', async () => {
    const { ctx } = runtime({
      resolve: async () => { throw new ServerClientError('http_error', 'forbidden', { status: 403 }); },
    });
    await expect(resolveServerProjectIdForName(ctx, 'p')).rejects.toBeInstanceOf(ServerClientError);
    expect(() => readFileSync(join(dataDir, 'server-projects.json'))).toThrow();
  });

  it('ignores a corrupt cache file', async () => {
    writeFileSync(join(dataDir, 'server-projects.json'), '{not json');
    const { ctx, calls } = runtime({});
    expect(await resolveServerProjectIdForName(ctx, 'p')).toBe('id-p');
    expect(calls).toEqual(['p']);
  });
});
