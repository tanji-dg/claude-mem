// SPDX-License-Identifier: Apache-2.0
//
// Wire serializers, ported verbatim from src/server/routes/v1/
// ServerV1PostgresRoutes.ts so ServerClient (src/services/hooks/server-client.ts)
// and MCP clients see byte-compatible shapes from either runtime.

import type { AgentEvent } from '../storage/agent-events';
import type { ObservationGenerationJob } from '../storage/generation-jobs';
import type { Observation } from '../storage/observations';
import type { ServerSession } from '../storage/server-sessions';

/** How the job reached the generator. `enqueued` = scheduled via waitUntil right away. */
export type EnqueueOutcome = 'enqueued' | 'queued_only' | 'skipped';

export function serializeSession(session: ServerSession): Record<string, unknown> {
	return {
		id: session.id,
		projectId: session.projectId,
		teamId: session.teamId,
		externalSessionId: session.externalSessionId,
		contentSessionId: session.contentSessionId,
		agentId: session.agentId,
		agentType: session.agentType,
		platformSource: session.platformSource,
		generationStatus: session.generationStatus,
		metadata: session.metadata,
		startedAtEpoch: session.startedAtEpoch,
		endedAtEpoch: session.endedAtEpoch,
		lastGeneratedAtEpoch: session.lastGeneratedAtEpoch,
		createdAtEpoch: session.createdAtEpoch,
		updatedAtEpoch: session.updatedAtEpoch,
	};
}

export function serializeEvent(event: AgentEvent): Record<string, unknown> {
	return {
		id: event.id,
		projectId: event.projectId,
		teamId: event.teamId,
		serverSessionId: event.serverSessionId,
		sourceAdapter: event.sourceAdapter,
		sourceEventId: event.sourceEventId,
		eventType: event.eventType,
		platformSource: event.platformSource,
		payload: event.payload,
		metadata: event.metadata,
		occurredAtEpoch: event.occurredAtEpoch,
		receivedAtEpoch: event.receivedAtEpoch,
		createdAtEpoch: event.createdAtEpoch,
	};
}

export function serializeObservation(observation: Observation): Record<string, unknown> {
	return {
		id: observation.id,
		projectId: observation.projectId,
		teamId: observation.teamId,
		serverSessionId: observation.serverSessionId,
		kind: observation.kind,
		content: observation.content,
		metadata: observation.metadata,
		createdAtEpoch: observation.createdAtEpoch,
		updatedAtEpoch: observation.updatedAtEpoch,
	};
}

export function serializeGenerationJob(job: ObservationGenerationJob, enqueueState: EnqueueOutcome): Record<string, unknown> {
	return {
		id: job.id,
		status: job.status,
		bullmqJobId: job.bullmqJobId,
		sourceType: job.sourceType,
		sourceId: job.sourceId,
		transport: enqueueState,
		createdAtEpoch: job.createdAtEpoch,
		updatedAtEpoch: job.updatedAtEpoch,
	};
}

/** `?wait=true` response shape: adds attempts to the plain job summary. */
export function serializeJobStatusResponse(job: ObservationGenerationJob, enqueueState: EnqueueOutcome): Record<string, unknown> {
	return {
		id: job.id,
		status: job.status,
		transport: enqueueState,
		bullmqJobId: job.bullmqJobId,
		sourceType: job.sourceType,
		sourceId: job.sourceId,
		attempts: job.attempts,
		maxAttempts: job.maxAttempts,
		createdAtEpoch: job.createdAtEpoch,
		updatedAtEpoch: job.updatedAtEpoch,
	};
}

export function serializeGenerationJobStatus(job: ObservationGenerationJob): Record<string, unknown> {
	return {
		id: job.id,
		projectId: job.projectId,
		teamId: job.teamId,
		sourceType: job.sourceType,
		sourceId: job.sourceId,
		agentEventId: job.agentEventId,
		serverSessionId: job.serverSessionId,
		jobType: job.jobType,
		status: job.status,
		bullmqJobId: job.bullmqJobId,
		attempts: job.attempts,
		maxAttempts: job.maxAttempts,
		nextAttemptAtEpoch: job.nextAttemptAtEpoch,
		completedAtEpoch: job.completedAtEpoch,
		failedAtEpoch: job.failedAtEpoch,
		cancelledAtEpoch: job.cancelledAtEpoch,
		lastError: job.lastError,
		createdAtEpoch: job.createdAtEpoch,
		updatedAtEpoch: job.updatedAtEpoch,
	};
}
