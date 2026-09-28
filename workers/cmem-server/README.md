# cmem-server

The claude-mem **server runtime** (`CLAUDE_MEM_RUNTIME=server`) as a single
Cloudflare Worker that fits the **Workers Free plan**. It speaks the same `/v1`
HTTP API as the Express/Postgres server (`src/server/routes/v1/ServerV1PostgresRoutes.ts`),
so the existing server-mode hooks client and MCP clients connect to it unchanged.

It uses only Workers, D1 and Cron Triggers. No Queues, KV, Vectorize or
Durable Objects.

## Free plan fit

Approximate Free plan limits at the time of writing. Check the current numbers at
[developers.cloudflare.com/workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/)
and [developers.cloudflare.com/d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/)
before relying on them.

| Resource | Free plan limit | How cmem-server stays inside it |
|---|---|---|
| Workers requests | 100,000 / day | One request per hook event, plus one cron run per minute (1,440 / day) |
| Workers CPU | 10 ms / invocation | Waiting on the LLM provider is I/O and does not count as CPU time |
| D1 rows read | 5,000,000 / day | Every hot query is served by an index (see `migrations/0001_init.sql`) |
| D1 rows written | 100,000 / day | About 1,000 observations a day stays well under 10,000 rows written |
| D1 queries | 50 / invocation | Writes are grouped with `D1Database.batch()` |
| Cron Triggers | Included | One trigger, every minute |

## Architecture

| Express runtime | cmem-server |
|---|---|
| Express | Hand-rolled router (`src/router.ts`, same approach as `workers/sync-hub`) |
| Postgres | D1 (SQLite), schema in `migrations/0001_init.sql` |
| `tsvector` full-text search | FTS5 table `observations_fts`, kept in sync by triggers and ranked with `bm25()` |
| BullMQ / Valkey | Outbox table `observation_generation_jobs` |
| Postgres transactions | `D1Database.batch()` and idempotent `INSERT … ON CONFLICT` |

**Observation generation.** Ingesting an event (`POST /v1/events`,
`/v1/events/batch`, `/v1/sessions/:id/end`) writes a job row to
`observation_generation_jobs`. The Worker then generates the observation right
away with `ctx.waitUntil`. A Cron Trigger that runs every minute
(`wrangler.jsonc` → `triggers.crons`) picks up jobs that are still queued,
jobs due for a retry, and jobs whose lock went stale, for example after an
isolate was evicted mid-generation.

**Code reuse.** `scripts/build.mjs` bundles `src/index.ts` with esbuild and
pulls modules from the repo-root `src/` tree: the recall MCP server, zod
schemas, the observation providers and the XML parser. `build/aliases.mjs`
swaps the Node-bound modules for Worker shims (`src/utils/logger.ts` →
`src/shims/logger.ts`, and `ModeManager` → a shim that reads
`plugin/modes/*.json`). This means you need a **full checkout of the repo** to
build. Bare imports resolve from this package's `node_modules`, so you do not
need to install the repo root's dependencies.

### Routes

| Method | Path | Auth |
|---|---|---|
| `GET` | `/healthz`, `/v1/info` | none |
| `POST` | `/v1/admin/bootstrap` | `Authorization: Bearer <CMEM_ADMIN_TOKEN>` |
| `POST` | `/v1/sessions/start`, `/v1/sessions/:id/end` | API key |
| `POST` | `/v1/events`, `/v1/events/batch` (max 20 events) | API key |
| `POST` / `DELETE` | `/v1/memories`, `/v1/memories/:id` | API key |
| `POST` | `/v1/search`, `/v1/context` | API key |
| `GET` | `/v1/context/inject?projectId=&platformSource=` | API key |
| `GET` | `/v1/jobs/:id` | API key |
| `POST` / `GET` | `/v1/mcp` (stateless streamable HTTP) | API key |

Clients send API keys as `Authorization: Bearer <key>` or `X-Api-Key: <key>`.
The server stores only their SHA-256 hash. Keys minted by bootstrap carry
`memories:read` and `memories:write`. The Worker also accepts the narrower
scopes the server-mode installer mints (`events:write`, `sessions:write`,
`observations:read`, `jobs:read`) for their matching routes. Deleting memories
always requires `memories:write` (see `src/auth.ts`).

## Deploy

All commands run from `workers/cmem-server/`.

```bash
bun install
bunx wrangler login

# 1. Create the database, then paste the printed database_id into
#    wrangler.jsonc → d1_databases[0].database_id
bunx wrangler d1 create cmem-server

# 2. Create the schema
bunx wrangler d1 migrations apply cmem-server --remote

# 3. Secrets: the admin token, plus the key for your provider
bunx wrangler secret put CMEM_ADMIN_TOKEN
bunx wrangler secret put ANTHROPIC_API_KEY     # provider "claude" (default)
# bunx wrangler secret put GEMINI_API_KEY      # provider "gemini"
# bunx wrangler secret put OPENROUTER_API_KEY  # provider "openrouter"

# 4. Deploy
bunx wrangler deploy
```

`wrangler deploy` prints the Worker URL, `https://cmem-server.<your-subdomain>.workers.dev`.

### Generation settings (`wrangler.jsonc` → `vars`)

