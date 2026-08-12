# BUNSHIN BLOG Phase 0 タスク分解表（docs/TASKS.md）

対象仕様：`docs/SPEC.md`（実装仕様書 v2.1）
作成日：2026-08-06

---

## 0. 運用ルール

- **1タスク＝1PR。** 複数タスクを1つのPRにまとめない
- 各タスク開始時に、`参照`欄のドキュメントのみを読む。仕様書全文を毎回読ませない
- 完了時に `docs/IMPLEMENTATION_STATUS.md` の該当行を更新する
- 判断できない事項は実装せず `docs/OPEN_QUESTIONS.md` へ記録する
- `依存`欄のタスクが完了していない状態で着手しない
- ソースコードは `SPEC.md` 4.2 のとおり `src/` 配下に置く（`src/app` `src/modules` `src/lib` `src/tests`）。**`prisma/` `.github/` `docs/` はリポジトリ直下のまま**（OPEN_QUESTIONS Q-003）

### 着手前に確定が必要な事項

SPEC 20.1 が「Phase C に入る前に確定させる」とした2件の状況。

| 項目 | 状態 | 止まるタスク |
|---|---|---|
| アフィリエイトリンクのリダイレクト方式 | **解決**（OPEN_QUESTIONS Q-001） | — |
| ドメイン・サーバー費用の負担者 | **解決**（OPEN_QUESTIONS Q-002） | — |

**Q-001 は「案件ごとに `REDIRECT` / `DIRECT` を切り替える」で決着した。** ASPによって規約が違うため、方式を1つに決める前提そのものを外した。詳細は Phase D の節。

**Q-002 は「モニター（利用者）の負担」で決着した。** 実装への影響は無い。**H-1 の募集要項に明記し、規約同意より前に提示する**（費用の話は参加可否そのものであり、同意の後に出すのは順序が逆）。

**未解決の論点は無い**（2026-08-08 時点）。SPEC 20.1 の2件（Q-001・Q-002）に加え、Q-005（Search Console の暦日）と Q-014（サブIDの付け方）も決着した。

新たに判断できない事項が出たら `docs/OPEN_QUESTIONS.md` へ記録し、推測で実装しない。

---

## Phase A：リポジトリ基盤

| ID | タスク | 依存 | 完了条件 | 主な変更先 |
|---|---|---|---|---|
| A-1 | Next.js + TypeScript 基盤作成 | — | build / typecheck が成功 | ルート一式 |
| A-2 | `schema.prisma` 全テーブル定義 | A-1 | SPEC 5章の全テーブルが定義され、migrate が成功 | `prisma/` |
| A-2-R-1 | 人格中心モデル：`Persona` の追加 | A-2 | `Persona` `PersonaType` `PersonaStatus` が追加され、`blogs.persona_id` が **nullable** で入る。既存の `user_personas` は残す。migrate が成功し、既存のコードとテストが通る | `prisma/` |
| A-2-R-2 | 人格中心モデル：コードの移行 | A-2-R-1 | `personas` `content-generation` `content-planning` `users` が `Persona` を参照する。`persona_facts` の所属が人格になる。既存の統合テストが通る | `src/modules/` |
| A-2-R-3 | 人格中心モデル：旧モデルの削除 | A-2-R-2 | `user_personas` が消え、`blogs.persona_id` が **NOT NULL** になる。`blog_persona_settings` が媒体別の上書きのみになる。migrate が成功 | `prisma/` |
| A-2-R-4 | 記憶の所属を人格へ移す（コード） | A-2-R-3 | `persona_facts` の取得・作成・更新が `persona_id` を基準にする。`user_id` `blog_id` を読まなくなる。既存の統合テストが通る | `src/modules/personas/` |
| A-2-R-4-schema | 記憶の所属を人格へ移す（スキーマ） | A-2-R-4 | `persona_facts.persona_id` が **NOT NULL** になり、`user_id` `blog_id` が消える。migrate が成功 | `prisma/` |
| A-3 | 環境変数バリデーション | A-1 | 未設定時に起動が失敗し、欠落名が表示される | `src/lib/env.ts` |
| A-4 | 共通ロガー・エラーレスポンス・権限判定の入口・モジュール境界 | A-1 | 秘密情報がログに出ないことをテストで確認。`can()` が定義されユニットテストがある。`docs/MODULE_RULES.md` が存在する | `src/lib/logger.ts` `src/lib/errors.ts` `src/lib/entitlements.ts` `docs/MODULE_RULES.md` |
| A-5 | テスト基盤とCI | A-1 | lint / typecheck / test / build がCIで成功 | `.github/` `vitest.config.ts` |
| A-6 | ドキュメント初期化 | A-1 | README / ARCHITECTURE / STATUS / HISTORY / OPEN_QUESTIONS が存在 | `docs/` |
| A-7 | 日時ヘルパー（JST基準・週境界） | A-1 | JSTでの日付境界と月曜始まりの週境界がテストで確認できる。UTC基準の日付をJSTへ変換できる | `src/lib/datetime.ts` |
| A-8 | 初期マイグレーション | A-2, A-5 | `prisma/migrations/` がコミットされ、CIで `migrate deploy` が成功する。スキーマとの乖離が検出できる | `prisma/migrations/` `.github/` |
| A-9 | 統合テスト基盤 | A-5, A-8 | 実PostgreSQLに接続するテストがCIで成功する。テストごとにデータがリセットされる | `vitest.integration.config.ts` `src/tests/integration/` `.github/` |

