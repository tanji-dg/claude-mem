// SPDX-License-Identifier: Apache-2.0
//
// D1 port of src/storage/postgres/{auth,teams,projects}.ts — the tenancy
// tables. Only what the Worker routes use.

import type { JsonObject } from './utils';
import { newId, nowMs, toEpochOrNull, toJsonArray, toJsonObject } from './utils';

export interface ApiKey {
	id: string;
	keyHash: string;
	teamId: string | null;
	projectId: string | null;
	actorId: string;
	scopes: unknown[];
	revokedAtEpoch: number | null;
	expiresAtEpoch: number | null;
	createdAtEpoch: number;
	updatedAtEpoch: number;
}

export interface Team {
	id: string;
	name: string;
	metadata: JsonObject;
	createdAtEpoch: number;
	updatedAtEpoch: number;
}

export interface Project {
	id: string;
	teamId: string;
	name: string;
	metadata: JsonObject;
	createdAtEpoch: number;
	updatedAtEpoch: number;
}

export interface AuditLog {
	id: string;
	teamId: string | null;
	projectId: string | null;
	actorId: string | null;
	apiKeyId: string | null;
	action: string;
	resourceType: string;
	resourceId: string | null;
	details: JsonObject;
	createdAtEpoch: number;
}

interface ApiKeyRow {
	id: string;
	key_hash: string;
	team_id: string | null;
	project_id: string | null;
	actor_id: string;
	scopes: string;
	revoked_at: number | null;
	expires_at: number | null;
	created_at: number;
	updated_at: number;
}

interface TeamRow {
	id: string;
	name: string;
	metadata: string;
	created_at: number;
	updated_at: number;
}

interface ProjectRow extends TeamRow {
	team_id: string;
}

interface AuditLogRow {
	id: string;
	team_id: string | null;
	project_id: string | null;
	actor_id: string | null;
	api_key_id: string | null;
	action: string;
	resource_type: string;
	resource_id: string | null;
	details: string;
	created_at: number;
}

export class AuthRepository {
	constructor(private readonly db: D1Database) {}

