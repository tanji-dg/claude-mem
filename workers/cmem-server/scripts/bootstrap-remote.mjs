// SPDX-License-Identifier: Apache-2.0
//
// Mint the first API key for a deployed cmem-server in one step:
//   1. generate a random CMEM_ADMIN_TOKEN and `wrangler secret put` it (stdin,
//      so it never reaches argv, the terminal or shell history);
//   2. wait until /v1/admin/bootstrap sees it, then call it;
//   3. write URL, API key and project id to a 0600 env file (never printed);
//   4. `wrangler secret delete` the admin token and wait for the route to go
//      back to 404, so no admin surface is left behind.
//
// Usage (after `wrangler deploy`):
//   node scripts/bootstrap-remote.mjs --url https://cmem-server.<sub>.workers.dev
// Options:
//   --out <file>          credentials file (default ~/.cloudflare/cmem-server.env)
//   --team <name>         team name   (default "default")
//   --project <name>      project name (default "default")
//   --keep-admin-token    skip step 4
//   --no-secret           skip steps 1 and 4; use CMEM_ADMIN_TOKEN from the
//                         environment (token already set, or `wrangler dev`)

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PACKAGE_ROOT } from '../build/aliases.mjs';

const { values: opts } = parseArgs({
	options: {
		url: { type: 'string' },
		out: { type: 'string', default: resolve(homedir(), '.cloudflare', 'cmem-server.env') },
		team: { type: 'string', default: 'default' },
		project: { type: 'string', default: 'default' },
		'keep-admin-token': { type: 'boolean', default: false },
		'no-secret': { type: 'boolean', default: false },
	},
});

function fail(message) {
	console.error(`bootstrap-remote: ${message}`);
	process.exit(1);
}

if (!opts.url) fail('--url is required (the URL `wrangler deploy` printed)');
const baseUrl = opts.url.replace(/\/+$/, '');
const outFile = resolve(opts.out);
if (existsSync(outFile)) fail(`${outFile} already exists; move it away or pass another --out`);

const manageSecret = !opts['no-secret'];
const adminToken = manageSecret ? randomBytes(24).toString('hex') : (process.env.CMEM_ADMIN_TOKEN ?? '');
if (!adminToken) fail('--no-secret needs CMEM_ADMIN_TOKEN in the environment');

/** Runs the package's wrangler. `input` is piped to stdin; without it wrangler
 * shares the terminal (so it can ask for confirmation itself). */
function wrangler(args, input) {
	const bin = resolve(PACKAGE_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
	if (!existsSync(bin)) fail('wrangler is not installed; run `bun install` in workers/cmem-server');
	const result = spawnSync(process.execPath, [bin, ...args], {
		cwd: PACKAGE_ROOT,
		input,
		stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
		env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
	});
	if (result.status !== 0) fail(`wrangler ${args.join(' ')} exited with ${result.status}`);
}

function bootstrap() {
	return fetch(`${baseUrl}/v1/admin/bootstrap`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ teamName: opts.team, projectName: opts.project }),
	});
}

/**
 * Polls the admin gate until `done(status)` or the timeout. The probe sends a
 * wrong token, so it never mints a key: 404 while CMEM_ADMIN_TOKEN is unset,
 * 403 once it is live.
 */
async function waitForStatus(done, label, timeoutMs = 90_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const res = await fetch(`${baseUrl}/v1/admin/bootstrap`, {
			method: 'POST',
			headers: { Authorization: 'Bearer probe-not-the-admin-token' },
		}).catch(() => null);
		const status = res?.status ?? 0;
		if (done(status)) return status;
		if (Date.now() > deadline) fail(`timed out waiting for ${label} (last HTTP ${status})`);
		await new Promise((r) => setTimeout(r, 3_000));
	}
}

const health = await fetch(`${baseUrl}/healthz`).catch((error) => fail(`cannot reach ${baseUrl}: ${error.message}`));
if (!health.ok) fail(`${baseUrl}/healthz answered HTTP ${health.status}; is the Worker deployed?`);

if (manageSecret) {
	console.log('Setting CMEM_ADMIN_TOKEN …');
	wrangler(['secret', 'put', 'CMEM_ADMIN_TOKEN'], adminToken);
	await waitForStatus((s) => s === 403, 'the admin token to go live');
}

const res = await bootstrap();
const body = await res.json().catch(() => ({}));
if (res.status !== 201 || !body.apiKey) {
	fail(`bootstrap failed: HTTP ${res.status} ${JSON.stringify(body)}`);
}

mkdirSync(dirname(outFile), { recursive: true, mode: 0o700 });
writeFileSync(
	outFile,
	[
		`# cmem-server credentials, minted ${new Date().toISOString()}`,
		`CLAUDE_MEM_SERVER_URL=${baseUrl}`,
		`CLAUDE_MEM_SERVER_API_KEY=${body.apiKey}`,
		`CLAUDE_MEM_SERVER_PROJECT_ID=${body.projectId}`,
		`CMEM_TEAM_ID=${body.teamId}`,
		'',
	].join('\n'),
	{ mode: 0o600, flag: 'wx' },
);
console.log(`API key minted (scopes: ${body.scopes.join(', ')}); saved to ${outFile}`);

if (manageSecret && !opts['keep-admin-token']) {
	console.log('Deleting CMEM_ADMIN_TOKEN …');
	wrangler(['secret', 'delete', 'CMEM_ADMIN_TOKEN']);
	await waitForStatus(
		(s) => s === 404,
		'the admin route to close; the key is saved, but delete the token with `bunx wrangler secret delete CMEM_ADMIN_TOKEN`',
	);
	console.log('Admin route closed (404).');
}

console.log(`
Next: point claude-mem at the server. Copy the three CLAUDE_MEM_SERVER_* lines
from ${outFile} into ~/.claude-mem/settings.json together with
"CLAUDE_MEM_RUNTIME": "server" (or export them as environment variables).`);
