// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import {
  executeWithWorkerFallback as defaultExecuteWithWorkerFallback,
  isWorkerFallback as defaultIsWorkerFallback,
} from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES, HOOK_TIMEOUTS } from '../../shared/hook-constants.js';
import { shouldTrackProject as defaultShouldTrackProject } from '../../shared/should-track-project.js';
import { loadFromFileOnce as defaultLoadFromFileOnce } from '../../shared/hook-settings.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { isInternalProtocolPayload } from '../../utils/tag-stripping.js';
import {
  resolveRuntimeContext as defaultResolveRuntimeContext,
  logServerFallback as defaultLogServerFallback,
  type ServerRuntimeContext,
} from '../../services/hooks/runtime-selector.js';
import { isServerClientError } from '../../services/hooks/server-client.js';

interface SessionInitResponse {
  sessionDbId: number;
  promptNumber: number;
  skipped?: boolean;
  reason?: string;
  contextInjected?: boolean;
}

interface SemanticContextResponse {
  context: string;
  count: number;
}

const defaultDependencies = {
  executeWithWorkerFallback: defaultExecuteWithWorkerFallback,
  isWorkerFallback: defaultIsWorkerFallback,
  loadFromFileOnce: defaultLoadFromFileOnce,
  resolveRuntimeContext: defaultResolveRuntimeContext,
  logServerFallback: defaultLogServerFallback,
  shouldTrackProject: defaultShouldTrackProject,
};

let dependencies = defaultDependencies;

