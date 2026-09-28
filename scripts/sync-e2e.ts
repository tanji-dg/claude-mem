#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//
// End-to-end encrypted sync with a self-hosted hub (workers/sync-hub,
// wrangler.self-host.jsonc). Run on every device:
//
//   bun scripts/sync-e2e.ts init                 first device: create the key
//   bun scripts/sync-e2e.ts export               print the key to copy to another device
//   bun scripts/sync-e2e.ts import               other devices: paste the key (read from stdin)
//   bun scripts/sync-e2e.ts configure --env-file ~/.cloudflare/cmem-sync.env
//                                                point settings.json at the hub, E2E on
//   bun scripts/sync-e2e.ts backfill [--limit N] queue pre-sync history for upload
//   bun scripts/sync-e2e.ts status               key, settings and queue counts
//
// The key lives in <data dir>/sync-e2e.key (0600). Losing every copy makes the
// hub's data unreadable; `export` output is the backup.

import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { parseArgs } from 'util';
import { readJsonFileWithBom, writeJsonFileAtomic } from '../src/shared/atomic-json.js';
import { resolveDataDir } from '../src/shared/paths.js';
import {
  decodeE2EKey,
  E2ECodec,
  e2eKeyPath,
  encodeE2EKey,
  generateE2EKey,
  readE2EKey,
  writeE2EKey,
} from '../src/services/sync/E2ECodec.js';

const TABLES = [
  { table: 'observations', kind: 'observation' },
  { table: 'session_summaries', kind: 'summary' },
  { table: 'user_prompts', kind: 'prompt' },
] as const;

class UsageError extends Error {}

function settingsPath(): string {
  return join(resolveDataDir(), 'settings.json');
}

function dbPath(): string {
  return join(resolveDataDir(), 'claude-mem.db');
}

function requireKey(): E2ECodec {
  const key = readE2EKey();
  if (!key) throw new UsageError(`no key at ${e2eKeyPath()}: run "init" (first device) or "import"`);
  return new E2ECodec(key);
}

function init(): void {
  if (existsSync(e2eKeyPath())) throw new UsageError(`${e2eKeyPath()} already exists`);
  writeE2EKey(generateE2EKey());
  console.log(`Created ${e2eKeyPath()} (key id ${requireKey().keyId}).`);
  console.log('Back it up now: "export" prints it; every other device needs it ("import").');
}

function exportKey(): void {
  const key = readE2EKey();
  if (!key) throw new UsageError(`no key at ${e2eKeyPath()}`);
  console.log(encodeE2EKey(key));
}

async function importKey(): Promise<void> {
  if (existsSync(e2eKeyPath())) throw new UsageError(`${e2eKeyPath()} already exists`);
  const text = (await Bun.stdin.text()).trim();
  writeE2EKey(decodeE2EKey(text));
  console.log(`Imported key ${requireKey().keyId} to ${e2eKeyPath()}.`);
}

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trimStart().startsWith('#')) values[match[1]!] = match[2]!;
  }
  return values;
}

function configure(envFile: string | undefined): void {
  if (!envFile) throw new UsageError('configure needs --env-file (written by workers/sync-hub/scripts/self-host-setup.mjs)');
  const codec = requireKey();
  const env = readEnvFile(envFile);
  for (const name of ['CLAUDE_MEM_CLOUD_SYNC_HUB_URL', 'CLAUDE_MEM_CLOUD_SYNC_TOKEN', 'CLAUDE_MEM_CLOUD_SYNC_USER_ID']) {
    if (!env[name]) throw new UsageError(`${envFile} has no ${name}`);
  }
  const path = settingsPath();
  const settings = existsSync(path) ? readJsonFileWithBom<Record<string, unknown>>(path) : {};
  if (existsSync(path)) copyFileSync(path, `${path}.bak-sync-e2e`);
  writeJsonFileAtomic(path, {
    ...settings,
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: env.CLAUDE_MEM_CLOUD_SYNC_HUB_URL,
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: env.CLAUDE_MEM_CLOUD_SYNC_TOKEN,
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: env.CLAUDE_MEM_CLOUD_SYNC_USER_ID,
    CLAUDE_MEM_CLOUD_SYNC_E2E: 'true',
    ...(settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME ? {} : { CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: hostname().slice(0, 80) }),
  });
  console.log(`Sync configured in ${path} (backup: ${path}.bak-sync-e2e), key ${codec.keyId}.`);
  console.log('Restart the worker to start syncing: npm run worker:restart');
}

