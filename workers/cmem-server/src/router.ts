// SPDX-License-Identifier: Apache-2.0
//
// Minimal method + path router (same hand-rolled approach as
// workers/sync-hub/src/index.ts). `:name` segments capture one path segment.

import { errorResponse } from './http';

export interface RouteContext {
	request: Request;
	env: Env;
	ctx: ExecutionContext;
	url: URL;
	params: Record<string, string>;
	/** Correlation id: inbound X-Request-Id when sane, else a fresh UUID. */
	requestId: string;
}

export type RouteHandler = (rc: RouteContext) => Promise<Response> | Response;

interface Route {
	method: string;
	segments: string[];
	handler: RouteHandler;
}

export class Router {
	private readonly routes: Route[] = [];

	on(method: string | string[], path: string, handler: RouteHandler): this {
		for (const m of Array.isArray(method) ? method : [method]) {
			this.routes.push({ method: m, segments: splitPath(path), handler });
		}
		return this;
	}

	async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const segments = splitPath(url.pathname);
		let pathMatched = false;
		for (const route of this.routes) {
			const params = matchSegments(route.segments, segments);
			if (!params) continue;
			pathMatched = true;
			if (route.method !== request.method) continue;
			return route.handler({ request, env, ctx, url, params, requestId: resolveRequestId(request) });
		}
		return pathMatched ? errorResponse(405, 'MethodNotAllowed') : errorResponse(404, 'NotFound');
	}
}

function splitPath(path: string): string[] {
	return path.split('/').filter((s) => s.length > 0);
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
	if (pattern.length !== actual.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < pattern.length; i++) {
		const p = pattern[i]!;
		const a = actual[i]!;
		if (p.startsWith(':')) {
			try {
				params[p.slice(1)] = decodeURIComponent(a);
			} catch {
				return null;
			}
		} else if (p !== a) {
			return null;
		}
	}
	return params;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function resolveRequestId(request: Request): string {
	const inbound = request.headers.get('X-Request-Id')?.trim() ?? '';
	return REQUEST_ID_PATTERN.test(inbound) ? inbound : crypto.randomUUID();
}
