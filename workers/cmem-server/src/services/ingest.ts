// SPDX-License-Identifier: Apache-2.0
//
// D1 port of src/server/services/{IngestEventsService,EndSessionService}.ts.
// Each creates the source row(s) and the outbox job row(s) with the SAME
// payload the BullMQ path persists (ServerGenerationJobPayload in
// src/server/jobs/types.ts), so the generator can validate it with
// assertServerGenerationJobPayload exactly as ProviderObservationGenerator does.
//
// Atomicity without interactive transactions: events go in one statement/batch;
// jobs go in a second batch. If the second write is lost, a client retry hits
// the event idempotency key (returns the same row) and the job idempotency key
// creates the missing job — no duplicate rows either way.

import type { AgentEvent, CreateAgentEventInput } from '../storage/agent-events';
import { AgentEventsRepository } from '../storage/agent-events';
import type { ObservationGenerationJob, JobRow } from '../storage/generation-jobs';
import { buildServerJobId, EVENT_JOB_TYPE, GenerationJobsRepository, mapJobRow, SUMMARY_JOB_TYPE } from '../storage/generation-jobs';
import type { ServerSession } from '../storage/server-sessions';
import { ServerSessionsRepository } from '../storage/server-sessions';
import { newId } from '../storage/utils';

export interface IngestOptions {
	generate: boolean;
	apiKeyId: string | null;
	actorId: string | null;
	/** null ⇒ each event's own sourceAdapter (mixed batches stay accurate). */
	sourceAdapter: string | null;
	requestId: string | null;
}

export interface IngestResult {
	event: AgentEvent;
	outbox: ObservationGenerationJob | null;
}

export async function ingestEvents(db: D1Database, inputs: CreateAgentEventInput[], opts: IngestOptions): Promise<IngestResult[]> {
	const eventsRepo = new AgentEventsRepository(db);
	const events = inputs.length === 1 ? [await eventsRepo.create(inputs[0]!)] : await eventsRepo.createMany(inputs);
	if (!opts.generate) return events.map((event) => ({ event, outbox: null }));

	const jobsRepo = new GenerationJobsRepository(db);
	const statements = await Promise.all(
		events.map(async (event) => {
			const outboxId = newId();
			return jobsRepo.createStatement({
				id: outboxId,
				projectId: event.projectId,
				teamId: event.teamId,
				sourceType: 'agent_event',
				sourceId: event.id,
				agentEventId: event.id,
				serverSessionId: event.serverSessionId,
				jobType: EVENT_JOB_TYPE,
				bullmqJobId: await buildServerJobId({
					kind: 'event',
					team_id: event.teamId,
					project_id: event.projectId,
					source_type: 'agent_event',
					source_id: event.id,
				}),
				// = buildEventBullmqPayload in IngestEventsService.ts
				payload: {
					kind: 'event',
					team_id: event.teamId,
					project_id: event.projectId,
					source_type: 'agent_event',
					source_id: event.id,
					generation_job_id: outboxId,
					agent_event_id: event.id,
					api_key_id: opts.apiKeyId,
					actor_id: opts.actorId,
					source_adapter: opts.sourceAdapter ?? event.sourceAdapter ?? 'api',
					request_id: opts.requestId,
				},
			});
		}),
	);
	const results = await db.batch<JobRow>(statements);
	return events.map((event, index) => {
		const row = results[index]!.results[0];
		if (!row) throw new Error('agent_event source_id must belong to project_id and team_id');
		return { event, outbox: mapJobRow(row) };
	});
}

export interface EndSessionInput {
	sessionId: string;
	projectId: string;
	teamId: string;
	apiKeyId: string | null;
	actorId: string | null;
	sourceAdapter: string | null;
	requestId: string | null;
}

export interface EndSessionResult {
	session: ServerSession | null;
	outbox: ObservationGenerationJob | null;
}

/** Idempotent end: re-ending returns the same session and the same summary job. */
export async function endSession(db: D1Database, input: EndSessionInput): Promise<EndSessionResult> {
	const ended = await new ServerSessionsRepository(db).endSession({ id: input.sessionId, projectId: input.projectId, teamId: input.teamId });
	if (!ended) return { session: null, outbox: null };
	const outboxId = newId();
	const outbox = await new GenerationJobsRepository(db).create({
		id: outboxId,
		projectId: ended.projectId,
		teamId: ended.teamId,
		sourceType: 'session_summary',
		sourceId: ended.id,
		serverSessionId: ended.id,
		jobType: SUMMARY_JOB_TYPE,
		bullmqJobId: await buildServerJobId({
			kind: 'summary',
			team_id: ended.teamId,
			project_id: ended.projectId,
			source_type: 'session_summary',
			source_id: ended.id,
		}),
		// = buildSummaryJobPayload in src/server/runtime/SessionGenerationPolicy.ts
		payload: {
			kind: 'summary',
			team_id: ended.teamId,
			project_id: ended.projectId,
			source_type: 'session_summary',
			source_id: ended.id,
			generation_job_id: outboxId,
			server_session_id: ended.id,
			api_key_id: input.apiKeyId,
			actor_id: input.actorId,
			source_adapter: input.sourceAdapter ?? 'api',
			request_id: input.requestId,
		},
	});
	return { session: ended, outbox };
}
