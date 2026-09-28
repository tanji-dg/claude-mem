// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, PostgresQueryable } from './utils.js';
import { newId, queryOne, toEpoch, toJsonObject } from './utils.js';

export interface PostgresProject {
  id: string;
  teamId: string;
  name: string;
  metadata: JsonObject;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

interface ProjectRow {
  id: string;
  team_id: string;
  name: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export class PostgresProjectsRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: {
    id?: string;
    teamId: string;
    name: string;
    metadata?: JsonObject;
  }): Promise<PostgresProject> {
    const id = input.id ?? newId();
    const row = await queryOne<ProjectRow>(
      this.client,
      `
        INSERT INTO projects (id, team_id, name, metadata)
        VALUES ($1, $2, $3, $4::jsonb)
        RETURNING *
      `,
      [id, input.teamId, input.name, JSON.stringify(input.metadata ?? {})]
    );
    return mapProjectRow(row!);
  }

  /**
   * Oldest project named `name` in the team, created first when missing.
   * Call inside a transaction: the advisory lock (released at COMMIT)
   * serializes concurrent resolvers of the same (team, name) without needing a
   * UNIQUE constraint that existing databases may already violate.
   */
  async findOrCreateByName(teamId: string, name: string): Promise<{ project: PostgresProject; created: boolean }> {
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`projects:${teamId}:${name}`]);
    const existing = await queryOne<ProjectRow>(
      this.client,
      'SELECT * FROM projects WHERE team_id = $1 AND name = $2 ORDER BY created_at, id LIMIT 1',
      [teamId, name]
    );
    if (existing) {
      return { project: mapProjectRow(existing), created: false };
    }
    return { project: await this.create({ teamId, name }), created: true };
  }

  async getByIdForTeam(id: string, teamId: string): Promise<PostgresProject | null> {
    const row = await queryOne<ProjectRow>(
      this.client,
      'SELECT * FROM projects WHERE id = $1 AND team_id = $2',
      [id, teamId]
    );
    return row ? mapProjectRow(row) : null;
  }
}

function mapProjectRow(row: ProjectRow): PostgresProject {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    metadata: toJsonObject(row.metadata),
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}
