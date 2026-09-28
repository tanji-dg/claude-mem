import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

// Snapshot EAGERLY (see context-session-start.test.ts for why).
const realHookSettingsSnapshot = { ...realHookSettings };
const realOauthTokenSnapshot = { ...realOauthToken };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const workerCalls: unknown[][] = [];
let workerResponse: unknown = 'context from worker';
let workerIsFallback = false;
let settings: Record<string, string> = { CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false' };
let staleMarker: string | null = null;

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => settings,
}));

mock.module('../../../src/shared/oauth-token.js', () => ({ readStaleMarker: () => staleMarker }));

mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'repo-project',
    parent: null,
    isWorktree: false,
    allProjects: ['repo-project'],
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (...args: unknown[]) => {
    workerCalls.push(args);
    return workerResponse;
  },
  getWorkerPort: () => 37777,
  isWorkerFallback: () => workerIsFallback,
}));

import { logger } from '../../../src/utils/logger.js';
import { ServerClientError } from '../../../src/services/hooks/server-client.js';

const { contextHandler, setContextDependenciesForTesting } = await import('../../../src/cli/handlers/context.js');

interface InjectCall { projectId: string; platformSource?: string | null }
const injectCalls: InjectCall[] = [];
const fallbackLogs: Array<{ reason: string; details?: Record<string, unknown> }> = [];

function useServerRuntime(contextInject: (input: InjectCall) => Promise<string>): void {
  setContextDependenciesForTesting({
    resolveRuntimeContext: () => ({
      runtime: 'server',
      projectId: 'server-project-1',
      serverBaseUrl: 'http://server.test',
      client: {
        contextInject: async (input: InjectCall) => {
          injectCalls.push(input);
          return contextInject(input);
        },
      } as never,
    }),
    logServerFallback: (reason: string, details?: Record<string, unknown>) => {
      fallbackLogs.push({ reason, details });
    },
  });
}

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCalls.length = 0;
  injectCalls.length = 0;
  fallbackLogs.length = 0;
  workerResponse = 'context from worker';
  workerIsFallback = false;
  staleMarker = null;
  settings = { CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false' };
  setContextDependenciesForTesting();
  loggerSpies.forEach(spy => spy.mockRestore());
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterAll(() => {
  setContextDependenciesForTesting();
  loggerSpies.forEach(spy => spy.mockRestore());
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/oauth-token.js', () => realOauthTokenSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('contextHandler server runtime', () => {
  it('injects context from GET /v1/context/inject and skips the local worker', async () => {
    useServerRuntime(async () => '  # [p] recent context (server)\n- 2026-09-01 [discovery] thing\n');

    const result = await contextHandler.execute({ sessionId: 's', cwd: '/tmp/repo', platform: 'claude-code' });

    expect(injectCalls).toEqual([{ projectId: 'server-project-1', platformSource: 'claude' }]);
    expect(workerCalls).toEqual([]);
    expect(result.hookSpecificOutput?.additionalContext).toBe('# [p] recent context (server)\n- 2026-09-01 [discovery] thing');
    expect(result.systemMessage).toBeUndefined();
  });

  it('keeps the stale OAuth hint in server mode', async () => {
    staleMarker = 'expired';
    useServerRuntime(async () => 'server ctx');
    const result = await contextHandler.execute({ sessionId: 's', cwd: '/tmp/repo', platform: 'claude-code' });
    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx.startsWith('[claude-mem] Claude Desktop OAuth token is stale: expired')).toBe(true);
    expect(ctx.endsWith('server ctx')).toBe(true);
  });

  it('shows the plain server timeline as terminal output without the local viewer link', async () => {
    settings = { CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true' };
    useServerRuntime(async () => 'server ctx');
    const result = await contextHandler.execute({ sessionId: 's', cwd: '/tmp/repo', platform: 'claude-code' });
    expect(workerCalls).toEqual([]);
    expect(result.systemMessage?.startsWith('server ctx\n\n')).toBe(true);
    expect(result.systemMessage).not.toContain('localhost:37777');
  });

  it('returns an empty injection (not the worker) when the server returns empty', async () => {
    useServerRuntime(async () => '');
    const result = await contextHandler.execute({ sessionId: 's', cwd: '/tmp/repo', platform: 'codex' });
    expect(injectCalls[0]).toEqual({ projectId: 'server-project-1', platformSource: 'codex' });
    expect(workerCalls).toEqual([]);
    expect(result.hookSpecificOutput?.additionalContext).toBe('');
  });

  it('falls back to the local worker on fallback-eligible errors', async () => {
    useServerRuntime(async () => {
      throw new ServerClientError('http_error', 'unavailable', { status: 503 });
    });
    const result = await contextHandler.execute({ sessionId: 's', cwd: '/tmp/repo', platform: 'claude-code' });
    expect(fallbackLogs).toHaveLength(1);
    expect(fallbackLogs[0].reason).toBe('http_error');
    expect(fallbackLogs[0].details?.route).toBe('/v1/context/inject');
    expect(workerCalls).toEqual([[
      '/api/context/inject?projects=repo-project&platformSource=claude',
      'GET',
      undefined,
      undefined,
    ]]);
    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
  });

  it('falls back to the local worker on transport errors', async () => {
    useServerRuntime(async () => {
      throw new ServerClientError('transport', 'ECONNREFUSED');
    });
    const result = await contextHandler.execute({ sessionId: 's', cwd: '/tmp/repo', platform: 'claude-code' });
    expect(workerCalls).toHaveLength(1);
    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
  });

  it('returns the empty result on non-fallback-eligible errors', async () => {
    useServerRuntime(async () => {
      throw new ServerClientError('http_error', 'forbidden', { status: 403 });
    });
    const result = await contextHandler.execute({ sessionId: 's', cwd: '/tmp/repo', platform: 'claude-code' });
    expect(fallbackLogs).toEqual([]);
    expect(workerCalls).toEqual([]);
    expect(result.hookSpecificOutput?.additionalContext).toBe('');
    expect(result.systemMessage).toBeUndefined();
  });

  it('leaves worker mode unchanged, including the colored terminal timeline', async () => {
    settings = { CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true' };
    setContextDependenciesForTesting({ resolveRuntimeContext: () => ({ runtime: 'worker' }) });
    const result = await contextHandler.execute({ sessionId: 's', cwd: '/tmp/repo', platform: 'claude-code' });
    expect(injectCalls).toEqual([]);
    expect(workerCalls.map(c => c[0])).toEqual([
      '/api/context/inject?projects=repo-project&platformSource=claude',
      '/api/context/inject?projects=repo-project&platformSource=claude&colors=true',
    ]);
    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(result.systemMessage).toContain('View Observations Live @ http://localhost:37777');
  });
});
