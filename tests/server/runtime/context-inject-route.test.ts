// SPDX-License-Identifier: Apache-2.0
//
// GET /v1/context/inject — SessionStart context injection for server-runtime
// hooks. The markdown renderer is unit-tested unconditionally; the HTTP route
// (auth, project scoping, text/plain body, audit row) is Postgres-gated like
// the other ServerV1PostgresRoutes integration tests.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { Server } from '../../../src/services/server/Server.js';
import {
  ServerV1PostgresRoutes,
  renderContextInjectMarkdown,
} from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { logger } from '../../../src/utils/logger.js';
import { quoteIdentifier, newApiKey } from '../../sdk/pg-isolation.js';

const NOW = new Date('2026-09-28T12:34:00Z');
const day = (d: string) => new Date(`${d}T10:00:00Z`).getTime();

describe('renderContextInjectMarkdown', () => {
  it('returns an empty string when there are no observations', () => {
    expect(renderContextInjectMarkdown([], { projectName: 'p', now: NOW })).toBe('');
  });

  it('renders a header, the latest summary as Last session, and dated bullets', () => {
    const md = renderContextInjectMarkdown([
      { kind: 'discovery', content: 'Body only line\nsecond line', metadata: {}, createdAtEpoch: day('2026-09-27') },
      { kind: 'summary', content: 'Request: fix login\n\nCompleted: patched cookie', metadata: {}, createdAtEpoch: day('2026-09-26') },
      { kind: 'bugfix', content: 'ignored body', metadata: { title: 'Fixed  CSRF\ncookie' }, createdAtEpoch: day('2026-09-25') },
      { kind: 'summary', content: 'Request: older session', metadata: {}, createdAtEpoch: day('2026-09-20') },
      { kind: 'manual', content: '   \n  ', metadata: {}, createdAtEpoch: day('2026-09-19') },
    ], { projectName: 'my-app', now: NOW });

    expect(md).toBe([
      '# [my-app] recent context (server), 2026-09-28 12:34 UTC',
      '',
      '## Last session (2026-09-26)',
      '',
      'Request: fix login\n\nCompleted: patched cookie',
      '',
      '## Recent observations',
      '',
      '- 2026-09-27 [discovery] Body only line',
      '- 2026-09-25 [bugfix] Fixed CSRF cookie',
      '',
    ].join('\n'));
    expect(md).not.toContain('older session');
  });

  it('omits the Last session section when there is no summary and truncates long titles', () => {
    const md = renderContextInjectMarkdown([
      { kind: 'feature', content: 'x'.repeat(500), metadata: {}, createdAtEpoch: day('2026-09-27') },
    ], { projectName: 'p', now: NOW });
    expect(md).not.toContain('## Last session');
    const bullet = md.split('\n').find(l => l.startsWith('- '))!;
    expect(bullet.endsWith('…')).toBe(true);
    expect(bullet.length).toBeLessThan(200);
  });
});

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('GET /v1/context/inject (Postgres)', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;
  let teamId: string;
  let projectId: string;
  let otherProjectId: string;
  let readKey: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_ctx_inject_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    teamId = team.id;
    projectId = (await storage.projects.create({ teamId, name: 'inject-project' })).id;
    otherProjectId = (await storage.projects.create({ teamId, name: 'other' })).id;

    const { raw, hash } = newApiKey();
    readKey = raw;
    await storage.auth.createApiKey({
      keyHash: hash, teamId, projectId, actorId: 'test', scopes: ['memories:read'],
    });

    await storage.observations.create({
      projectId, teamId, kind: 'discovery',
      content: 'Login bug was a stale CSRF cookie.', metadata: { title: 'Stale CSRF cookie' },
    });
    await storage.observations.create({
      projectId, teamId, kind: 'summary',
      content: 'Request: fix login\n\nCompleted: patched cookie handling',
    });

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerQueueManager('disabled in tests'),
      authMode: 'api-key',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  const get = (query: string, key?: string) => fetch(
    `http://127.0.0.1:${port}/v1/context/inject${query}`,
    key ? { headers: { Authorization: `Bearer ${key}` } } : {},
  );

  it('returns text/plain markdown of recent memories and writes an audit row', async () => {
    const res = await get(`?projectId=${projectId}&platformSource=Claude%20Code`, readKey);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await res.text();
    expect(body).toContain('# [inject-project] recent context (server)');
    expect(body).toContain('## Last session');
    expect(body).toContain('Completed: patched cookie handling');
    expect(body).toContain('[discovery] Stale CSRF cookie');

    const audit = await pool.query(
      `SELECT details FROM audit_log WHERE team_id = $1 AND action = 'observation.read'`,
      [teamId],
    );
    const inject = audit.rows.find((r: { details: { mode?: string } }) => r.details?.mode === 'inject');
    expect(inject?.details.resultCount).toBe(2);
    expect(inject?.details.platformSource).toBe('claude');
  });

  it('returns an empty body when the project has no memories', async () => {
    const { raw, hash } = newApiKey();
    await storage.auth.createApiKey({
      keyHash: hash, teamId, projectId: null, actorId: 'test', scopes: ['memories:read'],
    });
    const res = await get(`?projectId=${otherProjectId}`, raw);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('rejects missing auth, missing projectId and cross-project keys', async () => {
    expect((await get(`?projectId=${projectId}`)).status).toBe(401);
    expect((await get('', readKey)).status).toBe(400);
    expect((await get(`?projectId=${otherProjectId}`, readKey)).status).toBe(403);
  });
});
