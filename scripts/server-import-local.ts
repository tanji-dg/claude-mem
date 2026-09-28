#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//
// Copy the local memory database (observations + session summaries) to a
// claude-mem server (CLAUDE_MEM_RUNTIME=server: the Express/Postgres server or
// the Cloudflare Worker in workers/cmem-server) through POST /v1/memories.
//
// - Each local project goes to its own server project (POST /v1/projects/
//   resolve, team-scoped key), or to CLAUDE_MEM_SERVER_PROJECT_ID when set.
// - Memories keep their original time (createdAtEpoch) and carry an
//   idempotencyKey, so re-running never duplicates anything.
// - Newest first, at most --max memories per run, resumable: progress is kept
//   in <data dir>/server-import-state.json. The cap exists for the Cloudflare
//   Free plan, where D1 allows ~100,000 rows written per day for the whole
//   account and each memory costs roughly ROWS_WRITTEN_PER_MEMORY rows.
//
// Usage:
//   bun scripts/server-import-local.ts --env-file ~/.cloudflare/cmem-server.env --dry-run
//   bun scripts/server-import-local.ts --env-file ~/.cloudflare/cmem-server.env
// Options:
//   --env-file <file>     KEY=VALUE file with CLAUDE_MEM_SERVER_URL / _API_KEY
//                         (/_PROJECT_ID); otherwise env vars, then settings.json
//   --db <file>           local database (default <data dir>/claude-mem.db)
//   --project <name>      only this local project (repeatable)
//   --since <YYYY-MM-DD>  only memories created on or after this date
//   --max <n>             memories to send this run (default 5000)
//   --concurrency <n>     parallel requests (default 4)
//   --include-sensitive   also send observations of type "sensitive"
//   --dry-run             count and estimate only; send nothing

import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { readJsonFileWithBom, writeJsonFileAtomic } from '../src/shared/atomic-json.js';
import { resolveDataDir } from '../src/shared/paths.js';

export const ROWS_WRITTEN_PER_MEMORY = 9;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

export interface LocalMemory {
  key: string;
  project: string;
  createdAtEpoch: number;
  kind: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
}

interface ObservationRow {
  id: number;
  memory_session_id: string | null;
  project: string;
  merged_into_project: string | null;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at_epoch: number;
  content_hash: string | null;
}

interface SummaryRow {
  id: number;
  memory_session_id: string | null;
  project: string;
  merged_into_project: string | null;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  files_read: string | null;
  files_edited: string | null;
  prompt_number: number | null;
  created_at_epoch: number;
}

function jsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function sha(parts: Array<string | number | null>): string {
  return createHash('sha256').update(parts.map(p => String(p ?? '')).join('\u0000')).digest('hex').slice(0, 32);
}

function clean(value: string | null): string {
  return (value ?? '').trim();
}

export function observationToMemory(row: ObservationRow): LocalMemory {
  const title = clean(row.title) || clean(row.subtitle) || clean(row.narrative).split('\n')[0] || clean(row.text).split('\n')[0];
  const facts = jsonArray(row.facts);
  const body = [
    clean(row.title),
    clean(row.subtitle),
    clean(row.narrative) || clean(row.text),
    facts.length > 0 ? `Facts:\n${facts.map(f => `- ${f}`).join('\n')}` : '',
  ].filter(Boolean);
  const project = row.merged_into_project || row.project;
  return {
    // Content-derived, so the same memory imported from two machines is one row.
    key: `local:obs:${row.content_hash || sha([project, row.created_at_epoch, row.title, row.narrative, row.text])}`,
    project,
    createdAtEpoch: row.created_at_epoch,
    kind: row.type || 'observation',
    title,
    content: body.join('\n\n'),
    metadata: {
      source: 'local-import',
      title,
      ...(clean(row.subtitle) ? { subtitle: clean(row.subtitle) } : {}),
      localKind: 'observation',
      localId: row.id,
      localProject: row.project,
      concepts: jsonArray(row.concepts),
      filesRead: jsonArray(row.files_read),
      filesModified: jsonArray(row.files_modified),
      memorySessionId: row.memory_session_id,
      promptNumber: row.prompt_number,
    },
  };
}