**A-2が最重要。** SPEC 5章は疑似記法のため、`jsonb`の中身・リレーション名・インデックス・`onDelete`をこのタスクで確定させ、`docs/DATA_MODEL.md` に記録する。以降のスキーマ変更は必ずタスク化する。

### A-4 の `src/lib/entitlements.ts` について

将来のオプション課金に備え、権限判定の入口を1箇所に集約する。**Phase 0 では課金を実装しないため `can()` は常に `true` を返す空実装**とし、将来ここだけを差し替えれば課金判定が有効になる形にする。

- 課金テーブル・プラン設計・決済連携は Phase 0 では作らない
- `can()` の呼び出し箇所の追加は各モジュールのタスクで行う。A-4 では関数の定義とテストのみ
- 新しい `Capability` は、それを必要とするモジュールのタスクで追加する

### A-7 を単独タスクにする理由

`docs/DATA_MODEL.md` 10章で「変換ヘルパーは `src/lib/datetime.ts` に集約する。各モジュールで独自に日付計算を書かない」と定めたが、これを作るタスクが存在しなかった。

利用者は **E-9（週4本の上限判定）と G-2・G-6（日次集計）の両方**にまたがる。どちらか片方のタスクに含めると、先に着手した側の都合で設計が決まり、もう一方が独自の日付計算を書き始める。10章のルールが空文になるため、`src/lib/` の基盤として A-3・A-4 と同列に置く。

対象は以下。

- JSTでの日付境界（`metrics_daily.metric_date` などの `date` 列を求める）
- 月曜始まりの週境界（`planned_publish_week`、週4本の上限判定の集計区間）
- UTC基準で返る外部APIの日付をJSTへ変換する（Search Console）

### A-8 を単独タスクにする理由

`DATA_MODEL.md` 9章が「マイグレーションを単独のPRで適用」「機能実装のPRにマイグレーションを混ぜない」と定めている。A-5 のCIは `db push` でスキーマの適用可能性を確認しているだけで、`prisma/migrations/` は存在しない。

**B-1 でDBを使い始める前に初期マイグレーションを確定させる。** 履歴なしで進むと、以降のスキーマ変更の差分管理ができなくなる。

### A-9 を単独タスクにする理由

B-3 で作る所有権検証は **Phase B〜H の全モジュールが使う土台**であり、TASKS.md も「各所で `WHERE id = :id AND user_id = :sessionUserId` を書かせない」と定めている。

差し替え可能な fake DB では、**所有権検証そのもの（SQLの条件）が本当に他人の行を弾いているかを証明できない。** fake は書いたとおりに動くだけである。C-6 まで待つと B-3〜C-5 が未検証のまま積み上がるため、土台を作る前に検証手段を用意する。

**A-9 は基盤だけを作る。** テナント越境の検証そのものは C-6 に残す（同「C-6は必ず単独タスクにする」）。

---

## Phase B：ユーザー・LIFF・ブログ

| ID | タスク | 依存 | 完了条件 | 主な変更先 |
|---|---|---|---|---|
| B-1 | LIFF認証（IDトークン検証） | A-2 | 改竄トークンを拒否。クライアント送信のuser_idを信用しない | `src/modules/auth/` |
| B-2 | ユーザー登録・規約同意・データ利用同意 | B-1 | 同意なしで他APIが403 | `src/modules/users/` |
| B-3 | ブログCRUD | B-2 | 自分のブログのみ取得・更新できる | `src/modules/blogs/` |
| B-4 | 3ブログ上限とslot制御 | B-3 | 4件目の登録が拒否される。slot重複が拒否される。`CLOSED` のスロットを再利用できない（OPEN_QUESTIONS Q-008） | `src/modules/blogs/` |
| B-5 | ブログ設定画面（LIFF） | B-4, B-8 | ブログ名・ペンネーム・想定読者・収益方針・投稿頻度をスマートフォンで編集できる。ジャンルと算出値は表示のみ（OPEN_QUESTIONS Q-009〜Q-011） | `src/app/liff/blogs/` |
| B-6 | 管理者の認可（ADMINロール制御） | B-2 | MONITORが `/admin` へアクセスできない。ログイン手段は OPEN_QUESTIONS Q-012 | `src/modules/auth/`, `src/app/admin/` |
| B-7 | 管理者ユーザー一覧 | B-6 | モニター一覧とオンボーディング状況が表示される | `src/app/admin/users/` |
| B-8 | LIFFクライアント基盤 | B-1 | 設定漏れ・初期化失敗・認証失敗のときに画面へ案内が出る。初期化後にセッションCookieが確立する | `src/app/liff/`, `src/lib/liff/` |
| B-9 | LIFF画面のテスト基盤 | B-5 | 画面のコンポーネントテストが `npm run test` で走る。B-5 の一覧と設定画面について、描画・入力・保存・失敗表示が検証される | `vitest.config.ts`, `src/tests/app/` |
| B-10 | 管理者ログイントークンのテーブル追加 | A-8 | `migrate deploy` が成功し、スキーマとの乖離が無い。トークンのハッシュ・期限・使用時刻を保持できる | `prisma/`, `docs/DATA_MODEL.md` |
| B-11 | 管理者のメール＋ワンタイムリンクログイン | B-6, B-10 | 登録済みADMINのアドレスにだけリンクが届く。リンクは1回だけ使える。期限切れ・使用済み・未登録で応答が変わらない | `src/modules/auth/`, `src/app/admin/login/` |

**所有権検証は B-3 で共通ヘルパーとして実装し、以降の全モジュールで使い回す。** 各所で `WHERE id = :id AND user_id = :sessionUserId` を書かせない。

