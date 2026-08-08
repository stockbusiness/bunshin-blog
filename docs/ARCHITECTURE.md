# ARCHITECTURE

BUNSHIN BLOG Phase 0 の実装構成。**現時点で実際に存在するもの**を記載する。予定は「未実装」と明示する。

対応仕様：`docs/SPEC.md` 4章
タスク：A-6

---

## 1. 全体像

Next.js の単一アプリケーションに、画面・API・ドメインロジックを同居させる（SPEC 4.1「Phase 0ではNext.js統合構成を推奨」）。

将来の分離に備え、ドメインロジックは `src/modules/` 配下のモジュールに閉じ込め、画面とAPIから直接DBを触らせない。境界のルールは `docs/MODULE_RULES.md` に定める。

```
LINE ──> LIFF画面 ─┐
                   ├─> Next.js（src/app）──> モジュール（src/modules）──> PostgreSQL
管理者 ──> 管理画面 ─┘                              │
                                                    └─> WordPress / LINE / AI / Search Console
```

長時間処理はリクエスト内で実行せず、必ずジョブ化する（4章）。

---

## 2. 技術スタック

| 領域 | 採用 | 備考 |
|---|---|---|
| フレームワーク | Next.js 16（App Router） | SPEC 4.1 |
| 言語 | TypeScript 5.9 | `strict` + `noUncheckedIndexedAccess` ほか |
| UI | React 19 / Tailwind CSS 4 | |
| バリデーション | zod 4 | 環境変数、jsonb の検証（DATA_MODEL 3章） |
| ORM | Prisma **6系** | 7系は `datasource` の `url` を廃止しており非対応。Phase 0 は6系で進める（Q-004 解決済み） |
| DB | PostgreSQL | 27テーブル・31 enum |
| テスト | Vitest 4 + v8 カバレッジ | しきい値80% |
| Lint / 整形 | ESLint 9（flat config）/ Prettier 3 | |
| CI | GitHub Actions | 5章 |

### 未確定のもの

| 領域 | 状態 |
|---|---|
| AIプロバイダー（Anthropic / OpenAI） | 未選定。SPEC 4.1 は「1社利用」とのみ定める。E-3 で決める |

管理者認証は決定済み。**Supabase は入れず、メール＋ワンタイムリンク**（Q-012）。実装は B-11。

---

## 3. ディレクトリ構成

SPEC 4.2 のツリーに従い、ソースは全て `src/` 配下に置く（OPEN_QUESTIONS Q-003）。

```
.
├─ .github/workflows/   CI
├─ prisma/              schema.prisma（リポジトリ直下。src/ 配下へ移動しない）
├─ docs/                仕様・設計・進捗
└─ src/
   ├─ app/              画面とRoute Handler
   │  ├─ admin/         管理者Web画面
   │  ├─ liff/          LIFFユーザー画面
   │  └─ api/           Route Handler
   ├─ modules/          ドメインロジック（16モジュール。実装済みは4つ）
   ├─ lib/              共通基盤
   ├─ tests/            テスト
   └─ instrumentation.ts サーバー起動時の環境変数検証
```

`@/*` は `./src/*` に解決される。

### レイヤの責務

| レイヤ | 責務 | してはならないこと |
|---|---|---|
| `src/app/` | HTTPの入出力、画面。認証済みユーザーの特定 | ドメインロジックを書く。DBを直接引く |
| `src/modules/` | 業務ルール、永続化 | 他モジュールのテーブルを直接引く（MODULE_RULES 1） |
| `src/lib/` | 全モジュールが使う基盤 | `src/modules/` を import する |

---

## 4. 共通基盤（`src/lib/`）

| ファイル | 役割 | タスク |
|---|---|---|
| `env.ts` | 環境変数の検証。未設定なら起動を止める | A-3 |
| `logger.ts` | 構造化ログ。秘密情報のマスク | A-4 |
| `errors.ts` | `AppError` と共通エラーレスポンス | A-4 |
| `entitlements.ts` | 権限判定の入口。Phase 0 は常に `true` | A-4 |
| `datetime.ts` | JST基準の日付・週境界 | A-7 |
| `db.ts` | Prisma クライアント。`src/modules/` の外から使わない | B-2 |
| `liff/` | ブラウザ側の LIFF 初期化。**サーバー専用のコードを import しない** | B-8 |
| `mailer/` | Resend の HTTP API。未設定でも起動する | B-11 |
| `crypto/` | AES-256-GCM。復号値は `Secret` に包む | C-1 |
| `http/` | SSRF対策つきの外向きHTTP。**利用者が宛先を決めるリクエストは必ずここを通す** | C-7 |

