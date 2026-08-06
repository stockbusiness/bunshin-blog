# BUNSHIN BLOG

LINE承認型AI編集長。個人アフィリエイターが複数のWordPressブログを、LINE上の提案とLIFF上の承認によって運営する実験システム。

現在のフェーズ：**Phase 0（実装前）**

## ドキュメント

| ファイル | 内容 |
|---|---|
| `docs/SPEC.md` | 実装仕様書 v2.1。全体の唯一の正 |
| `docs/TASKS.md` | Phase A〜Hのタスク分解表（52タスク） |
| `docs/DATA_MODEL.md` | スキーマ補足。jsonb構造、アプリ層制約、追加テーブルの根拠 |
| `docs/CONTENT_PLANNING.md` | 構成表生成のAI/コード境界とプロンプト入出力仕様 |
| `prisma/schema.prisma` | データモデル（26モデル・30 enum） |
| `docs/reference_構成表_v1.xlsx` | 手作業で作成した構成表30本。E-4〜E-8のテストケース |

## 実装ルール

- 1タスク＝1PR。複数タスクをまとめない
- 各タスクでは `docs/TASKS.md` の「参照」欄のドキュメントのみを読む
- `prisma/schema.prisma` は既存のものを使用する。独自に設計しない
- 判断できない事項は実装せず `docs/OPEN_QUESTIONS.md` へ記録する
- 詳細は `docs/SPEC.md` 18章

## 着手前に確定が必要な事項

- アフィリエイトリンクのリダイレクト方式（TASKS D-8 の前提）
- ドメイン・サーバー費用の負担者（TASKS H-1 の前提）

## 次のタスク

`docs/TASKS.md` の **A-1**
