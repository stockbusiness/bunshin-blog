# BUNSHIN BLOG

LINE承認型AI編集長。個人アフィリエイターが複数のWordPressブログを、LINE上の提案とLIFF上の承認によって運営する実験システム。

現在のフェーズ：**Phase A（リポジトリ基盤）**

## セットアップ

Node.js 22 が必要。

```bash
npm ci
cp .env.example .env   # DATABASE_URL を設定する
npm run dev
```

環境変数が足りないまま起動すると、**欠落した変数名を表示して起動が中止される**（`src/lib/env.ts`）。

## スクリプト

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー |
| `npm run build` | 本番ビルド |
| `npm run start` | 本番サーバー |
| `npm run lint` | ESLint |
| `npm run typecheck` | 型検査 |
| `npm run test` | テスト |
| `npm run test:coverage` | テスト（カバレッジ付き） |
| `npm run test:watch` | テスト（監視） |
| `npm run format` | Prettier で整形 |
| `npm run format:check` | 整形の確認 |
| `npm run db:validate` | Prisma スキーマの検証 |

CI（`.github/workflows/ci.yml`）は pull request ごとに lint / format / typecheck / test / build と、実PostgreSQLへのスキーマ適用を検証する。

## ディレクトリ

```
src/
├─ app/        画面とRoute Handler（admin / liff / api）
├─ modules/    ドメインロジック（16モジュール）
├─ lib/        共通基盤（env / logger / errors / entitlements）
└─ tests/      テスト
prisma/        schema.prisma（26テーブル・30 enum）
docs/          仕様・設計・進捗
```

構成の詳細は `docs/ARCHITECTURE.md`、モジュール境界のルールは `docs/MODULE_RULES.md`。

## ドキュメント

一覧と読み方は `docs/README.md`。主なものは以下。

| ファイル | 内容 |
|---|---|
| `docs/SPEC.md` | 実装仕様書 v2.1。全体の唯一の正 |
| `docs/TASKS.md` | Phase A〜Hのタスク分解表（53タスク） |
| `docs/ARCHITECTURE.md` | 実装構成 |
| `docs/DATA_MODEL.md` | スキーマ補足 |
| `docs/IMPLEMENTATION_STATUS.md` | タスク別の進捗 |
| `docs/OPEN_QUESTIONS.md` | 未解決の論点 |

## 実装ルール

- 1タスク＝1PR。複数タスクをまとめない
- 各タスクでは `docs/TASKS.md` の「参照」欄のドキュメントのみを読む
- ソースは `src/` 配下に置く。`prisma/` `.github/` `docs/` はリポジトリ直下
- `prisma/schema.prisma` は既存のものを使用する。変更は単独PRで行う
- 判断できない事項は実装せず `docs/OPEN_QUESTIONS.md` へ記録する
- 詳細は `docs/SPEC.md` 18章

## 着手前に確定が必要な事項

| ID | 論点 | 期限 |
|---|---|---|
| Q-001 | アフィリエイトリンクのリダイレクト方式 | Phase C 着手前 |
| Q-002 | ドメイン・サーバー費用の負担者 | モニター募集前 |
| Q-005 | Search Console の日次データをJSTの暦日へどう対応づけるか | G-2 着手前 |

## 次のタスク

`docs/TASKS.md` の **A-7**（日時ヘルパー）。Phase A の残りはこれのみ。