### 環境変数

`src/instrumentation.ts` がサーバー起動時に `getServerEnv()` を呼ぶ。欠落があれば**変数名を表示して `exit 1`** する。`next build` では実行されない。

検証対象は `DATABASE_URL` `LINE_LOGIN_CHANNEL_ID` `SESSION_SECRET` `ENCRYPTION_KEY` `NODE_ENV`。**変数は「それを使うタスク」で追加する。** 未実装機能の変数を先回りして定義しない。

`APP_BASE_URL` `RESEND_API_KEY` `MAIL_FROM`（B-11）は**あえて必須にしていない**。未設定でも LIFF 側は動く必要があり、メールの設定漏れでサービス全体を止めない。`NEXT_PUBLIC_LIFF_ID`（B-8）はビルド時にバンドルへ焼き付くため、起動時検証に含めない。

### ログ

JSON 1行で出力する。`warn` / `error` は stderr、それ以外は stdout。

`password` `secret` `token` `*_encrypted` `DATABASE_URL` などのフィールドはマスクし、文字列に埋め込まれた接続情報・Bearerトークンも伏せる（SPEC 14.2、DATA_MODEL 7章）。`primary_keyword` `author` のような業務フィールドは巻き込まない。

### エラー

想定内のエラーは `AppError`（`code` + `status`）として投げる。**想定外の例外は 500 に丸め、元のメッセージをクライアントへ返さない。** 詳細はサーバー側のログにのみ残す。

モジュール固有のエラーコード（C-2 の接続テストなど）は各モジュールで定義し、`AppError` の `code` に渡す。

---

## 5. 品質ゲート

`.github/workflows/ci.yml` が pull request と `main` への push で動く。

**`verify` ジョブ** — `lint` / `format:check` / `typecheck` / `test:coverage` / `build`

**`schema` ジョブ** — PostgreSQL 16 のサービスコンテナを立て、`prisma validate` → `migrate deploy` で適用 → スキーマとの乖離検出 → テーブル数・enum型数・CHECK制約の確認 → CHECK制約が実際に効くことの確認 → **統合テストの実行**

### ローカルでの実行

```bash
npm ci
cp .env.example .env      # DATABASE_URL を設定する
npm run lint
npm run typecheck
npm run test
npm run build
```

### カバレッジ

対象は `src/lib/` と `src/modules/`（画面と設定は除外）。しきい値は lines / functions / branches / statements すべて 80%。

### テストの種類

| 種類 | 設定 | 実行 |
|---|---|---|
| ユニット | `vitest.config.ts` | `npm run test`。DB不要 |
| 統合 | `vitest.integration.config.ts` | `npm run test:integration`。**実PostgreSQLが必要** |

**所有権検証のように「SQLの条件そのもの」を検証する対象は統合テストで書く。** 差し替え可能な fake は書いたとおりに動くだけで、越境を弾いている証明にならない。

統合テストは同一DBを共有するため直列で実行し、各テストの前に全テーブルを `TRUNCATE ... CASCADE` する。テーブル名は `pg_tables` から動的に集めるため、テーブル追加時の更新漏れが起きない。

---

## 6. データ

`prisma/schema.prisma` に27テーブル・31 enum。A-2 の26テーブル・30 enum に、B-10 で `admin_login_tokens`、D-9 で `LinkMode` を追加した（D-10 は列のみで enum を増やしていない）。設計の根拠・`jsonb` の構造・`onDelete` の方針・インデックスの根拠は `docs/DATA_MODEL.md` にある。

初期マイグレーションは `prisma/migrations/` にコミットされている（A-8）。CIは `migrate deploy` で適用し、適用後のDBと `schema.prisma` の乖離を検出する。以降のスキーマ変更は単独PRで適用する（DATA_MODEL 9章）。

### 守るべき原則

- **テナント越境の防止。** 所有権検証は B-3 で `src/modules/blogs/ownership.ts` に実装済み。以降の全モジュールで使い回す（SPEC 14.1、MODULE_RULES 1）。**所有していない資源は 403 ではなく 404** を返す
- **日時は `timestamptz`、業務上の基準時刻は JST、週の開始は月曜**（DATA_MODEL 10章）
- **記事本文の正本判定は content hash で行う。** 生成時刻の比較では利用者の修正が必ず失われる（DATA_MODEL 11章）
- **秘密情報は暗号化して保存し、復号値をAPIレスポンス・ログへ出さない**（DATA_MODEL 7章）

---

## 7. 非同期処理

以下は必ずジョブ化する（SPEC 4.3）。**基盤は E-1 で実装済み。個別のハンドラは未実装。**

