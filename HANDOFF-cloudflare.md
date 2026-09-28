# 引き継ぎ：claude-mem の Cloudflare 対応

- 作業ブランチ：`claude/cloudflare-alternatives-ab734p`（このファイルと同じ内容を `handoff/cloudflare-alternatives` にも push 済み）
- 実装コミット：`63e5a4b` → `80ef031` → `680a24a` → `3b2791d`
- 未コミットの変更：なし

## (a) 課題の要約

出発点は「claude-mem は Cloudflare（Workers / D1 / Vectorize）を直接サポートしていない。VPS に置き、Cloudflare Tunnel や Access を前段に置くのが最適」という分析だった。これをコードに照らして検証した。

ユーザーの立場は次のとおり。
- Cloudflare でサポートできない技術的な理由はない。
- 「現実的ではない」は誤りで、Pro 版への誘導ではないか。
- **Free プランだけで動かしたい。**

これを受けて、server ランタイムを Cloudflare Workers の Free プランへ移植した。

## (b) 判明した事実と結論

**当初の分析のうち、誤っていた点**
- 「Cloudflare は使っていない」は誤り。Pro のクラウド同期ハブ `workers/sync-hub` は、Cloudflare Worker と Durable Objects（SQLite）で本番稼働していた。
- 「server ランタイムはローカル SQLite」は誤り。実際は Postgres と Valkey（BullMQ）を使う（`docker-compose.yml`）。

**Tunnel 案は危険**
- 通常のワーカーを cloudflared で公開すると、`GET /api/settings` からプロバイダーの API キーが漏れる。
- 公式ドキュメントも禁止している（`docs/public/configuration.mdx:222`）。

**sync-hub が Cloudflare から Fly + Neon へ移った理由**（#4232）
- Free プランの上限を超えたため。技術的な不可能ではない。
  - Durable Objects の無料枠のリクエスト数：`workers/sync-hub/test/sync-hub.test.ts:1532` に「Exceeded allowed volume of requests in Durable Objects free tier」
  - SQLite の読み取り行数：`LENGTH(seq)` の条件でインデックスが効かず、全ユーザーの `canonical_ops` を全件走査していた（#4218）
  - エッジの 1027/429 と、クライアントの再送の嵐（#4231）
- 設計は最初から有料の Workers Paid を前提にしていた（`plans/2026-07-17-phase5-two-lane-sync.md:5`）。
- 多数のユーザーを 1 アカウントで捌いていたのが原因で、個人用途なら Free に収まる見込み。

**server ランタイムの移植しやすさ**
- LLM プロバイダー（Claude、Gemini、OpenRouter）は fetch だけで動く。
- ベクトル検索はなく、全文検索（FTS）だけ。
- ライセンスは Apache-2.0。

**既存の server モードの欠陥**
- SessionStart の文脈注入が、常にローカルワーカーの SQLite を読んでいた。
- そのため、サーバーに保存した記憶が自動で注入されなかった。今回修正済み。

## (c) 検討した代替アプローチと評価

| 案 | 評価 |
|---|---|
| VPS / Fly に server ランタイムを置き、前段に Cloudflare Tunnel や Access | 動くが Cloudflare は脇役。通常のワーカーを Tunnel で公開するのは危険。Access はフックが service token を送れないため使えない |
| Cloudflare Containers に既存の Docker イメージを載せる | 変更は最小だが、Free では使えない可能性が高い |
| Workers Paid + DO + Queues | 可能だが有料 |
| **Workers + D1 + Cron（Free）へのネイティブ移植** | **採用**。範囲は「API 互換＋サーバーからの注入」（ユーザー選択の B） |

## (d) 変更したファイルと現在の状態

**プラグイン側**（`63e5a4b`）
- 変更したファイル：
  - `src/services/hooks/server-client.ts`：`contextInject()` を追加
  - `src/cli/handlers/context.ts`：server モードでは `GET /v1/context/inject` から取得し、一時的な失敗ならローカルワーカーに切り替える
  - `src/cli/handlers/session-init.ts`：server モードでも `/v1/context` 経由で semantic inject を行う
  - `src/server/routes/v1/ServerV1PostgresRoutes.ts`：Postgres 版にも `GET /v1/context/inject` を追加（`renderContextInjectMarkdown`）
