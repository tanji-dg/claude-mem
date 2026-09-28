// Repository-level tests for the D1 outbox primitives Agent C's generator
// builds on (claimDue / transition / failExhaustedStale).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { GenerationJobsRepository, STALE_LOCK_MS } from '../src/storage/generation-jobs';
import { api, bootstrap, eventBody } from './helpers';

const repo = () => new GenerationJobsRepository(env.DB);

async function newJob(occurredAtEpoch = Date.now()): Promise<string> {
	const t = await bootstrap();
	const res = await api('POST', '/v1/events', t.apiKey, eventBody(t.projectId, { occurredAtEpoch }));
	return ((await res.json()) as { generationJob: { id: string } }).generationJob.id;
}

/** Drain everything already due so each test only sees its own rows. */
async function drain(): Promise<void> {
	await env.DB.prepare("UPDATE observation_generation_jobs SET status = 'cancelled' WHERE status IN ('queued', 'processing')").run();
}

describe('GenerationJobsRepository', () => {
	it('transition is guarded by the current status', async () => {
		const id = await newJob();
		const now = Date.now();
		const claimed = await repo().transition(id, ['queued'], 'processing', { attempts: 'increment', lockedAt: now, lockedBy: 'w1' });
		expect(claimed).toMatchObject({ status: 'processing', attempts: 1, lockedAtEpoch: now, lockedBy: 'w1' });
		// A second claimer loses the race.
		expect(await repo().transition(id, ['queued'], 'processing', { attempts: 'increment' })).toBeNull();
		const retry = await repo().transition(id, ['processing'], 'queued', {
			nextAttemptAt: now + 5_000,
			lockedAt: null,
			lockedBy: null,
			lastError: { kind: 'transient', message: 'boom' },
		});
		expect(retry).toMatchObject({ status: 'queued', nextAttemptAtEpoch: now + 5_000, lockedAtEpoch: null, lastError: { kind: 'transient', message: 'boom' } });
		expect(await repo().transition('missing', ['queued'], 'processing')).toBeNull();
	});

	it('claimDue takes fresh and due jobs, skips future retries, reclaims stale locks', async () => {
		await drain();
		const now = Date.now();
		const fresh = await newJob(1);
		const due = await newJob(2);
		const future = await newJob(3);
		const stale = await newJob(4);
		const live = await newJob(5);
		await repo().transition(due, ['queued'], 'queued', { nextAttemptAt: now - 1 });
		await repo().transition(future, ['queued'], 'queued', { nextAttemptAt: now + 60_000 });
		await repo().transition(stale, ['queued'], 'processing', { attempts: 1, lockedAt: now - STALE_LOCK_MS - 1 });
		await repo().transition(live, ['queued'], 'processing', { attempts: 1, lockedAt: now - 1_000 });

		const claimed = await repo().claimDue(now, 10, { workerId: 'cron-test' });
		expect(new Set(claimed.map((j) => j.id))).toEqual(new Set([fresh, due, stale]));
		for (const job of claimed) {
			expect(job).toMatchObject({ status: 'processing', lockedBy: 'cron-test', lockedAtEpoch: now, nextAttemptAtEpoch: null });
		}
		expect(claimed.find((j) => j.id === stale)!.attempts).toBe(2);
		// Nothing left to claim, and the limit is honored.
		expect(await repo().claimDue(now, 10)).toEqual([]);
		expect(await repo().claimDue(now + 61_000, 0)).toEqual([]);
	});

	it('failExhaustedStale fails stale jobs that used every attempt', async () => {
		await drain();
		const now = Date.now();
		const exhausted = await newJob();
		await repo().transition(exhausted, ['queued'], 'processing', { attempts: 3, lockedAt: now - STALE_LOCK_MS - 1 });
		expect(await repo().claimDue(now, 10)).toEqual([]);
		const failed = await repo().failExhaustedStale(now);
		expect(failed.map((j) => j.id)).toEqual([exhausted]);
		expect(failed[0]).toMatchObject({ status: 'failed', failedAtEpoch: now, lastError: { reason: 'stalled' } });
	});

	it('claimDue and the inject/list hot paths are index-backed (no full scans)', async () => {
		const plans: Record<string, string> = {
			claim: "SELECT id FROM observation_generation_jobs WHERE status = 'queued' AND next_attempt_at <= 1",
			stale: "SELECT id FROM observation_generation_jobs WHERE status = 'processing' AND locked_at <= 1",
			recent: "SELECT * FROM observations WHERE team_id = 't' AND project_id = 'p' ORDER BY created_at DESC LIMIT 50",
			summary: "SELECT * FROM observations WHERE team_id = 't' AND project_id = 'p' AND kind = 'summary' ORDER BY created_at DESC LIMIT 1",
			link: "SELECT id FROM server_sessions WHERE team_id = 't' AND project_id = 'p' AND content_session_id = 'c' AND platform_source = 'claude' ORDER BY started_at DESC LIMIT 1",
		};
		for (const [name, sql] of Object.entries(plans)) {
			const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
			const detail = results.map((r) => r.detail).join(' | ');
			expect(detail, name).toMatch(/USING (COVERING )?INDEX/);
			expect(detail, name).not.toMatch(/^SCAN observation|SCAN server_sessions|USE TEMP B-TREE/);
		}
	});
});
