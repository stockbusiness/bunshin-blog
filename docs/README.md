# docs/

BUNSHIN BLOG のドキュメント一覧。

## どれを読むか

| 目的 | 読むもの |
|---|---|
| 仕様を確認したい | `SPEC.md`（唯一の正） |
| 次に何を実装するか知りたい | `TASKS.md` → `IMPLEMENTATION_STATUS.md` |
| 実装の構成を知りたい | `ARCHITECTURE.md` |
| コードをどこに置くか迷った | `MODULE_RULES.md` |
| テーブル・カラムの意図を知りたい | `DATA_MODEL.md` |
| 決まっていないことを知りたい | `OPEN_QUESTIONS.md` |

**タスク着手時は `TASKS.md` の「参照」欄に挙がっているものだけを読む。** 仕様書全文を毎回読まない。

## 一覧

| ファイル | 内容 |
|---|---|
| `SPEC.md` | 実装仕様書 v2.1。全体の唯一の正 |
| `ROADMAP.md` | 事業計画と実装計画の対応。用語・フェーズ呼称・検証の数値 |
| `TASKS.md` | Phase A〜H のタスク分解表（53タスク）と運用ルール |
| `ARCHITECTURE.md` | 実装構成。技術スタック、ディレクトリ、共通基盤、品質ゲート |
| `MODULE_RULES.md` | モジュール境界の3ルールと依存の向き。テーブルの所有 |
| `DATA_MODEL.md` | スキーマ補足。jsonb構造、onDelete、暗号化、日時とタイムゾーン、記事本文の正本 |
| `CONTENT_PLANNING.md` | 構成表生成のAI/コード境界とプロンプト入出力仕様 |
| `MANUAL.md` | **モニターに渡す操作マニュアル**（H-6） |
| `CONSENT.md` | **同意していただくこと**（H-6）。画面の文言と食い違わないことをテストが見張る |
| `WORDPRESS_SNIPPET.md` | **モニターに渡す手順書。** 各ブログに `/go/` の処理を入れる（D-12） |
| `BACKUP.md` | **障害の最中に読む手順書。** バックアップと復旧（H-5） |
| `DEPLOY.md` | **本番へ出すときに上から順に実行する手順書**（I-7）。Vercel・環境変数・cron・DB・鍵 |
| `IMPLEMENTATION_STATUS.md` | タスク別の進捗（状態 / PR / 完了日 / 残課題） |
| `IMPLEMENTATION_HISTORY.md` | 決定と変更の履歴 |
| `OPEN_QUESTIONS.md` | 未解決の論点。**推測で実装しない** |
| `reference_構成表_v1.xlsx` | 手作業で作成した構成表30本。E-4〜E-8 のテストケース |

## 書き換えのルール

- **`SPEC.md` は実装タスクで書き換えない。** 仕様を変えるなら仕様改訂として単独で行う
- `TASKS.md` の変更（タスク追加・完了条件の変更）は単独PRで出す
- `IMPLEMENTATION_STATUS.md` はタスク完了時に必ず更新する
- 判断できない事項は実装せず `OPEN_QUESTIONS.md` へ記録する
- `DATA_MODEL.md` はスキーマ変更と同じPRで更新する（同9章）
- **用語・フェーズ呼称・検証の数値は `ROADMAP.md` が正**（同1章）。実装に関することは `SPEC.md` が正
