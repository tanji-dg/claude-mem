// SPDX-License-Identifier: Apache-2.0
//
// SessionStart markdown for GET /v1/context/inject. Mirrors
// renderContextInjectMarkdown in src/server/routes/v1/ServerV1PostgresRoutes.ts
// (not imported: that module pulls express/pg) so hooks get the same text from
// either runtime. No rows → '' (nothing to inject).

import type { Observation } from '../storage/observations';

export const CONTEXT_INJECT_LIMIT = 50;
const CONTEXT_INJECT_SUMMARY_MAX_CHARS = 1500;
const CONTEXT_INJECT_TITLE_MAX_CHARS = 160;

type InjectObservation = Pick<Observation, 'kind' | 'content' | 'metadata' | 'createdAtEpoch'>;

/**
 * `observations` must be newest first. The newest non-empty `summary` row
 * becomes "Last session"; every other row is one dated bullet.
 */
export function renderContextInjectMarkdown(observations: readonly InjectObservation[], options: { projectName: string; now?: Date }): string {
	if (observations.length === 0) return '';
	const lastSummary = observations.find((o) => o.kind === 'summary' && o.content.trim().length > 0);
	const bullets = observations
		.filter((o) => o.kind !== 'summary')
		.map((o) => {
			const title = contextInjectTitle(o);
			return title ? `- ${formatInjectDate(o.createdAtEpoch)} [${o.kind}] ${title}` : null;
		})
		.filter((line): line is string => line !== null);

	const now = options.now ?? new Date();
	const lines: string[] = [`# [${options.projectName}] recent context (server), ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`];
	if (lastSummary) {
		lines.push(
			'',
			`## Last session (${formatInjectDate(lastSummary.createdAtEpoch)})`,
			'',
			truncateInject(lastSummary.content.trim(), CONTEXT_INJECT_SUMMARY_MAX_CHARS),
		);
	}
	if (bullets.length > 0) {
		lines.push('', '## Recent observations', '', ...bullets);
	}
	return `${lines.join('\n')}\n`;
}

function contextInjectTitle(observation: Pick<Observation, 'content' | 'metadata'>): string {
	const metaTitle = observation.metadata && typeof observation.metadata.title === 'string' ? observation.metadata.title.trim() : '';
	const firstLine = metaTitle || (observation.content.split('\n').find((line) => line.trim().length > 0) ?? '').trim();
	return truncateInject(firstLine.replace(/\s+/g, ' '), CONTEXT_INJECT_TITLE_MAX_CHARS);
}

function formatInjectDate(epochMs: number): string {
	const date = new Date(epochMs);
	return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'unknown-date';
}

function truncateInject(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