**スロット番号はサーバーが決める（B-4）。** 作成時に `slotNumber` を省略すると、空いている最小の番号が割り当てられる。一覧APIは `CLOSED` を既定で返さないため、クライアントは自力で空きを計算できない（Q-008）。残枠は `GET /api/blogs` の `slots` で返す。

### 管理者のログインはメール＋ワンタイムリンク（Q-012 で決定）

Supabase は導入しない。**モニター側（LINE Login）は変更せず**、管理者だけメールでログインする。認証の入口は2つになるが、対象者も画面も分かれている（`/liff` と `/admin`）。

認証が通ったあとは**既存のセッションCookie（B-2）を発行する**。`requireAdmin` は変更しない。

作業は2つに分ける。**スキーマ変更は単独タスク**（DATA_MODEL 9章）。

| タスク | 内容 |
|---|---|
| B-10 | トークンのテーブルとマイグレーション |
| B-11 | ログイン画面・リンク発行・検証・セッション発行 |

トークンで守ること。

- **DBにはハッシュだけを保存する。** DBが漏れてもリンクが使えないようにする
- **1回だけ使える。** メールは残るため、期限内の再利用を許すと転送・端末紛失でそのまま入られる
- **期限は15分程度**
- **未登録のアドレスでも応答を変えない。** どのアドレスが登録済みかを教えない
- 同一アドレスへの連続発行を制限する
- **`role = 'ADMIN'` の行にのみ送る。** MONITOR のアドレスへ送らない

**メール送信基盤は未選定（Q-013）。B-11 着手前に決める。**

### 管理者の「認可」と「認証」を分ける（B-6・Q-012）

B-6 の完了条件は「MONITORが `/admin` へアクセスできない」であり、これは**認可**の話である。`requireAdmin` がセッションから解決したユーザーの `role` を見て弾く。

**誰がどうログインするか（認証）は Q-012 で決める。** `SPEC.md` 3.2 は Supabase Auth・メール＋ワンタイムリンク・ADMINロール制御の「いずれか」としており、Supabase は必須ではない。現状このリポジトリに Supabase は入っていない。

認証手段が変わっても `requireAdmin` は影響を受けない。セッションからユーザーを解決した後の判定だからである。

### 画面のテストは B-9 の基盤の上に書く

ロジックはユニットテストと実DBの統合テストで検証しているが、**画面の描画・入力・保存は検証手段が無かった**。B-5・F-4・F-5・G-5・H-2 が同じ状況になるため、B-9 として単独タスクにした。

- `vitest.config.ts` を project に分け、ロジックは `node`、画面は `jsdom` で走らせる
- 画面テストは `src/tests/app/` に `*.test.tsx` として置く
- **APIは差し替える。** サーバー側の判定は統合テストの担当であり、二重に持たない

### LIFFの画面は B-8 の基盤の上に作る

B-1 が実装したのは**サーバー側のIDトークン検証**であり、ブラウザ側で LIFF SDK を初期化してIDトークンを取り出す部分はどのタスクにも無かった。この部分は `/liff/blogs`（B-5）だけでなく `/liff/approvals`（F-4・F-5）、`/liff/results`（G-5）、`/liff/onboarding`（H-2）が同じものを使う。

**B-8 として単独タスクにする。** 最初のLIFF画面である B-5 に含めると、画面の実装と基盤の実装が同じPRに混ざり、後続タスクが「B-5 のどこまでが基盤か」を読み解くことになる。

### 設定ミスは ADMIN の介入で救済する（Q-007・Q-008）

モニターは **WordPress接続先を変更できず**（Q-007）、**`CLOSED` にしたスロットも再利用できない**（Q-008）。この2つが重なると、オンボーディングでの接続ミスが1/3の枠を恒久的に潰す。

そのため **ADMIN の手動介入を正規の救済手段とする**（SPEC 3.1）。

- ADMIN は `site_url` の変更とスロットの解放ができる
- **記事を投稿していないブログに限る**（`wordpress_posts` が0件）。投稿済みを消すと実測データが失われる
- 介入は `audit_logs` に残す
- **Phase 0 では専用の管理UIとAPIを作らない。** SQLまたは管理画面の既存機能で行う（SPEC 10.3 と同じ扱い）。手順は H-6 に記載する

---

## Phase C：WordPress

