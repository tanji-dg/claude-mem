// SPDX-License-Identifier: Apache-2.0
//
// Cron entry point (wrangler.jsonc triggers.crons, every minute): drain due
// generation jobs from the D1 outbox.
//
//   1. failExhaustedStale — `processing` rows whose lock expired after their
//      last attempt become `failed` (1 query).
//   2. claimDue — atomically take up to CRON_BATCH_SIZE runnable rows: fresh
//      `queued`, retries whose next_attempt_at passed, and stale `processing`
//      rows (an isolate died mid-job) with attempts left (1 query).
//   3. Process the claimed jobs concurrently, each ≤ MAX_QUERIES_PER_JOB - 1
//      further queries.
//
// Budgets (Free plan): 2 + 3 × 7 = 23 of the 50 D1 queries per invocation.
// Jobs are processed concurrently, not one after another, because claimDue
// stamps all their locks at once: run sequentially, the last job's lock could
// pass STALE_LOCK_MS before it even started and be claimed again by the next
// tick. For the same reason each provider call is capped at CRON_JOB_TIMEOUT_MS
// (< STALE_LOCK_MS); a timeout is a transient failure and consumes an attempt.

import { GenerationJobsRepository, STALE_LOCK_MS } from '../storage/generation-jobs';
import { newId, nowMs } from '../storage/utils';
import type { JobOutcome } from './process';
import { MAX_QUERIES_PER_JOB, processClaimedJob } from './process';
import { buildProvider } from './providers';

const D1_QUERY_BUDGET = 45; // of 50, leaving headroom
export const CRON_BATCH_SIZE = Math.min(3, Math.floor((D1_QUERY_BUDGET - 2) / MAX_QUERIES_PER_JOB));
export const CRON_JOB_TIMEOUT_MS = STALE_LOCK_MS - 15_000;

export async function runDueJobs(env: Env, _ctx: ExecutionContext): Promise<JobOutcome[]> {
	const jobs = new GenerationJobsRepository(env.DB);
	const now = nowMs();
	const stalled = await jobs.failExhaustedStale(now);
	for (const job of stalled) {
		console.warn(JSON.stringify({ level: 'WARN', component: 'GENERATION', message: 'generation job stalled on its final attempt; failed', jobId: job.id }));
	}

	const provider = buildProvider(env);
	if (!provider) return []; // not configured: leave jobs queued

	const claimed = await jobs.claimDue(now, CRON_BATCH_SIZE, { workerId: `cron:${newId()}` });
	return Promise.all(
		claimed.map((job) =>
			processClaimedJob(env, job, {
				provider,
				signal: AbortSignal.timeout(CRON_JOB_TIMEOUT_MS),
				onAbort: 'retry',
			}),
		),
	);
}
