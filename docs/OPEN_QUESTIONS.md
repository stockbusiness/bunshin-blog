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

### Q-005 Search Console の日次データをJSTの暦日へどう対応づけるか

- 発生タスク：A-7（判断が必要になるのは G-2）
- 状況：`DATA_MODEL.md` 10章に「Search Console は日付がUTC基準で返るため、JSTの日付へ変換してから `metrics_daily` に保存する」とある。しかし Search Console が返すのは**時刻を持たない日付文字列**であり、日単位で集計済みの値である

  UTCの1日 `[00:00Z, 24:00Z)` は JST の `[09:00, 翌09:00)` にあたる。**1つのUTC暦日は2つのJST暦日にまたがる**ため、時間単位の内訳が無い以上、JSTの暦日へ割り直すことは原理的にできない。「変換」は実際には**どの暦日に載せるかの取り決め**になる
- 選択肢：
  - (a) UTCの暦日をそのままJSTの暦日として保存する（9時間のずれを許容する）
  - (b) 1日ずらして保存する
  - (c) `metrics_daily` にデータ源のタイムゾーンを持たせ、Search Console 由来の行は「UTC基準の日」として区別する
- 影響範囲：G-2（取得ジョブ）、G-6（`metrics_daily` 集計）、G-7（管理ダッシュボード）。手動収益入力（G-5）はJST基準のため、混在すると同じ `metric_date` の行で基準が食い違う
- 状態：**未解決。G-2 着手前に決定が必要。** A-7 では推測で実装せず、UTCの**瞬間**をJST暦日に変換する `toJstDate(instant)` のみを提供した。日付文字列の割り直しは実装していない

### Q-006 `blogs.targetReader` のカラム名が snake_case になっていない

- 発生タスク：A-8（初期マイグレーションの生成中に判明）
- 状況：`DATA_MODEL.md` 1章は「テーブル名・カラム名は snake_case」と定めているが、`prisma/schema.prisma:292` の `Blog.targetReader` に `@map` が無く、**DBのカラム名が `"targetReader"` になる**

  ```prisma
  // prisma/schema.prisma:292（Blog）
  targetReader      String              // @map が無い → "targetReader"

  // prisma/schema.prisma:388（BlogPersonaSetting）
  targetReader      Json  @map("target_reader")   // こちらは正しい
  ```

  実カラム26テーブル分を走査した結果、**snake_case でないのはこの1件のみ**。同じ概念が `blogs` と `blog_persona_settings` で別名になっている
- 選択肢：
  - (a) **`@map("target_reader")` を追加して揃える。** 初期マイグレーション作成前の今なら1行の変更で済む
  - (b) そのままにする。以降 `blogs` だけ SQL で `"targetReader"` とクォートが必要になる
  - (c) 後で直す。初期マイグレーション適用後は `ALTER TABLE ... RENAME COLUMN` の追加マイグレーションが必要
- 影響範囲：`prisma/schema.prisma`、初期マイグレーション、B-3・B-5（ブログCRUDと設定画面）、G-7（ダッシュボードの生SQL）
- 状態：**解決（2026-08-07）。(a) を採用。`@map("target_reader")` を追加した**

決定内容：

- `prisma/schema.prisma` の `Blog.targetReader` に `@map("target_reader")` を追加
- 初期マイグレーションを再生成し、**26テーブルの全実カラムが snake_case であることを確認**
- `blogs.target_reader` と `blog_persona_settings.target_reader` で名前が揃った
- 本件は初期マイグレーション適用前だったため、追加のマイグレーションは不要

### Q-007 ブログのWordPress接続先を途中で別サイトに変更できるか

