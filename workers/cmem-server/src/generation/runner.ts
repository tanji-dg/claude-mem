// SPDX-License-Identifier: Apache-2.0
//
// Cron entry point (wrangler.jsonc triggers.crons, every minute): drain due
// generation jobs from the D1 outbox.

export async function runDueJobs(env: Env, ctx: ExecutionContext): Promise<void> {
	// TODO(Agent C): GenerationJobsRepository.failExhaustedStale(now), then
	// claimDue(now, N) and process each claimed job (retry transient/rate-limit
	// failures by transitioning back to 'queued' with a future nextAttemptAt).
	void env;
	void ctx;
}
