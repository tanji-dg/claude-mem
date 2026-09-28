// SPDX-License-Identifier: Apache-2.0
//
// Turn arbitrary user text into a safe FTS5 MATCH expression.
//
// FTS5 has its own query grammar (AND/OR/NOT/NEAR, quotes, parentheses,
// column filters, `*` prefixes, `^` anchors); feeding it raw input makes
// `"foo AND (` a syntax error. Postgres' websearch_to_tsquery never throws,
// so neither may we: every word-ish token is extracted and emitted as its own
// double-quoted string (FTS5 treats a quoted string as a literal phrase, so no
// operator can survive), joined by implicit AND — the same default
// conjunction websearch_to_tsquery applies between bare words.

const MAX_TERMS = 16;
const MAX_TERM_LENGTH = 64;

/**
 * Returns the MATCH expression, or null when the input contains no searchable
 * token (callers then return an empty result instead of querying).
 */
export function buildFtsMatchQuery(raw: string): string | null {
	const tokens = raw.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? [];
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const token of tokens) {
		const term = token.toLowerCase().slice(0, MAX_TERM_LENGTH);
		// Bare boolean keywords carry no meaning once quoted; skip them so
		// "foo AND bar" searches foo+bar rather than requiring the word "and".
		if (term === 'and' || term === 'or' || term === 'not' || term === 'near') continue;
		if (seen.has(term)) continue;
		seen.add(term);
		terms.push(`"${term}"`);
		if (terms.length >= MAX_TERMS) break;
	}
	return terms.length > 0 ? terms.join(' ') : null;
}