| Var | Default | Meaning |
|---|---|---|
| `CLAUDE_MEM_SERVER_PROVIDER` | `claude` | `claude`, `gemini` or `openrouter`. Only the matching API key secret is needed |
| `CLAUDE_MEM_SERVER_MODEL` | `""` | Empty means the provider's default model |
| `CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS` | `""` | Empty means the provider's default output cap |
| `CLAUDE_MEM_MODE` | `code` | Observation mode, from `plugin/modes/<mode>.json` |
| `CLAUDE_MEM_OPENROUTER_BASE_URL` | unset | Optional OpenRouter-compatible base URL (`OPENROUTER_BASE_URL` also works) |
| `CLAUDE_MEM_SUMMARY_INPUT_BUDGET_BYTES` | `120000` | Byte cap on events fed into a session summary. Kept low for the Free plan's 10 ms CPU budget |

Set API keys with `wrangler secret put`. Never add them to `vars`, because a
var and a secret share one namespace. Until the selected provider's key is set,
generation jobs stay `queued`. The cron picks them up once the key exists.

### Bootstrap the first API key

`POST /v1/admin/bootstrap` creates a team, a project and a project-scoped API
key. It returns the raw key **only once**. The route answers `404` while
`CMEM_ADMIN_TOKEN` is unset.

```bash
curl -sS -X POST "https://cmem-server.<your-subdomain>.workers.dev/v1/admin/bootstrap" \
  -H "Authorization: Bearer $CMEM_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"teamName":"me","projectName":"default"}'
# → {"teamId":"…","projectId":"…","apiKey":"cmem_…","scopes":["memories:read","memories:write"]}
```

`teamName` and `projectName` are optional and default to `"default"`. Every
call creates a new team, project and key.

## Configure claude-mem

Edit `~/.claude-mem/settings.json` (flat keys):

```json
{
  "CLAUDE_MEM_RUNTIME": "server",
  "CLAUDE_MEM_SERVER_URL": "https://cmem-server.<your-subdomain>.workers.dev",
  "CLAUDE_MEM_SERVER_API_KEY": "cmem_…",
  "CLAUDE_MEM_SERVER_PROJECT_ID": "<projectId from bootstrap>"
}
```

Environment variables with the same names override the file. The legacy
`CLAUDE_MEM_SERVER_BETA_*` keys and `CLAUDE_MEM_RUNTIME=server-beta` are still
read as fallbacks (`src/services/hooks/runtime-selector.ts`).

- **SessionStart context** comes from `GET /v1/context/inject`. When the
  server has a transient failure (network, timeout, 5xx, 429), the hook falls
  back to the local worker.
- **MCP recall.** Point MCP clients at `<url>/v1/mcp`:

  ```bash
  claude mcp add --transport http claude-mem \
    https://cmem-server.<your-subdomain>.workers.dev/v1/mcp \
    --header "Authorization: Bearer cmem_…"
  ```

  `claude-mem install --runtime server` prints `<url>/mcp` as the MCP target.
  That path is wrong for both this Worker and the Express server. Use `/v1/mcp`.

## Local development

```bash
cp .dev.vars.example .dev.vars   # set CMEM_ADMIN_TOKEN and a provider key
bunx wrangler d1 migrations apply cmem-server --local
bunx wrangler dev                # http://localhost:8787
```

Local D1 lives in `.wrangler/state`. `wrangler dev` ignores `database_id`.

| Script | Command |
|---|---|
| `bun run test` | vitest with `@cloudflare/vitest-pool-workers` (Miniflare D1, LLM APIs mocked) |
| `bun run typecheck` | `tsc --noEmit` |
| `bunx wrangler deploy --dry-run --outdir dist/dry-run` | Full bundle, no upload, no credentials needed (this is what CI runs) |
| `bun run cf-typegen` | Regenerate `worker-configuration.d.ts` after changing bindings |

## Limitations

- **Search is FTS5 keyword search.** Query terms are ANDed and ranked with
  `bm25()`. There is no vector or semantic search, which matches the
  Express/Postgres server runtime.
- `/v1/events/batch` accepts at most **20** events per request.
- `/v1/context/inject` accepts `platformSource` but does not filter by it. The
  Express runtime behaves the same way: a project's memory is shared across
  agents.
- Context injection returns up to the 50 most recent observations, plus the
  latest session summary.
- The **local worker is still used** for the viewer UI and anything else that
  reads local SQLite. Some hook paths, such as the per-prompt context in
  `src/cli/handlers/user-message.ts`, still call the local worker's
  `/api/context/inject`.
- There is no dashboard, key rotation or revocation API. Bootstrap is the only
  way to mint keys.

## Security

- **Never expose `CMEM_ADMIN_TOKEN`.** Anyone who has it can mint API keys.
  After you bootstrap, you can remove it with
  `bunx wrangler secret delete CMEM_ADMIN_TOKEN`. The route then returns `404`
  again.
- API keys are bearer credentials. Store them only in `settings.json` (or the
  environment) on machines you trust.
- **Cloudflare Access** can sit in front of the Worker. The hooks cannot
  complete an interactive Access login, though. Only an Access *service token*
  would work, and that needs `CF-Access-Client-Id` / `CF-Access-Client-Secret`
  headers, which the claude-mem client does not send today. If you enable
  Access, the hooks will fail.