- 発生タスク：C-1（判断が必要になるのは C-1・C-5）
- 状況：`wordpress_connections.blog_id` は `unique` で「1ブログ＝1接続」だが、**`site_url` を後から書き換えられるか**が `SPEC.md` にも `DATA_MODEL.md` にも定義されていない。SPEC 13.3 には `connect` と `disconnect` の両方があり、切断後に別サイトへ繋ぎ直す経路が読める
- 影響範囲：C-1（接続情報の保存）、C-5（WP同期）、G-2・G-6（計測）、実験データの解釈
- 状態：**解決（2026-08-07）。別サイトへの変更は許可しない**

決定内容：

- **接続後に `site_url` を別のサイトへ変更できない。** 変更しようとした場合は拒否する
- **同一 `site_url` のままの再接続は許可する。** アプリケーションパスワードの入れ替え・権限の付け直し・接続エラーからの復旧はこれにあたり、運用上必ず発生する
- `disconnect` で `connection_status` を `REVOKED` にしても **`site_url` は保持する。** 再接続時は保持している値との一致を確認し、異なれば拒否する
- **モニター自身は変更できない。ただし ADMIN は設定ミスの救済として変更できる**（Q-008 で追記）
- ADMIN の介入でも直せない場合は、そのブログを `CLOSED` にして別のブログとして作り直す

理由：

- 接続先が変わると、そのブログに紐づく `wordpress_posts`・`metrics_daily`・Search Console のデータが別サイトのものと混ざり、**実験データとして読めなくなる**
- Phase 0 の目的は3ブログ×10名の比較（SPEC 1.2）であり、途中で土台が変わった行は分析に使えない
- 一方で認証情報の入れ替えを塞ぐと、パスワード漏洩時や権限変更時に復旧できなくなる。**「サイトの変更」と「認証情報の更新」を分けて扱う**


### Q-008 `CLOSED` にしたブログのスロットを再利用できるか

- 発生タスク：B-4
- 状況：SPEC 2.5 は「1ユーザー当たりブログ：最大3件」、SPEC 13.2 は「削除は物理削除せず `CLOSED`」と定めるが、**`CLOSED` にしたスロットを再利用できるかが書かれていない**

  技術的な制約として `UNIQUE(user_id, slot_number)` があり、`slot_number` は NOT NULL で 1〜3 に限られる。`CLOSED` の行もスロットを保持し続けるため、**再利用を許すには部分一意索引（`CLOSED` を除く）への差し替えが必要**になる
- 選択肢：
  - (a) **再利用しない。** スキーマ変更が不要。`(user_id, slot_number)` が期間を通じて安定した識別子になる
  - (b) 再利用する。マイグレーションが必要。集計時に必ず期間で切り分けることになる
- 影響範囲：B-4、B-5、H-2（オンボーディング）、`metrics_daily` の分析
- 状態：**解決（2026-08-07）。(a) を採用。ただし設定ミスは ADMIN の介入で救済する**

決定内容：

- **モニターは `CLOSED` にしたスロットを再利用できない。** 3スロットは期間を通じて固定
- スキーマは変更しない。`UNIQUE(user_id, slot_number)` をそのまま使う
- **設定ミスは「作り直し」ではなく「ADMIN による修正」で救済する**（下記）

### ADMIN による設定ミスの救済（Q-007・Q-008 共通）

Q-007 で WordPress 接続先の変更を禁止し、Q-008 でスロットの再利用を禁止した。この2つが重なると、**オンボーディングでの接続ミスが 1/3 の枠を恒久的に潰す**。モニターは技術者ではなく、H-2 のオンボーディングは10ステップあるため、ミスは起きる前提で考える。

そのため **ADMIN の手動介入を正規の救済手段とする**（SPEC 3.1「手動介入」）。

- **ADMIN は設定ミスのブログについて、`wordpress_connections.site_url` を変更できる**
- **ADMIN はスロットを解放できる。** 手段はそのブログの物理削除。`Blog → 配下全て` が `Cascade` のため関連行も消える
- **いずれも「そのブログでまだ記事を投稿していない」場合に限る**（`wordpress_posts` が0件）。投稿済みのブログを消すと実測データが失われ、Phase 0 の目的（SPEC 1.2）に反する
- **介入は `audit_logs` に残す**
- **Phase 0 では専用の管理UIとAPIを作らない。** SQL または管理画面の既存機能で行う（SPEC 10.3 の `experiment_groups` と同じ扱い）
- 手順は H-6（操作マニュアル）に記載する

