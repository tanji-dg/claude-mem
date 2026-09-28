// SPDX-License-Identifier: Apache-2.0
//
// Request-time generation trigger. Called right after a `queued` job row is
// committed (event ingest with generate=true, session end). The job row is
// the durable record; this is only the fast path — anything it skips or loses
// (isolate eviction, provider error due for retry, deadline) is picked up by
// the 1/min cron via runDueJobs() → GenerationJobsRepository.claimDue().
//
// Contract: must not throw and must not block the response — work runs in
// ctx.waitUntil().
//
// Budgets (Free plan). The generation shares its invocation with the ingest
// request that scheduled it:
//   - D1: 50 queries per invocation. Ingest used ~2 per event plus auth and
//     session lookups, and `?wait=true` polls up to 25 more. So at most ONE
//     job per invocation is processed here (≤ MAX_QUERIES_PER_JOB queries),
//     and none for batches larger than REQUEST_TIME_MAX_BATCH; the rest stay
//     `queued` for the cron.
//   - waitUntil: ~30 s after the response. The provider call is aborted at
//     REQUEST_TIME_DEADLINE_MS and the job handed back to the cron without
//     charging the attempt. If the isolate dies anyway, the row stays
//     `processing` and claimDue reclaims it once the lock is STALE_LOCK_MS old.

import { GenerationJobsRepository } from '../storage/generation-jobs';
import { newId, nowMs } from '../storage/utils';
import { processClaimedJob } from './process';
import { buildProvider } from './providers';

export const REQUEST_TIME_DEADLINE_MS = 25_000;

/** Batches with more jobs than this get no request-time generation (their ingest already spent the D1 budget). */
export const REQUEST_TIME_MAX_BATCH = 5;

// Jobs scheduled during one invocation. Routes call scheduleGeneration()
// synchronously once per job; the decision runs after that loop, when the
// batch size is known.
const scheduledByInvocation = new WeakMap<ExecutionContext, string[]>();

export function scheduleGeneration(env: Env, ctx: ExecutionContext, jobId: string): void {
	const pending = scheduledByInvocation.get(ctx);
	if (pending) {
		pending.push(jobId);
		return;
	}
	const jobs = [jobId];
	scheduledByInvocation.set(ctx, jobs);
	ctx.waitUntil(
		(async () => {
			// Yield once so every scheduleGeneration() call of this request lands in `jobs`.
			await null;
			if (jobs.length > REQUEST_TIME_MAX_BATCH) return;
			await runOne(env, jobs[0]!);
		})().catch((error: unknown) => {
			console.error(
				JSON.stringify({
					level: 'ERROR',
					component: 'GENERATION',
					message: 'request-time generation failed; the cron will retry',
					jobId,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		}),
	);
}

async function runOne(env: Env, jobId: string): Promise<void> {
	const provider = buildProvider(env);
	if (!provider) return; // not configured: the job stays queued
	const job = await new GenerationJobsRepository(env.DB).claimById(jobId, nowMs(), `request:${newId()}`);
	if (!job) return; // taken by the cron, not due, or not claimable
	await processClaimedJob(env, job, {
		provider,
		signal: AbortSignal.timeout(REQUEST_TIME_DEADLINE_MS),
		onAbort: 'defer',
	});
}