| ID | タスク | 依存 | 完了条件 | 主な変更先 |
|---|---|---|---|---|
| C-1 | 接続情報の暗号化保存 | A-3, B-4 | 復号値がAPIレスポンス・ログに出ない。**接続後の `site_url` 変更が拒否される**（OPEN_QUESTIONS Q-007） | `src/modules/wordpress/` |
| C-2 | 接続テスト（7項目） | C-1, C-7 | 権限不足を個別のエラーコードで返す | `src/modules/wordpress/` |
| C-3 | 下書き投稿 | C-2 | `status: draft` 以外で投稿されない | `src/modules/wordpress/` |
| C-4 | 冪等性（idempotency_key） | C-3 | 同一ジョブ再実行で二重投稿されない | `src/modules/jobs/` |
| C-5-schema | `wordpress_posts.user_edited_at` の追加 | C-4 | マイグレーションのみ。DATA_MODEL 11章 | `prisma/` |
| C-5 | 投稿更新とWP同期 | C-5-schema | content hash が同一なら更新しない。公開状態を取り込む。未編集判定の実装（DATA_MODEL 11章） | `src/modules/wordpress/` |
| C-6-schema | `wordpress_posts` と `content_items` のブログ一致を複合外部キーで強制 | C-5 | マイグレーションのみ。DATA_MODEL 4章 | `prisma/` |
| C-6 | テナント越境の統合テスト | C-6-schema | 2ユーザー×2ブログで越境投稿が発生しない | `src/tests/integration/` |
| C-7 | 外向きHTTPの共通クライアント（SSRF対策） | A-4 | private・loopback・link-local へ到達しない。リダイレクト先を再検証する。タイムアウト・最大サイズ・Content-Type を強制する（SPEC 14.3） | `src/lib/http/` |
| C-9-schema | ブログごとの公開スケジュールの列 | B-4 | `blogs` に公開曜日・時刻・ゆらぎ・パーマリンク様式・初期記事数が入る。**週の上限は足さない**（既存の `article_ratio.weeklyPublishCap`・Q-036）。migrate が成功 | `prisma/` |
| C-9-schema-2 | 公開時刻を必須にする | C-9 | `blogs.publish_time` が **NOT NULL** になる。migrate が成功 | `prisma/` |
| C-9-schema-3 | 公開曜日を空にできなくする | C-9-schema-2 | `blogs.publish_weekdays` が**空のまま保存できない**（CHECK）。マイグレーションのみ。**時刻だけあって曜日が空だと、結局いつも公開されない**（`publish_time` の NOT NULL だけでは塞がらない） | `prisma/` |
| C-9 | ブログごとの公開スケジュールとURL様式 | C-9-schema | `blogs` に公開曜日・時刻・ゆらぎ・週上限・パーマリンク様式・初期記事数を持ち、**登録時に既存ブログと重複しにくいよう分散して割り当てる**。**全ブログの投稿ジョブが同一時刻に集中しない**。パーマリンクは初回設定後に変更しない（作業指示書 W-8） | `prisma/` `src/modules/blogs/` |

### WordPress接続先は後から変えられない（Q-007）

接続後に `site_url` を別のサイトへ変更できない。接続先が変わると `wordpress_posts`・`metrics_daily`・Search Console のデータが別サイトのものと混ざり、実験データとして読めなくなるため。

- **同一 `site_url` のままの再接続は許可する。** 認証情報の入れ替え・権限の付け直し・接続エラーからの復旧に必要
- `disconnect` で `REVOKED` にしても `site_url` は保持し、再接続時に一致を確認する
- サイトを変えたい場合はブログを `CLOSED` にして作り直す

**C-6は必ず単独タスクにする。** 他タスクのついでに書かせると省略される。

### 外向きHTTPは C-7 に集約する

**C-2 はモニターが入力したURLへ実際にリクエストを出す。** 内部ネットワークへ向けたURLを入れられると、そこから応答が返るかどうかで社内の構成を調べられる（SSRF）。SPEC 14.3 が定める対策は D-2（LP自動評価）でも必要になるため、**共通のクライアントとして C-7 に切り出し、C-2 はそれを使う**。番号は後だが **C-2 の前提**である（D-9 と D-1 の関係と同じ）。

| 対策（SPEC 14.3） | 実現 |
|---|---|
| http/https のみ | URLの検証 |
| localhost・private IP・link-local 禁止 | **名前解決した結果のIPで判定する。** ホスト名の見た目では判定できない |
| リダイレクト先再検証 | 転送のたびに最初と同じ検証をやり直す |
| タイムアウト・最大レスポンスサイズ | 応答が来ない・巨大な応答で詰まらせない |
| Content-Type 確認 | 期待した種類でなければ本文を解釈しない |

**接続先の固定された外部API（LINE・Resend）はこの経路を通さない。** 宛先を利用者が決められないため、SSRF の対象ではない。

---

## Phase D：案件・バナー・分身・リダイレクタ