「何回介入が必要になったか」は、オンボーディング設計の評価データとしても使う。

### Q-009 ブログ設定画面で「ジャンル」を編集できるか

- 発生タスク：B-5
- 状況：`SPEC.md` 6.1 は `/liff/blogs/[blogId]/settings` の項目に**ジャンル**を挙げている。しかし `genres` は独立したマスタテーブルで、`status` は `CANDIDATE` / `APPROVED` / `REJECTED` を取る

  SPEC 9.2.2（STEP 1 ジャンル審査）によれば、ジャンルは**審査を経て決まる**。YMYL該当・案件0件・上位10件の寡占という停止条件があり、差し戻しは2回まで。つまりジャンルは利用者が設定画面で自由に選ぶ値ではなく、**E-4 の審査結果**である

  また `genres` を作る・埋めるタスクが `TASKS.md` に存在しない。B-5 の時点で選択肢として出せる行が1件も無い
- 選択肢：
  - (a) **設定画面ではジャンルを表示のみとし、変更は E-4 の審査経由にする。** 停止条件を迂回できなくなる
  - (b) 設定画面で自由に選べるようにする。審査を通っていないジャンルが設定できてしまう
  - (c) ジャンルマスタを事前に用意する別タスクを立て、承認済みのものから選ばせる
- 影響範囲：B-5、E-4、`blogs.genre_id`
- 状態：**解決（2026-08-07）。(a) を採用。設定画面では表示のみとする**

決定内容：

- **`/liff/blogs/[blogId]/settings` からジャンルを変更できない。** 表示のみ
- ジャンルの決定と変更は **E-4（STEP 1 ジャンル審査）** を経由する
- `blogs.genre_id` が未設定のブログでは「未設定」と表示し、審査への導線を出す（導線の実装は E-4）
- `genres` を埋めるタスクは新設しない。行は E-4 の審査で生まれる

理由：停止条件（YMYL該当・案件0件・上位10件の寡占）はジャンル選定の中核（SPEC 9.2.2）であり、設定画面から素通りできる経路を作ると審査の意味が無くなる。

### Q-010 ブログ設定画面の「通知設定」をどこに置くか

- 発生タスク：B-5
- 状況：`SPEC.md` 6.1 は `/liff/blogs/[blogId]/settings`（**ブログ別**）の項目に**通知設定**を挙げている。しかし通知設定は `monitor_profiles`（**ユーザー別**）にある

  ```prisma
  // prisma/schema.prisma（MonitorProfile）
  notificationDays  Int[]     @map("notification_days")
  notificationTime  DateTime  @map("notification_time") @db.Time(6)
  maxDailyProposals Int       @default(1) @map("max_daily_proposals")
  ```

  `TASKS.md` の F-3「通知数制御（既定1日1件・最大2件）」の完了条件も「**3ブログ合計で**制限される」であり、ユーザー単位での制御を前提としている。ブログ別に通知曜日・時刻を持たせる場所がスキーマに無い
- 選択肢：
  - (a) **通知設定はブログ設定画面から外し、ユーザー設定として扱う**（オンボーディング STEP 9・H-2 の担当）。スキーマ変更が不要
  - (b) `blogs` にブログ別の通知設定を追加する。マイグレーションが必要で、F-3 の「3ブログ合計」と整合を取り直すことになる
- 影響範囲：B-5、F-2・F-3（通知送信と通知数制御）、H-2（オンボーディング STEP 9）
- 状態：**解決（2026-08-07）。(a) を採用。通知設定はユーザー単位のまま**

決定内容：

