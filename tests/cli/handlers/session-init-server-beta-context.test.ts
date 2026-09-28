import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const originalInternalEnv = process.env.CLAUDE_MEM_INTERNAL;

const serverBetaCalls: {
  startSession: unknown[];
  contextObservations: unknown[];
} = {
  startSession: [],
  contextObservations: [],
};

let workerFallbackCalled = false;

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({
      CLAUDE_MEM_EXCLUDED_PROJECTS: '',
      CLAUDE_MEM_RUNTIME: 'server',
      CLAUDE_MEM_SEMANTIC_INJECT: 'true',
      CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
    }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_RUNTIME: 'server',
    CLAUDE_MEM_SEMANTIC_INJECT: 'true',
    CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async () => {
    workerFallbackCalled = true;
    throw new Error('worker fallback should not be called in server-beta success path');
  },
  isWorkerFallback: () => false,
}));

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  resolveRuntimeContext: () => ({
    runtime: 'server',
    projectId: 'server-project-1',
    serverBaseUrl: 'http://server.test',
    client: {
      startSession: async (input: unknown) => {
        serverBetaCalls.startSession.push(input);
        return { session: { id: 'server-session-1' } };
      },
      contextObservations: async (input: unknown) => {
        serverBetaCalls.contextObservations.push(input);
        return {
          observations: [{ id: 'obs-1', projectId: 'server-project-1', content: 'context' }],
          context: 'server beta semantic context',
        };
      },
    },
  }),
  logServerFallback: () => {},
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  delete process.env.CLAUDE_MEM_INTERNAL;
  workerFallbackCalled = false;
  serverBetaCalls.startSession.length = 0;
  serverBetaCalls.contextObservations.length = 0;
  loggerSpies.forEach(spy => spy.mockRestore());
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
  ];
});