| ID | タスク | 依存 | 完了条件 | 主な変更先 |
|---|---|---|---|---|
| D-1 | 案件CRUD | B-4, D-9, D-10 | ブログ別に分離。他ブログの案件が見えない。リンクの組み立てが1関数に集約され、`REDIRECT` / `DIRECT` を切り替えられる。全案件にサブIDが付く（OPEN_QUESTIONS Q-001） | `src/modules/affiliate/` |
| D-2-schema | `affiliate_offers.lp_content_length` の追加 | D-1 | マイグレーションのみ。SPEC 9.2.3 の「ページ長」の保存先 | `prisma/` |
| D-2 | LP自動評価 | D-2-schema, C-7 | SSRF対策を満たし、フォーム項目数・ページ長・viewportを判定 | `src/modules/affiliate/` |
| D-3 | バナーCRUD | B-4 | 表示位置・対象カテゴリ・有効期間が保存される | `src/modules/banners/` |
| D-4 | `user_personas` | B-2 | ユーザー共通人格を編集できる | `src/modules/personas/` |
| D-5 | `blog_persona_settings` | D-4, B-4 | ブログ別の上書き設定が保存される | `src/modules/personas/` |
| D-6 | `persona_facts` | D-4 | `AI_INFERENCE` かつ `UNVERIFIED` が一人称利用不可のフラグを持つ | `src/modules/personas/` |
| D-7a | LINE返信の分類 | D-6 | 返信が SPEC 8.4 の4種類（感想・助言・自由回答・修正希望）に分かれる。**DBも外部も触らない純粋な処理。** **修正希望は分類だけで保存しない**（宛先の承認が決まらない。下記 D-7b） | `src/modules/line/` |
| D-7b | LINE返信の受け口とfacts保存 | D-7a, F-6 | `POST /api/line/webhook` が**署名を検証**し、返信が `persona_facts` に保存される。**修正希望は保存せず承認画面（F-6）へ案内する** — `revision_requests.approval_id` は NOT NULL だが、**テキスト返信はどの記事への返信かを示さない**（取り違えると望まない書き換えが起きる）。**分身が2体以上あるときも保存せず案内する**（どの分身の記憶かを決められない・Q-037） | `src/app/api/line/webhook/` `src/modules/line/` |
| D-8 | アフィリエイトリダイレクタとクリック計測 | D-1 | リンク方式に従って組み立てられ、**`REDIRECT` の案件でクリックが記録される**。`DIRECT` の案件は直リンクのまま（OPEN_QUESTIONS Q-001） | `src/app/go/` `src/modules/analytics/` |
| D-12-schema | クリック受信APIのための列 | D-8 | `blogs.link_event_token_hash` と `banners.code` が入り、`link_clicks` がバナーのクリックも受けられる（**どちらか片方だけ**をDBが強制する）。migrate が成功 | `prisma/` |
| D-12-schema-2 | クリックの再送を二重に数えない列 | D-12-schema | `link_clicks.event_id` が **unique** で入る。同じ電文が2回届いても行が増えない。migrate が成功 | `prisma/` |
| D-12 | リダイレクタを各ブログのドメインへ移す | D-12-schema-2 | 各WordPressのスニペットが `/go/{code}` を処理し、Bunshin の受信APIへ送る。**受信APIはブログ単位のトークンで認証し、他ブログのイベントを投入できない**。IPアドレスを保存せずUser-Agentはハッシュ化する。**バナーも同じ経路を通り、`metrics_daily.banner_clicks` が記録される**（Q-032）。**WordPress側スニペットの導入手順が `docs/` に文書化されている**（Q-001 の再決定・2026-08-11） | `src/app/api/link-events/` `src/modules/analytics/` `src/modules/banners/` `docs/` |
| D-13-schema | `affiliate_offers.facts_updated_at` | D-1 | マイグレーションのみ。**行の `updated_at` とは別に、事実を確かめ直した時刻だけを持つ**（Q-022） | `prisma/` |
| D-13 | 案件の事実の更新経路 | D-13-schema | `facts` を更新した経路だけが `facts_updated_at` を書く。E-12 の90日判定が実際に効く（**いま全収益記事が `WARNING`**） | `src/modules/affiliate/` |
| D-9 | 案件のリンク方式のテーブル追加 | A-8 | `migrate deploy` が成功し、スキーマとの乖離が無い。既定が `DIRECT` になる | `prisma/`, `docs/DATA_MODEL.md` |
| D-10 | サブIDのパラメータ名のテーブル追加 | A-8 | `migrate deploy` が成功し、スキーマとの乖離が無い。既定が `NULL`（サブIDを付けない）になる | `prisma/`, `docs/DATA_MODEL.md` |
| D-11 | リンクの案件と記事を同じブログに縛る | A-2, E-6 | 他人の記事IDを紐づけたリンクが作れない（Q-020）。**マイグレーションと実装を分けられない** — `blog_id` は NOT NULL で、埋める側が同じ変更に要る | `prisma/`, `src/modules/affiliate/` |

**D-8をPhase Gから前倒ししている。** 記事生成（E-8）でリンクを本文に埋め込むため、リダイレクタが後発だと公開済み記事のリンクを全て貼り替えることになる。

### リンクの出し方は案件ごとに切り替える（Q-001 で決定）

**ASPによって、別ドメインのリダイレクタ経由の掲載を許すところと許さないところがある。** そのため方式を1つに決めず、案件ごとに持つ。

| 値 | 本文に埋めるURL | クリック計測 |
|---|---|---|
| `REDIRECT` | `/go/<code>` | `link_clicks` に記録 |
| `DIRECT` | `affiliate_url` をそのまま | サブID（成果）／必要ならビーコン（概算） |

- **既定は `DIRECT`（安全側）。** 規約を確認できたASPだけ `REDIRECT` へ上げる。判断がつかないものを許可側へ倒すと、成果が無効になったときに取り返しがつかない
- **モニターに規約の判断をさせない。** ASP単位の既定値は ADMIN が設定する（Phase 0 は設定ファイルまたはSQL。SPEC 10.3 と同じ扱い）
- **サブIDは全案件に付ける。** ASPが用意した機能なので規約上の問題が無く、**成果を記事単位で紐づけられる**。リダイレクタが担うクリック計測とは役割が違う
- **リンクの組み立ては `src/modules/affiliate/` の1関数に集約する。** ここに閉じておけば、後からASPの規約が変わっても影響するのは以後に生成される記事だけで、公開済み記事の貼り替えは起きない
- **`REDIRECT` と `DIRECT` のクリック数を混ぜて集計しない**（意味も精度も違う）

**スキーマ変更は D-9 として単独タスクにする**（DATA_MODEL 9章）。D-1 は D-9 に依存する。

### サブIDは案件ごとにパラメータ名を持つ（Q-014 で決定）

**付け方はASPごとに違う**（`sub` `s1` `argument` など）。**`affiliate_offers.sub_id_param`（NULL可）に名前を持ち、`NULL` なら付けない。**

- **ASPの情報がゼロでも D-1 は動く。** 案件は登録でき、サブIDが付かないだけ
- 分かったASPから順に ADMIN が SQL で埋める（SPEC 10.3 と同じ扱い）
- 値は `<slot>-<contentItemId>`。**`REDIRECT` の案件にも付ける**（リダイレクタはクリック、サブIDは成果。役割が違う）

