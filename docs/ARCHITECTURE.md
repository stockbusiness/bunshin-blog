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
| ORM | Prisma **6系** | 7系は非対応。OPEN_QUESTIONS Q-004 |
| DB | PostgreSQL | 26テーブル・30 enum |
| テスト | Vitest 4 + v8 カバレッジ | しきい値80% |
| Lint / 整形 | ESLint 9（flat config）/ Prettier 3 | |
| CI | GitHub Actions | 5章 |

### 未確定のもの

| 領域 | 状態 |
|---|---|
| ジョブ基盤（Inngest / Trigger.dev / Supabase Edge Functions） | 未選定。E-1 で決める |
| AIプロバイダー（Anthropic / OpenAI） | 未選定。SPEC 4.1 は「1社利用」とのみ定める。E-3 で決める |
| 認証（LIFF / Supabase Auth） | 未実装。B-1 / B-6 |

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
   │  ├─ admin/         管理者Web画面（未実装）
   │  ├─ liff/          LIFFユーザー画面（未実装）
   │  └─ api/           Route Handler（未実装）
   ├─ modules/          ドメインロジック（16モジュール）
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
| `datetime.ts` | JST基準の日付・週境界（**未実装**） | A-7 |

### 環境変数

`src/instrumentation.ts` がサーバー起動時に `getServerEnv()` を呼ぶ。欠落があれば**変数名を表示して `exit 1`** する。`next build` では実行されない。

検証対象は `DATABASE_URL` と `NODE_ENV` のみ。**変数は「それを使うタスク」で追加する。** 未実装機能の変数を先回りして定義しない。

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

**`schema` ジョブ** — PostgreSQL 16 のサービスコンテナを立て、`prisma validate` →初期SQLの生成→ `prisma db push` で実DBへ適用→テーブル数・enum型数の確認

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

統合テスト（C-6）用のプロジェクト分割は未実施。

---

## 6. データ

`prisma/schema.prisma` に26テーブル・30 enum。設計の根拠・`jsonb` の構造・`onDelete` の方針・インデックスの根拠は `docs/DATA_MODEL.md` にある。

**初期マイグレーションはまだコミットされていない。** CIでは `db push` でスキーマの適用可能性のみを確認している。マイグレーションは単独PRで適用する（DATA_MODEL 9章）。

### 守るべき原則

- **テナント越境の防止。** 所有権検証は B-3 で共通ヘルパーとして実装し、以降の全モジュールで使い回す（SPEC 14.1）
- **日時は `timestamptz`、業務上の基準時刻は JST、週の開始は月曜**（DATA_MODEL 10章）
- **記事本文の正本判定は content hash で行う。** 生成時刻の比較では利用者の修正が必ず失われる（DATA_MODEL 11章）
- **秘密情報は暗号化して保存し、復号値をAPIレスポンス・ログへ出さない**（DATA_MODEL 7章）

---

## 7. 非同期処理

以下は必ずジョブ化する（SPEC 4.3）。**いずれも未実装。** 基盤は E-1 で作る。

初期ブログ分析／構成案生成／記事生成／再生成／WordPress投稿／WordPress同期／Search Console取得／GA4取得／定期提案選定／LINE通知送信／リンク切れ確認

各ジョブは冪等性を持ち、同一処理の重複実行で二重投稿しない。

`jobs` モジュールはドメインモジュールを import しない。ジョブハンドラの登録は `src/app/` 側で行う（MODULE_RULES 3）。

---

## 8. 現在の実装状況

Phase A のうち A-1〜A-5 が完了。**ドメインロジックはまだ1行も無い**（`src/modules/` は空ディレクトリ）。

認証・DB接続・LINE連携・WordPress連携・AI呼び出しはいずれも未実装。

進捗は `docs/IMPLEMENTATION_STATUS.md`、決定の経緯は `docs/IMPLEMENTATION_HISTORY.md` を参照。

---

## 9. 未解決の論点

実装を進める前に決める必要があるもの。詳細は `docs/OPEN_QUESTIONS.md`。

| ID | 論点 | 期限 |
|---|---|---|
| Q-001 | アフィリエイトリンクのリダイレクト方式 | Phase C 着手前 |
| Q-002 | ドメイン・サーバー費用の負担者 | モニター募集前 |
| Q-004 | Prisma 7 へ移行するか | B-1 着手前 |

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