export function setSessionInitDependenciesForTesting(
  overrides: Partial<typeof defaultDependencies> = {},
): void {
  dependencies = { ...defaultDependencies, ...overrides };
}

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, prompt: rawPrompt } = input;
    const cwd = input.cwd ?? process.cwd();  

    if (!sessionId) {
      logger.warn('HOOK', 'session-init: No sessionId provided, skipping (Codex CLI or unknown platform)');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (!dependencies.shouldTrackProject(cwd)) {
      logger.info('HOOK', 'Project excluded from tracking', { cwd });
      return { continue: true, suppressOutput: true };
    }

    if (rawPrompt && isInternalProtocolPayload(rawPrompt)) {
      logger.debug('HOOK', 'session-init: skipping internal protocol payload', {
        preview: rawPrompt.slice(0, 80),
      });
      return { continue: true, suppressOutput: true };
    }

    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;

    const project = getProjectContext(cwd).primary;
    const platformSource = normalizePlatformSource(input.platform);
    const settings = dependencies.loadFromFileOnce();
    const semanticInject =
      String(settings.CLAUDE_MEM_SEMANTIC_INJECT).toLowerCase() === 'true';

    const runtime = dependencies.resolveRuntimeContext();
    // Phase 1a (cmem-sdk rename): `runtime.runtime` is the canonical `'server'`
    // value. Legacy `'server-beta'` is normalized inside `selectRuntime()`.
    if (runtime.runtime === 'server') {
      let serverSessionStarted = true;
      try {
        await startServerSession(runtime, input, sessionId, platformSource, project, prompt);
      } catch (error: unknown) {
        if (isServerClientError(error) && error.isFallbackEligible()) {
          dependencies.logServerFallback(error.kind, {
            status: error.status,
            message: error.message,
            route: '/v1/sessions/start',
          });
          serverSessionStarted = false;
        } else {
          logger.error('HOOK', 'Server session-start failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
      if (serverSessionStarted) {
        // Semantic injection in server mode goes through POST /v1/context
        // (same FTS surface as the MCP `observation_context` tool). Fail
        // open: a context failure must never block the prompt.
        const additionalContext = semanticInject && shouldSemanticInject(prompt)
          ? await fetchServerSemanticContext(runtime, prompt, platformSource, settings.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT)
          : '';
        if (additionalContext) {
          return {
            continue: true,
            suppressOutput: true,
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext,
            },
          };
        }
        return { continue: true, suppressOutput: true };
      }
      // fall through to worker fallback
    }

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', { contentSessionId: sessionId, project });

    const initResult = await dependencies.executeWithWorkerFallback<SessionInitResponse>(
      '/api/sessions/init',
      'POST',
      {
        contentSessionId: sessionId,
        project,
        prompt,
        platformSource,
      },
      platformSource === 'codex'
        ? { workerStartupTimeoutMs: HOOK_TIMEOUTS.POST_SPAWN_WAIT, timeoutMs: 2_000 }
        : undefined,
    );

    if (dependencies.isWorkerFallback(initResult)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (typeof initResult?.sessionDbId !== 'number') {
      logger.failure('HOOK', 'Session initialization returned malformed response', { contentSessionId: sessionId, project });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const sessionDbId = initResult.sessionDbId;
    const promptNumber = initResult.promptNumber;

    logger.debug('HOOK', 'session-init: Received from /api/sessions/init', { sessionDbId, promptNumber, skipped: initResult.skipped, contextInjected: initResult.contextInjected });

    logger.debug('HOOK', `[ALIGNMENT] Hook Entry | contentSessionId=${sessionId} | prompt#=${promptNumber} | sessionDbId=${sessionDbId}`);

    if (initResult.skipped && initResult.reason === 'private') {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=private`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    let additionalContext = '';

    if (semanticInject && shouldSemanticInject(prompt)) {
      const limit = settings.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT || '5';
      const semanticResult = await dependencies.executeWithWorkerFallback<SemanticContextResponse>(
        '/api/context/semantic',
        'POST',
        { q: prompt, project, limit, platformSource },
        platformSource === 'codex'
          ? { workerStartupTimeoutMs: HOOK_TIMEOUTS.POST_SPAWN_WAIT, timeoutMs: 2_000 }
          : undefined,
      );
      if (!dependencies.isWorkerFallback(semanticResult) && semanticResult?.context) {
        logger.debug('HOOK', `Semantic injection: ${semanticResult.count} observations for prompt`, { sessionId: sessionDbId, count: semanticResult.count });
        additionalContext = semanticResult.context;
      }
    }

    logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | project=${project}`, {
      sessionId: sessionDbId
    });

    if (additionalContext) {
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext
        }
      };
    }

    return { continue: true, suppressOutput: true };
  }
};

async function startServerSession(
  runtime: ServerRuntimeContext,
  input: NormalizedHookInput,
  sessionId: string,
  platformSource: string,
  project: string,
  prompt: string,
): Promise<void> {
  await runtime.client.startSession({
    projectId: runtime.projectId,
    externalSessionId: sessionId,
    contentSessionId: sessionId,
    agentId: input.agentId ?? null,
    agentType: input.agentType ?? null,
    platformSource,
    metadata: { project, prompt },
  });
  logger.info('HOOK', 'session-init: server session started', {
    contentSessionId: sessionId,
    project,
  });
}

function shouldSemanticInject(prompt: string): boolean {
  return Boolean(prompt) && prompt.length >= 20 && prompt !== '[media prompt]';
}

async function fetchServerSemanticContext(
  runtime: ServerRuntimeContext,
  prompt: string,
  platformSource: string,
  rawLimit: string | number | undefined,
): Promise<string> {
  try {
    const response = await runtime.client.contextObservations({
      projectId: runtime.projectId,
      query: prompt,
      // /v1/context caps limit at 50 (zod max).
      limit: Math.min(parseSemanticInjectLimit(rawLimit ?? '5'), 50),
      platformSource,
    });
    const context = typeof response?.context === 'string' ? response.context : '';
    if (context) {
      logger.debug('HOOK', 'Semantic injection (server): observations for prompt', {
        count: Array.isArray(response.observations) ? response.observations.length : 0,
      });
    }
    return context;
  } catch (error: unknown) {
    if (isServerClientError(error) && error.isFallbackEligible()) {
      dependencies.logServerFallback(error.kind, {
        status: error.status,
        message: error.message,
        route: '/v1/context',
      });
    } else {
      logger.warn('HOOK', 'Server semantic context failed; continuing without it', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return '';
  }
}

function parseSemanticInjectLimit(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return parsed;
}
