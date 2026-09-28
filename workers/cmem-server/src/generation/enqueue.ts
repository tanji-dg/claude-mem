// SPDX-License-Identifier: Apache-2.0
//
// Request-time generation trigger. Called right after a `queued` job row is
// committed (event ingest with generate=true, session end). The job row is
// the durable record; this is only the fast path — anything it misses (isolate
// eviction, provider error due for retry) is picked up by the 1/min cron via
// runDueJobs() → GenerationJobsRepository.claimDue().
//
// Contract: must not throw and must not block the response — schedule work
// with ctx.waitUntil().

export function scheduleGeneration(env: Env, ctx: ExecutionContext, jobId: string): void {
	// TODO(Agent C): claim `jobId` (GenerationJobsRepository.transition(jobId,
	// ['queued'], 'processing', { attempts: 'increment', lockedAt, lockedBy })),
	// run the configured provider, persist observations, and complete/retry/fail
	// the job — all inside ctx.waitUntil(...).
	void env;
	void ctx;
	void jobId;
}
