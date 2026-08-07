# OPEN QUESTIONS

判断できない事項を記録する。**推測で実装しない。**

## 形式

```
### Q-001 タイトル
- 発生タスク：
- 状況：
- 選択肢：
- 影響範囲：
- 状態：未解決 / 解決（決定内容と日付）
```

---

### Q-001 アフィリエイトリンクのリダイレクト方式

- 発生タスク：D-8（TASKS.md）
- 状況：自前リダイレクタを後から導入すると、公開済み記事のリンクを全て貼り替えることになる
- 影響範囲：D-8、E-10、G-4、記事本文の全て
- 状態：**未解決。Phase C着手前に決定が必要**

### Q-002 ドメイン・サーバー費用の負担者

- 発生タスク：H-1
- 状況：モニター募集条件そのもの
- 影響範囲：H-1、H-2、募集要項
- 状態：**未解決。モニター募集前に決定が必要**

### Q-003 ソースディレクトリに `src/` を付けるか

- 発生タスク：A-1
- 状況：`SPEC.md` 4.2 のツリーは `src/` 配下に `modules/` `app/` `lib/` `tests/` を置いている。一方 `TASKS.md` の「主な変更先」欄は `lib/env.ts` `modules/auth/` `app/liff/` `tests/integration/` と `src/` を省いた表記になっている
- 選択肢：(a) `src/app` `src/modules` `src/lib` `src/tests`（SPEC 4.2 の表記どおり）／(b) リポジトリ直下に `app/` `modules/` `lib/` `tests/`
- 影響範囲：以降の全タスクのファイルパス、`tsconfig.json` の `@/*` エイリアス
- 状態：**解決（2026-08-06）。(a) を採用。`src/` 配下が正であり、SPEC 4.2 を唯一の正とする。ディレクトリ移動は不要**

決定内容：

- ソースコードは全て `src/` 配下に置く。`@/*` → `./src/*`
- `TASKS.md` の「主な変更先」欄が `src/` を省いているのは記載ミス。以下のとおり読み替える

  | TASKS.md の表記 | 実際のパス |
  |---|---|
  | `lib/env.ts` | `src/lib/env.ts` |
  | `modules/auth/` | `src/modules/auth/` |
  | `app/liff/` | `src/app/liff/` |
  | `tests/` | `src/tests/` |

- **例外：`prisma/` はリポジトリ直下のまま。`src/` 配下へ移動しない**
- `TASKS.md` 本体の表記修正は A-1 のPRに含めず、別PR（`docs/fix-tasks-paths`）で行う

### Q-004 Prisma のメジャーバージョン

- 発生タスク：A-5
- 状況：A-2 の `prisma/schema.prisma` は `datasource db { url = env("DATABASE_URL") }` を持つ。**Prisma 7 はこの記法を廃止**しており、`prisma validate` が `P1012` で失敗する

  ```
  The datasource property `url` is no longer supported in schema files.
  Move connection URLs for Migrate to `prisma.config.ts`
  ```

  Prisma 6.19.3 では検証が通り、26テーブル・30 enum の初期SQLも生成できることを確認した
- 選択肢：
  - (a) **Prisma 6 系に固定する**（A-5 で採用）。`schema.prisma` は無変更で済む
  - (b) Prisma 7 へ上げる。`schema.prisma` から `url` を削除し、`prisma.config.ts` を追加する。A-2 の成果物に手を入れるため、DATA_MODEL 9章に従い単独タスク・単独PRが必要
- 影響範囲：`prisma/schema.prisma`、DB接続の実装（B-1以降）、CI
- 状態：**解決（2026-08-06）。(a) を採用。Phase 0 は Prisma 6 系で進める**

決定内容：

- `prisma@^6.19.3` に固定する。`prisma/schema.prisma` は無変更のまま
- **Phase 0 の期間中は 7系へ上げない。** 7系で得られるもののうち Phase 0 で使う予定のものが無い一方、26テーブルのスキーマがCIで実DBへ適用できている現状を崩すリスクがある
- 移行を検討するのは Phase 0 終了後。実施する場合は `schema.prisma` の変更と `prisma.config.ts` の追加を伴うため、DATA_MODEL 9章に従い単独タスク・単独PRで行う
- 依存の更新でうっかり 7系に上がらないよう、`package.json` の指定は `^6` の範囲に留める