- **通知設定を `/liff/blogs/[blogId]/settings` に置かない。** ブログ設定画面の項目から外す
- 通知曜日・時刻・1日の上限は `monitor_profiles` のまま。**ユーザー単位で1組**
- 編集の入口は**オンボーディング STEP 9（H-2）**とユーザー設定画面。B-5 の範囲外
- スキーマは変更しない

理由：1日1件という制限は「モニターに届く通知の総量」の話（F-3「3ブログ合計で制限される」）。ブログごとに曜日と時刻を分けると3ブログで最大3倍の通知が出る設計になり、SPEC 2.x の意図と食い違う。

### Q-011 「新規記事・改善提案比率」の保存先が無い

- 発生タスク：B-5
- 状況：`SPEC.md` 6.1 は設定画面の項目に**新規記事・改善提案比率**を挙げているが、これを保存するカラムが `blogs` に無い

  近いものとして `blogs.article_ratio` があるが、`DATA_MODEL.md` 3章の定義は別の軸である

  ```ts
  {
    revenue: number;          // 収益記事の本数（9.2.4の算出値）
    traffic: number;          // 集客記事の本数
    weeklyPublishCap: number; // 既定 4（SPEC 2.2）
  }
  ```

  `revenue` / `traffic` は**収益記事と集客記事**の軸で、しかも「9.2.4の算出値」＝**コードが算出する値**である（SPEC 9.2「判定は必ずコード側で行う」）。一方「新規記事・改善提案」は**既存記事を書き直すか新しく書くか**という別の軸で、利用者が決める値と読める
- 選択肢：
  - (a) `article_ratio` に第3の軸（例 `improvementRatio`）を足す。jsonb なのでマイグレーション不要
  - (b) 項目自体を B-5 から外し、比率が実際に使われる E-9（公開順序）で必要性を判断する
  - (c) SPEC 6.1 の記載を「収益記事・集客記事比率」の誤記とみなし、表示のみにする
- 影響範囲：B-5、E-9（公開順序の付与）、`blogs.article_ratio`
- 状態：**解決（2026-08-07）。(b) を採用。B-5 では扱わない**

決定内容：

- **「新規記事・改善提案比率」を B-5 の対象項目から外す。** 保存先を先に決めない
- 必要性と保存先は **E-9（公開順序の付与）** で判断する。そこが比率を実際に読む最初の場所になる
- **`article_ratio.revenue` / `traffic` は利用者に編集させない。** SPEC 9.2.4 の算出値であり、SPEC 9.2「判定は必ずコード側で行う」に反する
- **設定画面で編集できるのは `article_ratio.weeklyPublishCap` のみ**（投稿頻度）。上限は4（SPEC 2.2「週4本を超えて公開する処理を実装してはならない」）

理由：この比率を読む処理がまだ無く、先に入力欄だけ作ると E-9 の実装時に意味が確定して作り直しになる。

### B-5 で編集できる項目（Q-009〜Q-011 の決定を反映）

| 項目 | 保存先 | 扱い |
|---|---|---|
| ブログ名 | `blogs.name` | 編集可 |
| ペンネーム | `blogs.pen_name` | 編集可 |
| 想定読者 | `blogs.target_reader` | 編集可 |
| 収益方針 | `blogs.purpose` | 編集可 |
| 投稿頻度 | `blogs.article_ratio.weeklyPublishCap` | 編集可（1〜4） |
| ジャンル | `blogs.genre_id` | **表示のみ**（Q-009） |
| 収益記事・集客記事の本数 | `blogs.article_ratio.revenue` / `traffic` | **表示のみ**（算出値・Q-011） |
| 通知設定 | `monitor_profiles` | **B-5 の範囲外**（Q-010。H-2 が担当） |
| 新規記事・改善提案比率 | — | **B-5 の範囲外**（Q-011。E-9 で判断） |

`slug` と `slot_number` は設定画面に出さない。`slug` は WordPress 側の識別に関わり、`slot_number` は B-4 の決定によりサーバーが決める。