	async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
		// key_hash is UNIQUE → single-row index lookup.
		const row = await this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?1').bind(keyHash).first<ApiKeyRow>();
		return row ? mapApiKeyRow(row) : null;
	}

	createApiKeyStatement(input: {
		id?: string;
		keyHash: string;
		teamId?: string | null;
		projectId?: string | null;
		actorId: string;
		scopes?: unknown[];
		expiresAt?: number | null;
	}): D1PreparedStatement {
		const now = nowMs();
		return this.db
			.prepare(
				`INSERT INTO api_keys (id, key_hash, team_id, project_id, actor_id, scopes, expires_at, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
				 RETURNING *`,
			)
			.bind(
				input.id ?? newId(),
				input.keyHash,
				input.teamId ?? null,
				input.projectId ?? null,
				input.actorId,
				JSON.stringify(input.scopes ?? []),
				input.expiresAt ?? null,
				now,
			);
	}

	async createApiKey(input: Parameters<AuthRepository['createApiKeyStatement']>[0]): Promise<ApiKey> {
		const row = await this.createApiKeyStatement(input).first<ApiKeyRow>();
		return mapApiKeyRow(row!);
	}

	createTeamStatement(input: { id?: string; name: string; metadata?: JsonObject }): D1PreparedStatement {
		const now = nowMs();
		return this.db
			.prepare('INSERT INTO teams (id, name, metadata, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) RETURNING *')
			.bind(input.id ?? newId(), input.name, JSON.stringify(input.metadata ?? {}), now);
	}

	createProjectStatement(input: { id?: string; teamId: string; name: string; metadata?: JsonObject }): D1PreparedStatement {
		const now = nowMs();
		return this.db
			.prepare('INSERT INTO projects (id, team_id, name, metadata, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) RETURNING *')
			.bind(input.id ?? newId(), input.teamId, input.name, JSON.stringify(input.metadata ?? {}), now);
	}

	/**
	 * Oldest project named `name` in the team, created first when missing. The
	 * insert is a single INSERT … WHERE NOT EXISTS statement and SQLite runs
	 * statements one at a time, so concurrent resolvers cannot both create it.
	 */
	async findOrCreateProjectByName(teamId: string, name: string): Promise<{ project: Project; created: boolean }> {
		const id = newId();
		const now = nowMs();
		const [, found] = await this.db.batch<ProjectRow>([
			this.db
				.prepare(
					`INSERT INTO projects (id, team_id, name, metadata, created_at, updated_at)
					 SELECT ?1, ?2, ?3, '{}', ?4, ?4
					 WHERE NOT EXISTS (SELECT 1 FROM projects WHERE team_id = ?2 AND name = ?3)`,
				)
				.bind(id, teamId, name, now),
			this.db
				.prepare('SELECT * FROM projects WHERE team_id = ?1 AND name = ?2 ORDER BY created_at, id LIMIT 1')
				.bind(teamId, name),
		]);
		const row = found!.results[0]!;
		return { project: mapProjectRow(row), created: row.id === id };
	}

	async getProjectForTeam(projectId: string, teamId: string): Promise<Project | null> {
		const row = await this.db
			.prepare('SELECT * FROM projects WHERE id = ?1 AND team_id = ?2')
			.bind(projectId, teamId)
			.first<ProjectRow>();
		return row ? mapProjectRow(row) : null;
	}

	createAuditLogStatement(input: {
		id?: string;
		teamId?: string | null;
		projectId?: string | null;
		actorId?: string | null;
		apiKeyId?: string | null;
		action: string;
		resourceType: string;
		resourceId?: string | null;
		details?: JsonObject;
	}): D1PreparedStatement {
		return this.db
			.prepare(
				`INSERT INTO audit_log (id, team_id, project_id, actor_id, api_key_id, action, resource_type, resource_id, details, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
				 RETURNING *`,
			)
			.bind(
				input.id ?? newId(),
				input.teamId ?? null,
				input.projectId ?? null,
				input.actorId ?? null,
				input.apiKeyId ?? null,
				input.action,
				input.resourceType,
				input.resourceId ?? null,
				JSON.stringify(input.details ?? {}),
				nowMs(),
			);
	}

	async createAuditLog(input: Parameters<AuthRepository['createAuditLogStatement']>[0]): Promise<AuditLog> {
		const row = await this.createAuditLogStatement(input).first<AuditLogRow>();
		return mapAuditLogRow(row!);
	}
}

export function mapApiKeyRow(row: ApiKeyRow): ApiKey {
	return {
		id: row.id,
		keyHash: row.key_hash,
		teamId: row.team_id,
		projectId: row.project_id,
		actorId: row.actor_id,
		scopes: toJsonArray(row.scopes),
		revokedAtEpoch: toEpochOrNull(row.revoked_at),
		expiresAtEpoch: toEpochOrNull(row.expires_at),
		createdAtEpoch: row.created_at,
		updatedAtEpoch: row.updated_at,
	};
}

export function mapTeamRow(row: TeamRow): Team {
	return {
		id: row.id,
		name: row.name,
		metadata: toJsonObject(row.metadata),
		createdAtEpoch: row.created_at,
		updatedAtEpoch: row.updated_at,
	};
}

export function mapProjectRow(row: ProjectRow): Project {
	return { ...mapTeamRow(row), teamId: row.team_id };
}

function mapAuditLogRow(row: AuditLogRow): AuditLog {
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		actorId: row.actor_id,
		apiKeyId: row.api_key_id,
		action: row.action,
		resourceType: row.resource_type,
		resourceId: row.resource_id,
		details: toJsonObject(row.details),
		createdAtEpoch: row.created_at,
	};
}

export type { ApiKeyRow, TeamRow, ProjectRow };