**スキーマ変更は D-10 として単独タスクにする**（DATA_MODEL 9章）。D-1 は D-10 に依存する。

---

## Phase E：構成表・記事生成

| ID | タスク | 依存 | 完了条件 | 主な変更先 |
|---|---|---|---|---|
| E-1 | ジョブ基盤（キュー・再試行・状態管理） | A-2 | 長時間処理がリクエスト内で走らない | `src/modules/jobs/` |
| E-2 | プロンプト管理とバージョニング | A-2 | プロンプトの有効化・ロールバックができる | `src/modules/content-generation/` |
| E-3 | AIプロバイダー抽象化とモデルルーティング | A-3, E-2 | モデル名が環境変数・設定テーブル経由で切替可能 | `src/lib/ai/` |
| E-4 | STEP 1 ジャンル審査 | E-1 | 停止条件を満たすジャンルが通過しない。差し戻し2回で選択肢が出る | `src/modules/content-planning/` |
| E-5-schema | `affiliate_offers.blog_posting_prohibited` | A-2 | マイグレーションのみ。ADMIN が設定する（Q-019） | `prisma/` |
| E-5 | STEP 2 案件スコアリング | D-2, E-4, E-5-schema | 足切り・100点満点スコア・上位3件採用がコードで判定される | `src/modules/content-planning/` |
| E-6 | STEP 3 収益記事の設計 | E-5 | 記事数が「案件数×2＋1」で算出される | `src/modules/content-planning/` |
| E-7 | STEP 4 集客記事とリンク設計 | E-6 | リンク先に `AFFILIATE` 以外を指定できない | `src/modules/content-planning/` |
| E-8 | 制約チェックと再生成ループ | E-7 | SPEC 9.2.6の全項目を判定。3回で収束しなければジョブ FAILED | `src/modules/content-planning/` |
| E-9 | 公開順序の付与 | E-8 | 収益記事が先行し、集客記事が週4本を超えない | `src/modules/content-planning/` |
| E-10 | 記事生成（本文・内部リンク・CTA） | E-3, E-9 | 構成表を参照して生成。単体生成モードを作らない | `src/modules/content-generation/` |
| E-11 | アンサーカプセル・FAQ・JSON-LD | E-10 | H1直後に80〜120字の結論。JSON-LDが構文的に妥当 | `src/modules/content-generation/` |
| E-12 | 事実チェック | E-10, D-6 | facts外の数値・条件を検出。FAILEDは承認依頼へ送らない | `src/modules/content-generation/` |
| E-13 | 禁止表現・リスクフラグ・PR表記 | E-10 | PR表記欠落と断定表現を検出 | `src/modules/content-generation/` |
| E-14 | AI費用ログ | E-3 | ユーザー別・ブログ別・記事別・モデル別に記録される | `src/modules/ai-costs/` |
| E-15 | 予算通知（80/100/150%） | E-14 | 超過しても生成が停止しない。ADMINへ通知される | `src/modules/ai-costs/` |

### AIとコードの境界（E-4〜E-9で厳守）

| 担当 | 範囲 |
|---|---|
| **AI** | ジャンルの妥当性コメント、キーワード案、タイトル案、検索意図の言語化、隣接ジャンルの提案 |
| **コード** | 足切り、スコア計算、記事本数の算出、リンク本数の集計、重複検出、再生成ループの制御、制約チェックの合否判定 |

**判定は必ずコード側で行う。** AIに「制約を満たしているか」を判断させてはならない。
各STEPのAI呼び出しは、入出力をJSONスキーマで定義し、`docs/CONTENT_PLANNING.md` に記載する。
| E-16 | 構造化データから `Review` を外す | E-11 | `FAQPage` だけを出す。**評点の出どころが無く、作り出すことは SPEC 9.6 が禁じる「根拠のないランキング」になる**（Q-021）。`docs/CONTENT_PLANNING.md` 7.3 もあわせて直す | `src/modules/content-generation/` `docs/` |

---

## Phase F：LINE承認

| ID | タスク | 依存 | 完了条件 | 主な変更先 |
|---|---|---|---|---|
| F-1 | 提案の優先順位算出（3ブログ横断） | E-10 | 優先度と提案理由が保存される | `src/modules/approvals/` |
| F-2 | LINE通知送信 | F-1 | 同一提案を連続通知しない | `src/modules/line/` |
| F-3 | 通知数制御（既定1日1件・最大2件） | F-2 | 3ブログ合計で制限される。緊急通知は別枠 | `src/modules/line/` |
| F-3b | 通知の曜日・時刻を効かせる | F-3 | `monitor_profiles.notification_days` / `notification_time` を読み、**JSTで指定の曜日・時刻にだけ送る**。**送れなかった提案は翌日へ持ち越す**（溜め続けない）。H-2 の前に要る（Q-025） | `src/modules/line/` |
| F-4 | LIFF承認一覧 | F-1 | 他ユーザーの承認を開けない | `src/app/liff/approvals/` |
| F-5 | LIFF承認詳細（記事全文・リスク表示） | F-4, E-12 | 未確認事実とリスク警告が表示される | `src/app/liff/approvals/` |
| F-6 | 承認・修正依頼・見送りAPI | F-5 | トランザクションと冪等性を持つ | `src/modules/approvals/` |
| F-7 | 承認からWordPress投稿ジョブ連携 | F-6, C-4 | 承認→下書き投稿がE2Eで成功 | `src/modules/jobs/` |

