// SPDX-License-Identifier: Apache-2.0
//
// Response helpers. Error bodies keep the Express runtime's shape
// ({ error: 'ValidationError' | 'Forbidden' | …, message?, issues? }) so
// ServerClient error classification behaves identically against both.

export function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
	});
}

export function errorResponse(status: number, error: string, message?: string): Response {
	return json(status, message === undefined ? { error } : { error, message });
}

export function text(status: number, body: string): Response {
	return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export function validationError(issues: unknown): Response {
	return json(400, { error: 'ValidationError', issues });
}

/** Parse a JSON body; an empty body reads as `{}` (like express.json()). */
export async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
	const raw = await request.text();
	if (raw.trim().length === 0) return { ok: true, value: {} };
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch {
		return { ok: false, response: errorResponse(400, 'ValidationError', 'Request body must be valid JSON') };
	}
}

/**
 * Map repository ownership errors to 403 exactly like ServerV1PostgresRoutes
 * handleDbError; anything else is a 500 with a generic message.
 */
export function dbErrorResponse(error: unknown, action: string): Response {
	const message = error instanceof Error ? error.message : String(error);
	if (
		message.includes('project_id must belong to team_id') ||
		message.includes('server_session_id must belong') ||
		message.includes('agent_event source_id must belong')
	) {
		return errorResponse(403, 'Forbidden', message);
	}
	console.error(JSON.stringify({ level: 'ERROR', action, message }));
	return errorResponse(500, 'InternalError', 'Failed to persist event');
}