afterAll(() => {
  if (originalInternalEnv === undefined) {
    delete process.env.CLAUDE_MEM_INTERNAL;
  } else {
    process.env.CLAUDE_MEM_INTERNAL = originalInternalEnv;
  }
  loggerSpies.forEach(spy => spy.mockRestore());
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

interface ScenarioOptions {
  semanticInject?: string;
  prompt: string;
  contextObservationsBody?: string;
  startSessionBody?: string;
  assertions: string;
}

function runScenario(options: ScenarioOptions) {
  const env = { ...process.env };
  delete env.CLAUDE_MEM_INTERNAL;
  const script = `
    const serverCalls = { startSession: [], contextObservations: [] };
    const fallbacks = [];
    let workerFallbackCalled = false;
    const { ServerClientError } = await import('./src/services/hooks/server-client.ts');
    const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
    setSessionInitDependenciesForTesting({
      loadFromFileOnce: () => ({
        CLAUDE_MEM_EXCLUDED_PROJECTS: '',
        CLAUDE_MEM_RUNTIME: 'server',
        CLAUDE_MEM_SEMANTIC_INJECT: ${JSON.stringify(options.semanticInject ?? 'true')},
        CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
      }),
      resolveRuntimeContext: () => ({
        runtime: 'server',
        projectId: 'server-project-1',
        serverBaseUrl: 'http://server.test',
        client: {
          startSession: async (input) => {
            serverCalls.startSession.push(input);
            ${options.startSessionBody ?? "return { session: { id: 'server-session-1' } };"}
          },
          contextObservations: async (input) => {
            serverCalls.contextObservations.push(input);
            ${options.contextObservationsBody ?? "return { observations: [{ id: 'o1' }], context: 'server semantic context' };"}
          },
        },
      }),
      shouldTrackProject: () => true,
      executeWithWorkerFallback: async () => {
        workerFallbackCalled = true;
        return { continue: true };
      },
      isWorkerFallback: () => true,
      logServerFallback: (reason, details) => { fallbacks.push({ reason, details }); },
    });
    const result = await sessionInitHandler.execute({
      sessionId: 'session-server-context',
      cwd: '/tmp/session-init-server-context-test',
      platform: 'Cursor CLI',
      prompt: ${JSON.stringify(options.prompt)},
    });
    const fail = (msg) => { throw new Error(msg + ' | result=' + JSON.stringify(result) + ' calls=' + JSON.stringify(serverCalls) + ' fallbacks=' + JSON.stringify(fallbacks)); };
    if (!result.continue) fail('continue must be true');
    ${options.assertions}
  `;

  const result = Bun.spawnSync({
    cmd: [process.execPath, '--eval', script],
    cwd: process.cwd(),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(new TextDecoder().decode(result.stderr)).toBe('');
  expect(new TextDecoder().decode(result.stdout)).toBe('');
  expect(result.exitCode).toBe(0);
}

const LONG_PROMPT = 'Please restore platform-aware context for this Cursor session.';

describe('sessionInitHandler server semantic injection', () => {
  it('starts the server session and injects /v1/context semantic context', () => {
    runScenario({
      prompt: LONG_PROMPT,
      assertions: `
        if (workerFallbackCalled) fail('worker fallback was called');
        if (serverCalls.startSession.length !== 1) fail('startSession count mismatch');
        const start = serverCalls.startSession[0];
        if (start.projectId !== 'server-project-1' || start.externalSessionId !== 'session-server-context' || start.contentSessionId !== 'session-server-context' || start.platformSource !== 'cursor') {
          fail('startSession body mismatch');
        }
        if (serverCalls.contextObservations.length !== 1) fail('contextObservations should be called once');
        const ctx = serverCalls.contextObservations[0];
        if (ctx.projectId !== 'server-project-1' || ctx.query !== ${JSON.stringify(LONG_PROMPT)} || ctx.limit !== 7 || ctx.platformSource !== 'cursor') {
          fail('contextObservations body mismatch');
        }
        if (!result.suppressOutput) fail('suppressOutput expected');
        if (result.hookSpecificOutput?.hookEventName !== 'UserPromptSubmit') fail('hookEventName mismatch');
        if (result.hookSpecificOutput?.additionalContext !== 'server semantic context') fail('additionalContext mismatch');
      `,
    });
  });

  it('skips semantic injection when CLAUDE_MEM_SEMANTIC_INJECT is false', () => {
    runScenario({
      prompt: LONG_PROMPT,
      semanticInject: 'false',
      assertions: `
        if (serverCalls.startSession.length !== 1) fail('startSession expected');
        if (serverCalls.contextObservations.length !== 0) fail('contextObservations should not be called');
        if (result.hookSpecificOutput) fail('no additionalContext expected');
        if (workerFallbackCalled) fail('worker fallback was called');
      `,
    });
  });

  it('skips semantic injection for short prompts', () => {
    runScenario({
      prompt: 'short prompt',
      assertions: `
        if (serverCalls.contextObservations.length !== 0) fail('contextObservations should not be called');
        if (result.hookSpecificOutput) fail('no additionalContext expected');
      `,
    });
  });

  it('fails open when /v1/context returns a transient error', () => {
    runScenario({
      prompt: LONG_PROMPT,
      contextObservationsBody: "throw new ServerClientError('http_error', 'boom', { status: 503 });",
      assertions: `
        if (serverCalls.contextObservations.length !== 1) fail('contextObservations expected');
        if (result.hookSpecificOutput) fail('no additionalContext expected');
        if (workerFallbackCalled) fail('worker must not be called after server session started');
        if (fallbacks.length !== 1 || fallbacks[0].details.route !== '/v1/context') fail('fallback log expected');
      `,
    });
  });

  it('fails open when /v1/context throws a non-recoverable error', () => {
    runScenario({
      prompt: LONG_PROMPT,
      contextObservationsBody: "throw new ServerClientError('http_error', 'forbidden', { status: 403 });",
      assertions: `
        if (result.hookSpecificOutput) fail('no additionalContext expected');
        if (!result.suppressOutput) fail('suppressOutput expected');
        if (workerFallbackCalled) fail('worker must not be called');
      `,
    });
  });

  it('does not inject when the server returns an empty context', () => {
    runScenario({
      prompt: LONG_PROMPT,
      contextObservationsBody: "return { observations: [], context: '' };",
      assertions: `
        if (serverCalls.contextObservations.length !== 1) fail('contextObservations expected');
        if (result.hookSpecificOutput) fail('no additionalContext expected');
      `,
    });
  });

  it('falls back to the worker path when session start is transient-failing', () => {
    runScenario({
      prompt: LONG_PROMPT,
      startSessionBody: "throw new ServerClientError('transport', 'ECONNREFUSED');",
      assertions: `
        if (serverCalls.contextObservations.length !== 0) fail('server context should not be called');
        if (!workerFallbackCalled) fail('worker fallback expected');
        if (fallbacks[0]?.details.route !== '/v1/sessions/start') fail('sessions/start fallback log expected');
      `,
    });
  });
});