初期ブログ分析／構成案生成／記事生成／再生成／WordPress投稿／WordPress同期／Search Console取得／GA4取得／定期提案選定／LINE通知送信／リンク切れ確認

各ジョブは冪等性を持ち、同一処理の重複実行で二重投稿しない。

### 冪等性（C-4）

守る場面が2つある。**片方だけでは足りない。**

| 場面 | 仕組み |
|---|---|
| 同じ処理が2回積まれる | `idempotency_key`（unique）。キーは `<種類>:<対象>` に固定し、`enqueueJob` が形を確かめる。**対象だけをキーにすると種類をまたいで衝突する** |
| 外部呼び出しの直後に関数が殺される | **呼ぶ直前に印を残す**（`jobs.output_json`）。再試行時に印が残っていれば、①は済んで②の記録が無い状態と分かる |

後者では**やり直さずに `JOB_SIDE_EFFECT_UNCERTAIN` で止める**。二重投稿は実験データを壊しモニターのブログに要らない記事を残すため、「2本目を作る」より「止まって人に見せる」を選んでいる。止まったジョブの復旧手順は H-6。

この制約から、**取り消せない外部呼び出しは1ジョブに1つまで**。2つ以上あるならジョブを分ける。

`jobs` モジュールはドメインモジュールを import しない。ジョブハンドラの登録は `src/app/api/jobs/run/handlers.ts` で行う（MODULE_RULES 3）。

### キューはPostgreSQL（E-1 で決定）

**外部のキューサービスを使わない。** `jobs.idempotency_key` は unique、索引 `jobs(status, job_type)` は DATA_MODEL 5章が「ワーカーのポーリング」用と定めており、**A-2 の時点でDBをキューにする前提で設計されている**。10名×3ブログの規模で、契約・APIキー・障害点を増やす理由が無い。

同時実行は `SELECT ... FOR UPDATE SKIP LOCKED` で取り合う。

### Vercel（サーバーレス）での制約

**常駐ワーカーを持てない。** Vercel Cron が `GET /api/jobs/run` を叩き、1回の起動でキューを消化する。設計上の要点は3つ。

| 事情 | 対応 |
|---|---|
| 関数に実行時間の上限がある | **締め切りを持って抜ける。** 残りは次の起動に回す |
| 上限を超えると関数が殺される | **`RUNNING` のまま残った行を回収する**（`started_at` が `LEASE_SECONDS` より古いものを `QUEUED` へ戻す） |
| 1件が長引くと全体を巻き込む | **ジョブ単位でも時間を区切る** |

再試行の待ち時間は**専用の列を持たず** `updated_at` と `attempt_count` から求める（`backoff.ts` と取得SQLで同じ式）。

**`vercel.json` の cron は毎分。これには Vercel Pro が要る**（Hobby は1日1回まで）。Hobby の場合、承認された記事が最大24時間投稿されない。

`CRON_SECRET` が未設定なら**ワーカーは動かない**（fail closed）。`src/lib/env.ts` の必須には入れていない。cron の設定漏れでアプリ全体を止めないため。

**記事生成（E-10）は関数の上限に収まらない可能性がある。** AI呼び出しは分単位になり得る。E-1 の基盤は1件ごとに時間を区切って失敗として記録するところまでで、**分割は E-10 の課題**として残っている。

---

## 8. 現在の実装状況

**33タスク／74 が完了**（2026-08-08）。**Phase A・B・C は全件。** Phase D は D-1・D-9・D-10。Phase E はジョブ基盤（E-1）だけ。

| Phase | 完了 | 残り |
|---|---|---|
| A | 9/9 | — |
| B | 11/11 | — |
| C | 9/9 | — |
| D | 3/10 | D-2〜D-8 |
| E | 1/15 | E-2〜E-15 |
| F〜H | 0/29 | 全て |

### 実装済みのモジュール

| モジュール | 内容 |
|---|---|
| `users` | 登録・規約同意・データ利用同意・管理者向け一覧 |
| `auth` | LIFF IDトークン検証、セッション、認可、管理者のワンタイムリンク |
| `blogs` | CRUD、3スロット制御、記事構成比、管理者向け集計 |
| `wordpress` | 接続情報の暗号化保存、接続テスト（7項目）、下書き投稿、WP側の状態の取り込みと編集検出 |
| `jobs` | キュー・再試行・状態管理（E-1）、冪等性キーと中断の検出（C-4）。**ハンドラは未登録** |
| `affiliate` | 案件CRUD（ブログ別）、リンクの組み立て（`REDIRECT` / `DIRECT` の切り替えとサブID） |