- 追加・変更したテスト：
  - `tests/hooks/server-client.test.ts`
  - `tests/cli/handlers/context-server-runtime.test.ts`
  - `tests/cli/handlers/session-init-server-beta-context.test.ts`
  - `tests/server/runtime/context-inject-route.test.ts`
- 状態：35 件が成功。`bun test tests/server` の失敗 21 件は、変更前から同じものが失敗している。

**Worker 本体 `workers/cmem-server/`**（`80ef031`、`3b2791d`）
- `migrations/0001_init.sql`：D1 のスキーマ。FTS5 を使い、よく使うクエリはすべてインデックスが効く（`EXPLAIN` で確認済み）。
- `src/storage/*`：D1 版のリポジトリ。
- `src/auth.ts`：SHA-256 の API キー認証。installer が発行するスコープも、ルートごとに受け付ける。
- `src/routes/*`：`/v1/sessions`、`/v1/events`（`batch` は最大 20 件）、`/v1/memories`、`/v1/search`、`/v1/context`、`/v1/context/inject`、`/v1/jobs/:id`、`/v1/mcp`、`/v1/admin/bootstrap`。
- `src/generation/*`：取り込み時に `ctx.waitUntil` で 1 件を即時に生成し、1 分おきの Cron が再試行と、止まったジョブの回収を行う。
  - D1 クエリ数は、成功した 1 件で 6、Cron 1 回で 17。
  - Free プランでは 1 回の呼び出しあたり約 50 クエリまで。
- `src/shims/*`：Node 依存を差し替える。logger と、`plugin/modes` を静的に import する ModeManager。
- `build/aliases.mjs` と `scripts/build.mjs`：wrangler の `alias` は相対 import に効かないため、esbuild で独自にビルドする。
- 状態：
  - `bun run test` は 75 件すべて成功、`tsc --noEmit` も問題なし。
  - バンドルは圧縮後 331 KiB（上限 3 MiB）。

**CI とドキュメント**（`680a24a`）
- `.github/workflows/ci.yml`：`cmem-server` ジョブ（型チェック、vitest、`wrangler deploy --dry-run`）。
- `workers/cmem-server/README.md`：デプロイ手順と、Free プランの上限の目安。
- `docs/public/self-hosting-cloudflare.mdx` と `docs.json`：ドキュメントのページとナビゲーション。

## (e) 未完了の残タスクと次にやること

1. **実際の Cloudflare へのデプロイは未実施。**
   - この環境からは `api.cloudflare.com` がネットワークポリシーで拒否され、認証情報もない。
   - 必要なもの：`CLOUDFLARE_API_TOKEN`（Workers Scripts:Edit と D1:Edit）、`CLOUDFLARE_ACCOUNT_ID`、プロバイダーのキー。
   - 手順は `workers/cmem-server/README.md` のとおり：`d1 create` → `wrangler.jsonc` の `database_id` を更新 → `migrations apply --remote` → `secret put` → `deploy` → `/v1/admin/bootstrap`。
2. **ローカルでの通し実行は未実施。** `wrangler dev` を起動し、実際の hooks をつないで SessionStart で注入されることを確かめる。
3. **Free プランの上限値は未確認。** 記憶に基づく数値なので、公式ページで再確認する。
4. **CPU 10ms の実測がない。** 要約の入力上限は 120KB に下げてある。
5. 既知の制限と後回しにした課題：
   - `platformSource` で絞り込んでいない（Postgres 版も同じ）。
   - キーの失効・再発行の API がない。bootstrap は呼ぶたびに新しいキーを作る。
   - `src/cli/handlers/user-message.ts` は、server モードでもローカルワーカーを参照する。
   - installer の既存バグ：MCP の URL を `/mcp` と案内している（正しくは `/v1/mcp`）。bootstrap のスコープが Postgres 版のルートに合わず、403 になる。
   - `/healthz` の runtime 表示が `server-beta` のまま。
6. **`plugin/scripts` は再生成していない。** このリポジトリでは、バージョンを上げるときにまとめて再生成する慣例。
7. **PR は未作成。** ユーザーから依頼があれば作る。