export function summaryToMemory(row: SummaryRow): LocalMemory {
  const sections: Array<[string, string | null]> = [
    ['Request', row.request],
    ['Investigated', row.investigated],
    ['Learned', row.learned],
    ['Completed', row.completed],
    ['Next steps', row.next_steps],
    ['Notes', row.notes],
  ];
  const project = row.merged_into_project || row.project;
  const title = clean(row.request).split('\n')[0] || 'Session summary';
  return {
    key: `local:sum:${sha([project, row.created_at_epoch, row.memory_session_id, row.request, row.completed])}`,
    project,
    createdAtEpoch: row.created_at_epoch,
    kind: 'summary',
    title,
    content: sections.filter(([, v]) => clean(v)).map(([label, v]) => `${label}: ${clean(v)}`).join('\n'),
    metadata: {
      source: 'local-import',
      title,
      localKind: 'summary',
      localId: row.id,
      localProject: row.project,
      filesRead: jsonArray(row.files_read),
      filesEdited: jsonArray(row.files_edited),
      memorySessionId: row.memory_session_id,
      promptNumber: row.prompt_number,
    },
  };
}

export function loadLocalMemories(
  db: Database,
  filters: { projects: string[]; sinceEpoch: number | null; includeSensitive: boolean },
): LocalMemory[] {
  const where: string[] = ['created_at_epoch > 0'];
  const params: Array<string | number> = [];
  if (filters.projects.length > 0) {
    where.push(`COALESCE(merged_into_project, project) IN (${filters.projects.map(() => '?').join(', ')})`);
    params.push(...filters.projects);
  }
  if (filters.sinceEpoch !== null) {
    where.push('created_at_epoch >= ?');
    params.push(filters.sinceEpoch);
  }
  const observationWhere = filters.includeSensitive ? where : [...where, "type <> 'sensitive'"];
  const observations = db
    .query<ObservationRow, Array<string | number>>(`SELECT * FROM observations WHERE ${observationWhere.join(' AND ')}`)
    .all(...params)
    .map(observationToMemory);
  const summaries = db
    .query<SummaryRow, Array<string | number>>(`SELECT * FROM session_summaries WHERE ${where.join(' AND ')}`)
    .all(...params)
    .map(summaryToMemory);
  return [...observations, ...summaries]
    .filter(m => m.content.length > 0)
    .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch);
}

function loadEnvFile(file: string): void {
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trimStart().startsWith('#')) process.env[match[1]!] = match[2]!;
  }
}

class ImportError extends Error {}

class ServerApi {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  /** Retries transport errors, 429 and 5xx; returns the final Response. */
  async post(path: string, body: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        res = null;
      }
      const retryable = res === null || res.status === 429 || res.status >= 500;
      if (!retryable) return res!;
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw new ImportError(`${path} kept failing (${res ? `HTTP ${res.status} ${await res.text()}` : 'network error'})`);
      }
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

type ImportState = Record<string, { done: string[] }>;

function statePath(): string {
  return join(resolveDataDir(), 'server-import-state.json');
}

function readState(): ImportState {
  return existsSync(statePath()) ? readJsonFileWithBom<ImportState>(statePath()) : {};
}