`personas` `banners` `experiments` `content-planning` `content-generation` `approvals` `analytics` `ai-costs` `audit` `line` は未実装（空ディレクトリ）。

### 共通基盤（`src/lib/`）

| 追加 | 内容 |
|---|---|
| `crypto/` | AES-256-GCM。復号値は `Secret` に包む（C-1） |
| `http/` | SSRF対策つきの外向きHTTP。`safeFetch`（C-7） |
| `mailer/` | Resend の HTTP API（B-11） |
| `liff/` | ブラウザ側の LIFF 初期化（B-8） |

### Route Handler

```
POST   /api/auth/liff
GET    /api/blogs                       POST /api/blogs
GET    /api/blogs/:id                   PATCH /api/blogs/:id     DELETE /api/blogs/:id
POST   /api/blogs/:id/wordpress/connect
POST   /api/blogs/:id/wordpress/test
DELETE /api/blogs/:id/wordpress/disconnect
POST   /api/admin/login                 POST /api/admin/login/verify
GET    /api/jobs/run                    ← Vercel Cron 専用
```

### 画面

`/liff`、`/liff/blogs`、`/liff/blogs/:blogId/settings`、`/admin`、`/admin/users`、`/admin/login`、`/admin/login/verify`

### まだ動かないもの

**AI呼び出し・記事生成・LINE通知・計測は未実装。** Phase 0 の中核である「提案 → LINE承認 → 下書き投稿」のうち、**下書き投稿の部品だけができている**状態で、呼び出す側（承認）が無い。

**ジョブ基盤はあるが、登録されたハンドラが1つも無い**ため実際には何も実行されない（E-1・C-4）。最初のハンドラは C-5 または F-7 で載る。

**実WordPressでの動作確認をしていない**（C-2・C-3・C-5）。偽サーバーに対しては通しで確認済み。H-2 のオンボーディング前に1サイトで確かめる必要がある。

**実際のメール送信を確認していない**（B-11）。Resend のAPIキーと送信元ドメインの認証が要る。

### 認証と同意

セッションは**署名付きCookie**（`bunshin_session`、30日）。モニター10名の規模でセッションストアを持つ必要が無いため。**CookieにはユーザーIDと期限だけを入れ、ロールと同意状態は毎回DBを見る。** 権限をはく奪しても古いCookieが有効なまま、という状態を作らないため。

APIの入口は `requireUser`（同意を見ない。オンボーディング用）と `requireConsentedUser`（同意必須）の2つ。**オンボーディング以外の全APIは後者を使う。** 各Route Handlerが個別に同意を確認すると必ず書き忘れが出る。

進捗は `docs/IMPLEMENTATION_STATUS.md`、決定の経緯は `docs/IMPLEMENTATION_HISTORY.md` を参照。

---

## 9. 未解決の論点

実装を進める前に決める必要があるもの。詳細は `docs/OPEN_QUESTIONS.md`。

**未解決の論点は無い**（2026-08-08 時点）。決定の内容と根拠は `docs/OPEN_QUESTIONS.md` にある。

| ID | 論点 | 決定 |
|---|---|---|
| Q-001 | アフィリエイトリンクのリダイレクト方式 | 案件ごとに `REDIRECT` / `DIRECT` を切り替える |
| Q-002 | ドメイン・サーバー費用の負担者 | モニターが負担する |
| Q-005 | Search Console の暦日 | 返ってきた日付をそのまま使う |
| Q-014 | サブIDの付け方 | 案件ごとにパラメータ名を持つ（`NULL` なら付けない） |

**Q-005 には未検証の前提がある。** 「Search Console は日付がUTC基準で返る」という記述を確かめていない。G-1 で実際に接続したときに確認する（決定の中身は前提がどちらでも変わらない）。

---

## 10. 関連ドキュメント

| ファイル | 内容 |
|---|---|
| `docs/SPEC.md` | 実装仕様書 v2.1。全体の唯一の正 |
| `docs/TASKS.md` | Phase A〜H のタスク分解表 |
| `docs/DATA_MODEL.md` | スキーマ補足。jsonb構造、日時、記事本文の正本 |
| `docs/MODULE_RULES.md` | モジュール境界のルールと依存の向き |
| `docs/CONTENT_PLANNING.md` | 構成表生成のAI/コード境界 |
| `docs/IMPLEMENTATION_STATUS.md` | タスク別の進捗 |
| `docs/IMPLEMENTATION_HISTORY.md` | 決定と変更の履歴 |
| `docs/OPEN_QUESTIONS.md` | 未解決の論点 |