---

## Phase G：計測・分析

| ID | タスク | 依存 | 完了条件 | 主な変更先 |
|---|---|---|---|---|
| G-1 | Search Console OAuth連携 | B-4 | ブログ単位で連携でき、トークンが暗号化される | `src/modules/analytics/` |
| G-2 | Search Analytics 取得ジョブ | G-1, E-1 | 日次で表示回数・クリック・順位を保存。API上限を考慮 | `src/modules/analytics/` |
| G-3 | インデックス状況取得（別ジョブ） | G-2 | URL Inspection の結果が保存される | `src/modules/analytics/` |
| G-4 | AI検索流入の判別 | D-8 | 対象ドメインが設定ファイルで追加できる | `src/modules/analytics/` |
| G-5 | 手動収益入力（週次） | B-4 | 成果件数と報酬額のみ入力。0件を1操作で記録できる | `src/app/liff/results/` |
| G-6 | `metrics_daily` 集計 | G-2, G-5 | SPEC 10.2の記録条件が全て保存される | `src/modules/analytics/` |
| G-7 | 管理ダッシュボード | G-6 | ジャンル別・戦略別・ブログ別の集計がSQLで取得できる | `src/app/admin/` |

**実験グループの管理UIとAPIは作らない。** `experiment_groups` への登録はSQLまたはシードで行う（SPEC 10.3）。
| G-8a | 週の公開上限の範囲を 3〜5 にする | C-9 | `WEEKLY_PUBLISH_CAP_MIN`/`MAX`・設定画面の選択肢・構成表の上限判定が **3〜5** になる（Q-036 の SPEC 改訂をコードへ）。**0は利用者が選べない**（停止は G-8b の異常時の処理） | `src/modules/blogs/` `src/modules/content-planning/` `src/app/liff/` `docs/DATA_MODEL.md` |
| G-8b | インデックス率による公開ペース調整 | G-3, G-8a | ブログ単位で2週間ごとに判定し、`weekly_post_cap` を上下させる（80%以上→+1・上限5、50%未満→0にしてADMINへ通知）。**公開後14日未満の記事は母数に含めない**。調整の履歴を管理画面で確認できる（作業指示書 W-8） | `src/modules/analytics/` `src/app/admin/` |

---

## Phase H：モニター運用準備

| ID | タスク | 依存 | 完了条件 | 主な変更先 |
|---|---|---|---|---|
| H-1 | 招待フロー | B-7 | 招待〜ACTIVE化が管理画面で完結 | `src/modules/users/` |
| H-3b-schema | リンク切れの状態を持つ列 | A-2 | マイグレーションのみ。`affiliate_offers` に `link_checked_at` / `link_broken_at`（Q-029） | `prisma/` |
| H-3b | リンク切れの状態を保存して見せる | H-3b-schema, H-3 | 確認の結果を保存し、**いつから切れているか**が画面で分かる（SPEC 6.1「エラー」） | `src/modules/affiliate/` `src/app/liff/` |
| H-12 | 監査ログを SPEC 14.4 に揃える | H-11 | **承認・公開・WordPress接続変更**が `audit_logs` に残る（Q-027）。残り4種類（ログイン・案件URL変更・ジョブ再実行・AIプロンプト変更）は後続 | `src/modules/approvals/` `src/modules/wordpress/` `src/app/api/jobs/` |
| H-13 | 監査ログの残り3種類 | H-12 | **ログイン・案件URL変更・AIプロンプト変更**が `audit_logs` に残る（Q-027 で後回しにした分）。**ジョブ再実行は除く** — 手で積み直す入口がどこにも無く、**無い操作は記録できない**（下の H-14） | `src/modules/auth/` `src/modules/affiliate/` `src/modules/content-generation/` |
| H-14 | ジョブの手動再実行 | H-13 | 失敗したジョブを ADMIN が積み直せる。**その操作が `audit_logs` に残る**（SPEC 14.4「ジョブ再実行」。これで8種類が揃う）。**冪等キーの扱いを決める必要がある** — 同じキーでは積み直せない（C-4） | `src/app/admin/(protected)/` `src/modules/jobs/` |
| D-14 | 分身のAPIと画面 | A-2-R-4-schema | `POST/GET/PATCH /api/personas`、使い始める・止める。LIFFで分身を作れる。**上限と段階解放の理由が画面に出る**（「上限です」だけにしない）。**H-2 の前に要る** — 分身が無いとブログを作れない（Q-035） | `src/app/api/personas/` `src/app/liff/personas/` |
| H-2a | オンボーディングの現在地 | D-12, D-14 | **中断・再開ができる。** 現在地を保存せずデータから導く。10段が画面に出て、いまの段が分かる | `src/modules/users/onboarding.ts` `src/app/liff/onboarding/` |
| H-2b | オンボーディングの足りない入口 | H-2a | 同意（段2・3）と通知の曜日・時刻（段9）を**受け付けられる**。`monitor_profiles` の行ができ、`onboarding_status` が導いた値で更新される | `src/app/api/` `src/app/liff/onboarding/` |
| H-2 | オンボーディング（LIFF 10ステップ） | H-2a, H-2b, H-1, C-2, D-1 | 中断・再開ができる。**`/go/` 用スニペットの導入がステップに含まれる**（Q-001 の再決定）。**段4は「目標登録」ではなく「分身を作る」**（Q-035、2026-08-12）— 目標は分身の `business` に含まれる | `src/app/liff/onboarding/` |
| H-3 | エラー通知とサポート依頼 | F-2 | 接続切れ・リンク切れ・案件終了が緊急通知される | `src/modules/line/` |
| H-4 | 退会・停止処理 | B-2 | 物理削除せずCLOSED。データエクスポートができる | `src/modules/users/` |
| H-5 | バックアップ | A-2 | 日次バックアップと復旧手順が文書化されている | `docs/` |
| H-6 | 操作マニュアルとデータ利用同意文 | H-2 | モニターが自力でオンボーディングを完了できる | `docs/` |
| H-7-schema | `app_settings` テーブル | A-2 | マイグレーションのみ。秘密は暗号化列に入る | `prisma/` |
| H-7 | 設定の解決と保存（DB→環境変数→既定） | H-7-schema, C-1 | 保存済みの秘密を復号して返す入口が無い。解決順がテストで確かめられる | `src/modules/settings/` |
| H-8 | 接続テスト（AI・メール・LINE） | H-7 | **保存前の値でも試せる**。応答本文を画面へ出さない | `src/modules/settings/` |
| H-9 | 管理画面 `/admin/settings` | H-8, B-6 | 画面から設定と接続テストができる。秘密は末尾4文字しか表示しない | `src/app/admin/(protected)/settings/` |
| H-10 | 既存の呼び出し口を設定経由にする | H-7 | メール送信とAI呼び出しが**DBの設定を見る**。設定したのに効かない箇所が残らない | `src/lib/mailer/`, `src/modules/auth/` |
| H-11 | 監査ログ（`audit_logs`） | A-2 | ADMINの介入と「承知で進める」の選択が記録される（Q-018） | `src/modules/audit/` |