/**
 * Re-queue the pre-sync baseline (rows migration v47 stamped as synced and
 * recorded in sync_launch_exclusions), newest first, at most `limit` rows.
 * Removing the exclusion keeps an epoch rebuild from skipping them again.
 */
function backfill(limit: number): void {
  const db = new Database(dbPath());
  try {
    db.run('PRAGMA busy_timeout = 10000');
    const candidates = db.query<{ kind: string; id: number; created_at_epoch: number }, []>(
      TABLES.map(({ table, kind }) => `
        SELECT '${kind}' AS kind, t.id, t.created_at_epoch FROM ${table} AS t
        JOIN sync_launch_exclusions AS launch
          ON launch.kind = '${kind}' AND launch.origin_local_id = CAST(t.id AS TEXT)
        WHERE t.origin_device_id IS NULL AND t.synced_at > 0`).join(' UNION ALL ')
      + ' ORDER BY created_at_epoch DESC',
    ).all();
    const batch = candidates.slice(0, limit);
    const tx = db.transaction(() => {
      for (const { table, kind } of TABLES) {
        const requeue = db.prepare(`UPDATE ${table} SET synced_at = NULL WHERE id = ? AND origin_device_id IS NULL`);
        const unexclude = db.prepare('DELETE FROM sync_launch_exclusions WHERE kind = ? AND origin_local_id = ?');
        for (const row of batch.filter(r => r.kind === kind)) {
          requeue.run(row.id);
          unexclude.run(kind, String(row.id));
        }
      }
    });
    tx();
    console.log(`Queued ${batch.length} rows for upload; ${candidates.length - batch.length} history rows remain.`);
    if (candidates.length > batch.length) {
      console.log('Run backfill again tomorrow to stay inside the Workers Free plan daily write limit.');
    }
    console.log('The worker uploads them on its next sync (restart it to start right away: npm run worker:restart).');
  } finally {
    db.close();
  }
}

function status(): void {
  const key = readE2EKey();
  console.log(`key: ${key ? `${e2eKeyPath()} (id ${new E2ECodec(key).keyId})` : 'missing'}`);
  const settings = existsSync(settingsPath()) ? readJsonFileWithBom<Record<string, string>>(settingsPath()) : {};
  const hub = settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL;
  console.log(`hub: ${hub || '(not configured)'}  e2e: ${settings.CLAUDE_MEM_CLOUD_SYNC_E2E ?? 'false'}`);
  const db = new Database(dbPath(), { readonly: true });
  try {
    for (const { table, kind } of TABLES) {
      const row = db.query<{ total: number; pending: number; local: number }, []>(`
        SELECT count(*) AS total,
               sum(synced_at IS NULL AND origin_device_id IS NULL) AS pending,
               sum(origin_device_id IS NULL) AS local
        FROM ${table}`).get()!;
      const history = db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM sync_launch_exclusions WHERE kind = ?').get(kind)!.n;
      console.log(`${table.padEnd(18)} total ${row.total}  local ${row.local ?? 0}  pending upload ${row.pending ?? 0}  history not yet queued ${history}`);
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'env-file': { type: 'string' },
      limit: { type: 'string', default: '12000' },
    },
  });
  const command = positionals[0];
  switch (command) {
    case 'init': return init();
    case 'export': return exportKey();
    case 'import': return importKey();
    case 'configure': return configure(values['env-file']);
    case 'backfill': {
      const limit = Number.parseInt(values.limit!, 10);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');
      return backfill(limit);
    }
    case 'status': return status();
    default:
      throw new UsageError('usage: bun scripts/sync-e2e.ts init | export | import | configure --env-file <file> | backfill [--limit N] | status');
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(`sync-e2e: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