async function main(): Promise<void> {
  const { values: opts } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      db: { type: 'string' },
      project: { type: 'string', multiple: true, default: [] },
      since: { type: 'string' },
      max: { type: 'string', default: '5000' },
      concurrency: { type: 'string', default: '4' },
      'include-sensitive': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (opts['env-file']) loadEnvFile(opts['env-file']);
  const settings = SettingsDefaultsManager.loadFromFile(join(resolveDataDir(), 'settings.json'));
  const baseUrl = (settings.CLAUDE_MEM_SERVER_URL ?? '').trim().replace(/\/+$/, '');
  const apiKey = (settings.CLAUDE_MEM_SERVER_API_KEY ?? '').trim();
  const fixedProjectId = (settings.CLAUDE_MEM_SERVER_PROJECT_ID ?? '').trim() || null;
  const max = Number.parseInt(opts.max!, 10);
  const concurrency = Number.parseInt(opts.concurrency!, 10);
  const sinceEpoch = opts.since ? Date.parse(`${opts.since}T00:00:00Z`) : null;
  if (!Number.isInteger(max) || max < 1) throw new ImportError('--max must be a positive integer');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new ImportError('--concurrency must be 1-16');
  if (sinceEpoch !== null && Number.isNaN(sinceEpoch)) throw new ImportError('--since must be YYYY-MM-DD');

  const dbPath = opts.db ?? join(resolveDataDir(), 'claude-mem.db');
  const db = new Database(dbPath, { readonly: true });
  const all = loadLocalMemories(db, { projects: opts.project!, sinceEpoch, includeSensitive: opts['include-sensitive']! });
  db.close();

  const state = readState();
  const scope = baseUrl || '(unset)';
  const done = new Set(state[scope]?.done ?? []);
  const pending = all.filter(m => !done.has(m.key));
  const batch = pending.slice(0, max);
  const perProject = new Map<string, number>();
  for (const m of batch) perProject.set(m.project, (perProject.get(m.project) ?? 0) + 1);

  console.log(`Local memories: ${all.length} (already imported: ${all.length - pending.length}, pending: ${pending.length})`);
  console.log(`This run: ${batch.length} memories ≈ ${batch.length * ROWS_WRITTEN_PER_MEMORY} D1 rows written`);
  for (const [project, n] of [...perProject].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${project}`);
  if (opts['dry-run'] || batch.length === 0) return;

  if (!baseUrl || !apiKey) throw new ImportError('CLAUDE_MEM_SERVER_URL and CLAUDE_MEM_SERVER_API_KEY are required (--env-file, env or settings.json)');
  const api = new ServerApi(baseUrl, apiKey);

  const projectIds = new Map<string, Promise<string>>();
  const projectIdFor = (name: string): Promise<string> => {
    if (fixedProjectId) return Promise.resolve(fixedProjectId);
    if (!projectIds.has(name)) {
      projectIds.set(name, (async () => {
        const res = await api.post('/v1/projects/resolve', { name });
        if (res.status === 403) {
          throw new ImportError('the API key is project-scoped: use a team-scoped key (bootstrap:remote --team-key) or set CLAUDE_MEM_SERVER_PROJECT_ID');
        }
        if (!res.ok) throw new ImportError(`resolving project "${name}" failed: HTTP ${res.status} ${await res.text()}`);
        return ((await res.json()) as { project: { id: string } }).project.id;
      })());
    }
    return projectIds.get(name)!;
  };

  const saveProgress = () => {
    state[scope] = { done: [...done] };
    writeJsonFileAtomic(statePath(), state);
  };

  let sent = 0;
  let existed = 0;
  const rejected: string[] = [];
  let fatal: Error | null = null;
  let next = 0;
  const workerLoop = async () => {
    while (!fatal && next < batch.length) {
      const memory = batch[next++]!;
      try {
        const res = await api.post('/v1/memories', {
          projectId: await projectIdFor(memory.project),
          kind: memory.kind,
          title: memory.title,
          content: memory.content,
          metadata: memory.metadata,
          createdAtEpoch: memory.createdAtEpoch,
          idempotencyKey: memory.key,
        });
        if (res.status === 401 || res.status === 403) {
          throw new ImportError(`server refused the API key: HTTP ${res.status} ${await res.text()}`);
        }
        if (res.status === 201 || res.status === 200) {
          if (res.status === 200) existed++;
          else sent++;
          done.add(memory.key);
        } else {
          rejected.push(`${memory.key} (${memory.project}): HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        }
      } catch (error) {
        fatal = error instanceof Error ? error : new Error(String(error));
      }
      if ((sent + existed) % 250 === 0 && sent + existed > 0) {
        saveProgress();
        console.log(`  … ${sent + existed}/${batch.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, workerLoop));
  saveProgress();

  console.log(`Imported ${sent} new, ${existed} already on the server, ${rejected.length} rejected.`);
  for (const line of rejected.slice(0, 20)) console.log(`  rejected ${line}`);
  const remaining = pending.length - sent - existed;
  if (fatal) {
    console.error(`Stopped: ${(fatal as Error).message}`);
    console.error('Progress is saved; run the same command again to continue.');
    process.exitCode = 1;
  } else if (remaining > 0) {
    console.log(`${remaining} memories left. Run the same command again (e.g. tomorrow, to stay inside the D1 Free plan) to continue.`);
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(`server-import-local: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