### 設定を管理画面から変える（Q-017 で決定）

**すべてを画面へ出すことはできない。** 設定はDBにあり、DBを読むには設定が要る。

| 環境変数のまま | 画面から設定 |
|---|---|
| `DATABASE_URL` `ENCRYPTION_KEY` `SESSION_SECRET` `LINE_LOGIN_CHANNEL_ID` `APP_BASE_URL` `CRON_SECRET` `NEXT_PUBLIC_*` | `AI_PROVIDER` `AI_MODEL_*` `AI_PRICE_*` `AI_BUDGET_*` `ANTHROPIC_API_KEY` `RESEND_API_KEY` `MAIL_FROM` LINE Messaging API のトークン |

画面から設定できるのは、**アプリが動いた後で初めて要るもの**に限る。`NEXT_PUBLIC_*` は
ビルド時にブラウザへ埋め込まれるため、DBに置いても効かない。

- **秘密を復号して返す入口を作らない。** 画面に出すのは末尾4文字と更新日時だけ
- **解決順は DB → 環境変数 → コード既定。** 「画面で設定したのに効かない」が最も原因を追いにくい
- **接続テストは保存前の値でも試せる。** 誤った鍵を保存してから気づく順序にしない
- E-3 の `AiConfigSource` は**辞書を受け取る形**になっているため、解決済みの設定を
  そのまま渡せる。`src/lib/ai/` 側の作り替えは要らない
- **保存できるだけでは終わらない。** 読む側が `process.env` を直接見ていると
  「設定したのに効かない」が残る。既存の呼び出し口の付け替えは **H-10**

**H-1 の募集要項には「ドメイン・サーバーの費用はモニター負担」と明記する**（Q-002）。提示するのは**規約同意（H-2 のオンボーディング 2・3）より前**。費用の話は参加可否そのものなので、同意させた後に出すのは順序が逆になる。

### 段階投入

| 段階 | 人数 | 期間 | 通過条件 |
|---|---|---|---|
| 第1段階 | 2名（最大6ブログ） | 4週間 | 重大事故ゼロ、承認→下書き投稿が安定 |
| 第2段階 | +3名（累計5名） | 4週間 | AI費用が想定内、修正率が第1段階より低下 |
| 第3段階 | +5名（累計10名） | — | — |

ドメイン取得時期も段階ごとに分散させる。

---

## 参照ドキュメントの割り当て

各タスクで読ませるドキュメントを限定する。

| Phase | 参照 |
|---|---|
| A | `SPEC.md` 4章・5章、`DATA_MODEL.md` |
| B | `SPEC.md` 3章・6.1・13章、`DATA_MODEL.md` |
| C | `SPEC.md` 7章・14章 |
| D | `SPEC.md` 5.6〜5.9・14.3 |
| E | `SPEC.md` 9章・12章、`CONTENT_PLANNING.md` |
| F | `SPEC.md` 8章・6.1・13.6 |
| G | `SPEC.md` 10章・11章 |
| H | `SPEC.md` 17章 Phase H・16章 |

---

## 進捗管理

`docs/IMPLEMENTATION_STATUS.md` に本表のIDを転記し、各行に以下を持たせる。

```text
ID / 状態（未着手・実装中・レビュー中・完了）/ PR番号 / 完了日 / 残課題
```

**タスク総数：83**（当初75。スキーマ変更を単独タスクにしたぶんと、
設定の画面化（Q-017）・監査ログ（Q-018）で増えた）

| Phase | 件数 |
|---|---|
| A | 9 |
| B | 11 |
| C | 9 |
| D | 12 |
| E | 16 |
| F | 7 |
| G | 7 |
| H | 12 |

**この数はこれまで実際の表と合っていなかった**（表を数えると71件だが「59」から加算して書き継いでいた）。C-7 の追加にあたって各Phaseの表を数え直し、内訳を併記した。以降は表を変えたらこの内訳も直す。
