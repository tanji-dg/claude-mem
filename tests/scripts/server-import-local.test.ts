// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { loadLocalMemories } from '../../scripts/server-import-local.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, merged_into_project TEXT, text TEXT, type TEXT,
    title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT, files_read TEXT, files_modified TEXT,
    prompt_number INTEGER, created_at_epoch INTEGER, content_hash TEXT)`);
  db.run(`CREATE TABLE session_summaries (
    id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, merged_into_project TEXT, request TEXT,
    investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, notes TEXT, files_read TEXT, files_edited TEXT,
    prompt_number INTEGER, created_at_epoch INTEGER)`);
  return db;
}

function addObservation(db: Database, row: Record<string, unknown>): void {
  const full = {
    memory_session_id: 's1', project: 'alpha', merged_into_project: null, text: null, type: 'discovery',
    title: 'Title', subtitle: 'Sub', facts: '["fact one","fact two"]', narrative: 'Narrative body',
    concepts: '["how-it-works"]', files_read: '["a.ts"]', files_modified: '[]', prompt_number: 1,
    created_at_epoch: 1_000, content_hash: 'hash1', ...row,
  };
  const cols = Object.keys(full);
  db.query(`INSERT INTO observations (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(Object.values(full) as never[]));
}

describe('loadLocalMemories', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it('maps an observation to a memory with its original time and a content-derived key', () => {
    addObservation(db, {});
    const [m] = loadLocalMemories(db, { projects: [], sinceEpoch: null, includeSensitive: false });
    expect(m).toMatchObject({
      key: 'local:obs:hash1',
      project: 'alpha',
      createdAtEpoch: 1_000,
      kind: 'discovery',
      title: 'Title',
      metadata: { source: 'local-import', title: 'Title', localProject: 'alpha', concepts: ['how-it-works'], filesRead: ['a.ts'] },
    });
    expect(m!.content).toBe('Title\n\nSub\n\nNarrative body\n\nFacts:\n- fact one\n- fact two');
  });

  it('maps a session summary', () => {
    db.query(`INSERT INTO session_summaries (id, memory_session_id, project, request, learned, completed, created_at_epoch)
      VALUES (1, 's1', 'alpha', 'Fix the bug', 'It was a race', 'Patched', 2000)`).run();
    const [m] = loadLocalMemories(db, { projects: [], sinceEpoch: null, includeSensitive: false });
    expect(m).toMatchObject({ kind: 'summary', title: 'Fix the bug', createdAtEpoch: 2000 });
    expect(m!.key).toMatch(/^local:sum:[0-9a-f]{32}$/);
    expect(m!.content).toBe('Request: Fix the bug\nLearned: It was a race\nCompleted: Patched');
  });

  it('sends merged rows to the project they were merged into', () => {
    addObservation(db, { project: 'alpha/wt', merged_into_project: 'alpha' });
    const [m] = loadLocalMemories(db, { projects: ['alpha'], sinceEpoch: null, includeSensitive: false });
    expect(m).toMatchObject({ project: 'alpha', metadata: { localProject: 'alpha/wt' } });
  });

  it('orders newest first and applies the project and since filters', () => {
    addObservation(db, { id: 1, created_at_epoch: 100, content_hash: 'a' });
    addObservation(db, { id: 2, created_at_epoch: 300, content_hash: 'b' });
    addObservation(db, { id: 3, created_at_epoch: 200, content_hash: 'c', project: 'beta' });
    expect(loadLocalMemories(db, { projects: [], sinceEpoch: null, includeSensitive: false }).map(m => m.createdAtEpoch)).toEqual([300, 200, 100]);
    expect(loadLocalMemories(db, { projects: ['beta'], sinceEpoch: null, includeSensitive: false }).map(m => m.project)).toEqual(['beta']);
    expect(loadLocalMemories(db, { projects: [], sinceEpoch: 150, includeSensitive: false }).map(m => m.createdAtEpoch)).toEqual([300, 200]);
  });

  it('skips sensitive observations unless asked, and empty ones always', () => {
    addObservation(db, { id: 1, type: 'sensitive', content_hash: 's' });
    addObservation(db, { id: 2, title: null, subtitle: null, narrative: null, facts: null, content_hash: 'e' });
    expect(loadLocalMemories(db, { projects: [], sinceEpoch: null, includeSensitive: false })).toHaveLength(0);
    expect(loadLocalMemories(db, { projects: [], sinceEpoch: null, includeSensitive: true }).map(m => m.kind)).toEqual(['sensitive']);
  });

  it('tolerates malformed JSON arrays', () => {
    addObservation(db, { facts: 'not json', concepts: '{"x":1}' });
    const [m] = loadLocalMemories(db, { projects: [], sinceEpoch: null, includeSensitive: false });
    expect(m!.metadata.concepts).toEqual([]);
    expect(m!.content).not.toContain('Facts:');
  });
});
