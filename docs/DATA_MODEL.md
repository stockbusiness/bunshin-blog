# DATA_MODEL.md — スキーマ補足

対象：`prisma/schema.prisma`
対応仕様：`docs/SPEC.md` v2.1 第5章
タスク：A-2

---

## 1. 方針

- テーブル名・カラム名は snake_case、Prismaモデル名は PascalCase（`@map` / `@@map` で対応）
- 主キーは全て `uuid`
- 日時は `timestamptz`、日付のみは `date`
- 金額（円）は `Int`、USDコストは `Decimal(10,6)`
- 仕様書5章に記載のないテーブルは「追加テーブル」として6章に根拠を記載した。**実装前に承認を得ること**

---

## 2. onDelete の方針

| 関係 | 挙動 | 理由 |
|---|---|---|
| User → Blog | `Restrict` | 退会は物理削除せず `WITHDRAWN` で扱う（SPEC 13.2）。誤削除で30ブログ分のデータを失わないため |
| Blog → 配下全て | `Cascade` | ブログ削除時に接続情報・案件・記事を残さない |
| Blog → Genre | `SetNull` | ジャンルマスタの整理でブログを消さない |
| Blog → ExperimentGroup | `SetNull` | 実験グループの入替でブログを消さない |
| ContentItem → AffiliateOffer | `SetNull` | 案件終了後も記事と履歴は残す |
| ContentItem → ContentItem（リンク） | `SetNull` | 構成表の再生成で相互参照が壊れないようにする |
| AiUsageLog / AuditLog の外部参照 | `SetNull` | 費用実績と監査証跡は参照先が消えても保持する |

**監査ログとAI費用ログは、参照先が消えても残す。** Phase 0の目的が実測データの蓄積であるため。

---

## 3. jsonb の構造

型定義は `lib/types/` に TypeScript として置き、Zodで検証する。

### `blogs.article_ratio`

```ts
{
  revenue: number;    // 収益記事の本数（9.2.4の算出値）
  traffic: number;    // 集客記事の本数
  weeklyPublishCap: number; // 既定 4（SPEC 2.2）
}
```

### `user_personas.base_profile` / `tone` / `values`

```ts
base_profile = { ageRange: string; position: string; firstPerson: string; background: string }
tone         = { style: string; emojiLevel: "none"|"low"|"mid"; lineBreak: "short"|"normal"; politeness: string }
values       = { priorities: string[]; avoid: string[] }
```

### `blog_persona_settings.tone_override` / `target_reader` / `writing_rules`

```ts
tone_override = Partial<typeof tone>  // 未指定項目は user_personas を継承
target_reader = { ageRange: string; situation: string; knowledgeLevel: "beginner"|"intermediate"|"advanced" }
writing_rules = { headingDepth: number; leadLength: number; bulletFrequency: "low"|"mid"|"high" }
```

### `affiliate_offers.facts`

**記事生成の事実制約に使う最重要フィールド（SPEC 9.5.3）。ここに無い数値・機能・条件を本文に書かせない。**

```ts
{
  price: { label: string; amountYen: number | null; note: string }[];
  features: string[];
  conditions: string[];   // 成果条件・利用条件
  restrictions: string[]; // 否認条件・表現上の制限
  updatedAt: string;      // ISO8601。古い facts は WARNING 扱い
}
```

### `affiliate_offers.link_mode`

TASKS D-9。記事本文へ埋めるアフィリエイトリンクの出し方（OPEN_QUESTIONS Q-001）。

| 値 | 本文に埋めるURL | クリック計測 |
|---|---|---|
| `REDIRECT` | 自前の `/go/<code>` | `link_clicks` に記録 |
| `DIRECT`（既定） | `affiliate_url` をそのまま | サブID（成果）のみ |

**既定は `DIRECT`（安全側）。** ASPによって別ドメインのリダイレクタ経由の掲載を許すところと許さないところがあるため、方式を1つに決めず案件ごとに持つ。判断がつかないものを許可側へ倒すと、成果が無効になったときに取り返しがつかない。

- **設定するのは ADMIN。** モニターに規約の判断をさせない。Phase 0 は SQL で設定する（SPEC 10.3 の `experiment_groups` と同じ扱い）
- **リンクの組み立ては `src/modules/affiliate/` の1関数に集約する**（D-1）。ここに閉じておけば、後からASPの規約が変わっても影響するのは以後に生成される記事だけ
- **`REDIRECT` と `DIRECT` のクリック数を混ぜて集計しない。** `link_clicks` に行があるのは `REDIRECT` の案件だけなので、この表から数えるかぎり混ざらない

### `affiliate_offers.sub_id_param`

TASKS D-10。アフィリエイトURLへ付けるサブIDのパラメータ名（OPEN_QUESTIONS Q-014）。

**付け方はASPごとに違う**（`sub` `s1` `argument` など）。名前をデータで持ち、**`NULL` ならサブIDを付けない**。

```
https://asp.example/click?a=xxxx&<sub_id_param>=<slot>-<contentItemId>
```

- **ASPの情報がゼロでも案件は登録できる。** サブIDが付かないだけ
- 設定するのは ADMIN。Phase 0 は SQL で入れる（SPEC 10.3 と同じ扱い）
- **`REDIRECT` の案件にも付ける。** リダイレクタはクリックを数え、サブIDは成果を紐づける。役割が違う（Q-001）
- **パス埋め込み型のASP**（`.../click/<値>`）はこの列で表現できない。出てきた時点で論点として起票する

### `affiliate_offers.score_breakdown`

```ts
{
  conversionPoint: number; // 0-30
  reward: number;          // 0-20
  lpQuality: number;       // 0-20
  searchDemand: number;    // 0-15
  experience: number;      // 0-10
  denyConditions: number;  // 0-5
  total: number;
  excludedBy: string | null; // 足切り理由。null なら通過
}
```

### `article_versions.risk_flags` / `unverified_claims`

```ts
risk_flags = { code: string; severity: "info"|"warning"|"error"; message: string; excerpt: string }[]
unverified_claims = { claim: string; expectedSource: "offer_facts"|"persona_facts"; matched: boolean }[]
```

### `planning_runs.constraint_result`

SPEC 9.2.6の判定結果をそのまま保存する。

```ts
{
  totalArticles: { expected: number; actual: number; ok: boolean };
  revenueArticles: { expected: number; actual: number; ok: boolean };
  inboundPerRevenue: { itemId: string; actual: number; ok: boolean }[];
  outboundPerTraffic: { itemId: string; actual: number; ok: boolean }[];
  keywordDuplicates: string[];
  invalidLinkTargets: string[]; // AFFILIATE 以外を指していた記事ID
  passed: boolean;
}
```

---

## 4. アプリ層で検証する制約

Prismaのスキーマでは表現できない。**`modules/content-planning/constraints.ts` に集約し、DBに書く前に必ず通す。**

| # | 制約 | 該当 |
|---|---|---|
| 1 | `outbound_link_item_ids` の要素は `content_type = AFFILIATE` の記事のみ | SPEC 9.2.5 |
| 2 | `content_type = AFFILIATE` の記事は `outbound_link_item_ids` が空 | SPEC 5.12 |
| 3 | `outbound_link_item_ids` は2件以下 | SPEC 9.2.5 |
| 4 | `content_type = AFFILIATE` の記事は `inbound_link_item_ids` が3件以上 | SPEC 9.2.6 |
| 5 | 同一ブログ内で `primary_keyword` が重複しない | SPEC 9.2.5 |
| 6 | 収益記事数 ＝ 採用案件数 × 2 ＋ 1（上限10） | SPEC 9.2.4 |
| 7 | 1週あたりの `planned_publish_week` の件数が4以下 | SPEC 2.2 |
| 8 | `verification = UNVERIFIED` かつ `source = AI_INFERENCE` の fact は一人称利用不可 | SPEC 5.7 |

**1〜7はDBのCHECK制約でも一部表現できるが、Phase 0ではアプリ層に一本化する。** 二重管理を避け、違反時のエラーメッセージを制約チェック結果（`planning_runs.constraint_result`）として保存できるようにするため。

ただし以下2件は**DB側にも入れる**。取り違えると事故になるため。

```sql
ALTER TABLE blogs ADD CONSTRAINT blogs_slot_range CHECK (slot_number BETWEEN 1 AND 3);
ALTER TABLE content_items ADD CONSTRAINT content_items_outbound_max CHECK (array_length(outbound_link_item_ids, 1) IS NULL OR array_length(outbound_link_item_ids, 1) <= 2);

-- B-10。期限切れのトークンを発行しても「なぜかログインできない」としか
-- 分からず、原因の切り分けが難しい
ALTER TABLE admin_login_tokens ADD CONSTRAINT admin_login_tokens_expiry_after_creation CHECK (expires_at > created_at);
ALTER TABLE admin_login_tokens ADD CONSTRAINT admin_login_tokens_used_after_creation CHECK (used_at IS NULL OR used_at >= created_at);
```

`blogs` の3件上限（`UNIQUE(user_id, slot_number)` ＋ 上記CHECK）で、4件目は構造的に登録できない。

---

## 5. インデックスの根拠

| インデックス | 用途 |
|---|---|
| `blogs(user_id, status)` | LIFFホームでの3ブログ一覧 |
| `content_items(blog_id, primary_keyword)` | キーワード重複検出（制約5） |
| `content_items(blog_id, content_type)` | 収益記事の抽出と制約チェック |
| `approvals(user_id, status)` | 承認待ち一覧 |
| `article_versions(fact_check_status)` | FAILED の抽出（承認依頼に送らない） |
| `metrics_daily(metric_date)` | 日次バッチと集計 |
| `ai_usage_logs(user_id, created_at)` | 月間予算の判定 |
| `jobs(status, job_type)` | ワーカーのポーリング |

---

## 6. 追加テーブル（SPEC 5章に記載なし）

実装前に承認が必要。

### `planning_runs`

構成表生成の実行記録。STEP 1の判定、差し戻し回数、リスク承知での続行（SPEC 9.2.2）、再生成の回数、制約チェック結果を保存する。

**必要な理由：** SPEC 9.2.2で「リスクを理解して進める」の選択を記録すると定めているが、保存先が定義されていない。また再生成が3回で収束しない場合の原因分析ができない。`audit_logs` では構造化された制約結果を保持できない。

### `prompt_versions`

SPEC 6.2の `/admin/prompts`（バージョン・有効化・ロールバック）の永続化先。`article_versions.prompt_version` から参照する。

### `affiliate_links` / `link_clicks`

TASKS D-8の自前リダイレクタ。**OPEN_QUESTIONS Q-001 で方式が確定した**（2026-08-07）。案件ごとに `REDIRECT` / `DIRECT` を切り替え、**この2テーブルは `REDIRECT` の案件でのみ使う**。`DIRECT` の案件では行が作られない。切り替えの列は `affiliate_offers.link_mode`（D-9 で追加）。

### `search_console_connections`

TASKS G-1。ブログ単位のOAuthトークンを暗号化保存する。SPEC 11.3に「ブログ単位でOAuth連携」とあるが保存先が未定義。

### `admin_login_tokens`

TASKS B-10。管理者のワンタイムログインリンク（OPEN_QUESTIONS Q-012）。

**必要な理由：** SPEC 3.2 は管理者の認証を「Supabase Auth／メール＋ワンタイムリンク／ADMINロール制御のいずれか」としており、Q-012 で2つ目を選んだ。**リンクを1回だけ使えるようにするには、使用済みかどうかを保存する場所が要る。** 署名だけの自己完結トークンでは、期限内に何度でも使えてしまい、メールの転送や端末の紛失でそのまま入られる。

| 列 | 用途 |
|---|---|
| `token_hash` | **トークンのSHA-256。原文は保存しない。** DBが漏れてもリンクが使えないようにする |
| `expires_at` | 有効期限（15分程度） |
| `used_at` | 使用時刻。`NULL` のものだけが使える |
| `user_id` | `role = 'ADMIN'` の行にのみ発行する（判定はアプリ層・B-11） |

所有モジュールは `auth`。発行と検証は B-11 で実装する。

---

## 7. 暗号化対象

以下は AES-GCM で暗号化して保存し、復号キーは環境変数で管理する（SPEC 14.2）。

- `wordpress_connections.wp_username_encrypted`
- `wordpress_connections.app_password_encrypted`
- `search_console_connections.refresh_token_encrypted`

**`wordpress_connections.site_url` はモニターからは変更できない**（OPEN_QUESTIONS Q-007）。同一 `site_url` のままの認証情報の入れ替えは許可する。`disconnect` で `connection_status` を `REVOKED` にしても `site_url` は保持し、再接続時に一致を確認する。

**ADMIN は設定ミスの救済として `site_url` を変更できる。** 記事を投稿していないブログに限り、介入を `audit_logs` に残す（Q-008）。

**復号値をAPIレスポンス・ログ・エラートラッキングへ出力しない。** A-4のロガーで、これらのフィールド名を含むオブジェクトはマスクする。

---

## 8. 検証状況

本スキーマは構造チェック（リレーションの対応、`@@map` の重複、UUID型の付与）を通過している。

A-5 で CI に組み込み、A-8 でマイグレーション運用に切り替えた。以下を毎PRで実行している（`.github/workflows/ci.yml` の `schema` ジョブ）。

| 検証 | 状態 |
|---|---|
| `prisma validate` | ✅ 通過 |
| 初期マイグレーションのコミット（A-8） | ✅ `prisma/migrations/`。26テーブル・30 enum |
| 追加マイグレーション（B-10） | ✅ `admin_login_tokens`。**27テーブル**になった |
| 追加マイグレーション（D-9） | ✅ `affiliate_offers.link_mode` と `LinkMode`。**31 enum** になった |
| 追加マイグレーション（D-10） | ✅ `affiliate_offers.sub_id_param`。既定は `NULL`（サブIDを付けない） |
| 実PostgreSQLへの適用（`prisma migrate deploy`） | ✅ CIのサービスコンテナで実行 |
| スキーマとマイグレーションの乖離検出 | ✅ CIで実行 |

CI は `db push` ではなく **`migrate deploy`** で適用し、適用後のDBと `schema.prisma` を `migrate diff --exit-code` で比較する。スキーマだけ変えてマイグレーションを足し忘れると失敗する。

4章でDB側にも入れると定めたCHECK制約は Prisma のスキーマで表現できないため、マイグレーションに手で追記している。**現在4件**（`blogs_slot_range` / `content_items_outbound_max` / `admin_login_tokens_expiry_after_creation` / `admin_login_tokens_used_after_creation`）。CIで件数を確認し、実効性は統合テストで確かめている。

`prisma validate` は Prisma 6 系でのみ通る。Prisma 7 は `datasource` の `url` を廃止したため、本スキーマは通らない（OPEN_QUESTIONS Q-004）。

---

## 9. 変更手順

A-2完了後のスキーマ変更は必ずタスク化する。

1. `docs/OPEN_QUESTIONS.md` に変更理由を記載
2. スキーマ変更のタスクを起票（例：E-5-schema）
3. マイグレーションを単独のPRで適用
4. 本文書の該当節を更新

**機能実装のPRにマイグレーションを混ぜない。** ロールバックが困難になる。

---

## 10. 日時とタイムゾーン

### 保存形式

DBへの保存は全て `timestamptz`（内部的にUTC）とする。**ローカル時刻を文字列で保存しない。**

### 基準となるタイムゾーン

業務上の基準時刻は **JST（Asia/Tokyo）** とする。以下の判定は必ずJSTで行う。

| 判定 | 対象 |
|---|---|
| 1日の境界 | 日次集計、`metrics_daily.metric_date` |
| 1週の境界 | `content_items.planned_publish_week`、週4本の上限判定（SPEC 2.2） |
| 週次成果入力の対象期間 | G-5 の手動収益入力 |
| LINE通知の送信時刻 | `monitor_profiles.notification_time` |

UTCで日付を切ると、JSTの朝9時までに公開された記事が前日に計上される。集計と上限判定が1日ずれるため、**日付を切る処理は必ずJSTで行う。**

### 週の開始

**週の開始は月曜とする。** `planned_publish_week` の週番号も、週4本の上限判定の集計区間も、月曜始まりで揃える。

### 日付型のカラムはJSTの暦日として扱う

スキーマには時刻を持たない列がある。これらは**JSTの暦日／壁時計時刻**を表す。UTCの日付として書き込まない。

| 列 | 型 | 意味 |
|---|---|---|
| `metrics_daily.metric_date` | `date` | JSTの暦日。**ただし Search Console 由来の列は例外**（下記） |
| `content_items.planned_publish_date` | `date` | JSTの暦日 |
| `blogs.launch_date` | `date` | JSTの暦日 |
| `banners.starts_at` / `ends_at` | `date` | JSTの暦日 |
| `experiment_groups.start_date` / `end_date` | `date` | JSTの暦日 |
| `monitor_profiles.notification_time` | `time` | JSTの壁時計時刻 |

`timestamptz` の値からこれらを求めるときは、必ずJSTへ変換してから日付部分を取り出す。

### 外部APIとの変換

外部APIから受け取る日時は、基準タイムゾーンが異なる。**変換を明示し、取り込み口で一度だけ行う。**

変換処理は1箇所に集約し、各所で個別に変換しない。同じAPIのレスポンスを複数箇所で変換すると、片方だけ修正されて集計がずれる。

#### Search Console の日付は変換しない（OPEN_QUESTIONS Q-005）

**返ってきた日付をそのまま `metric_date` に入れる。**

**割り直しは原理的にできない。** Search Console が返すのは**時刻を持たない日付文字列**で、日単位に集計済みである。時間単位の内訳が無い以上、別のタイムゾーンの暦日へ再配分することはできない。「変換」は実際には「どの暦日に載せるかの取り決め」にすぎず、**根拠のある変換は存在しない。**

| 由来 | `metric_date` の意味 |
|---|---|
| Search Console（G-2・G-3） | **Search Console の暦日** |
| 手動収益入力（G-5） | JSTの暦日 |
| その他の日次集計 | JSTの暦日 |

**同じ `metric_date` の行でも、Search Console 由来の列とJST基準の列は最大1日ずれる。** G-7 で両者を並べる画面には、この注記を出す。

**ずれを許容してよい理由：** Phase 0 の目的は3ブログ×10名の比較（SPEC 1.2）であり、**系統的なずれは全ブログに等しくかかるため比較を歪めない**。8週間のトレンドを読むのに1日の位相差は影響しない。タイムゾーン列を足す案（Q-005 の (c)）は、マイグレーションと分岐を増やすわりに分析上の利得が無い。

**未検証の前提：** 本節はもともと「Search Console は日付がUTC基準で返る」としていたが、**この前提は確かめていない**（Google の集計は太平洋時間だという説明も見られる）。**G-1 で実際に接続したときに確認し、違っていればここを直す。** 決定の中身（そのまま入れる）は前提がどちらでも変わらない。

**`src/lib/datetime.ts` の `toJstDate(instant)` はここでは使わない。** あれは**瞬間**をJSTの暦日に変換するもので、日付文字列の割り直しには使えない（A-7 が意図的に提供しなかった機能）。

### 変換ヘルパーの置き場所

日時の変換・日付境界・週境界の計算は **`src/lib/datetime.ts` に集約する。**

**各モジュールで独自に日付計算を書かない。** `new Date()` からの手計算や、モジュールごとのオフセット加算を禁止する。夏時間を持たないJSTでも、月曜始まりの週境界と月跨ぎの扱いは実装ごとにずれる。

---

## 11. 記事本文の正本

利用者がWordPress側で記事を直接編集した場合の扱いを定める。

### 原則

**最後に更新されたものを正とする。**

ただし判定は「生成時刻の比較」ではなく、**「前回投稿以降にWordPress側で編集されたかどうか」** で行う。

**AIのリライトは常に後から実行される。** 単純な時刻比較では、AI側のタイムスタンプが必ず新しくなり、利用者の修正が必ず失われる。

### 判定手順

1. 同期時にWordPressから本文を取得し、ハッシュを算出する
2. `wordpress_posts.last_content_hash` と**一致する場合**
   - 未編集。AIによる更新を許可する
3. **一致しない場合**
   - 利用者が編集したものとして扱い、**WordPress側を正とする**
   - `wordpress_posts.user_edited_at` に検出時刻を記録する
   - リライトは、DBの記事バージョンではなく **WordPress側の本文を入力として** 生成する
   - **承認を経ずに上書きしてはならない**

### 承認の必須化

いずれの場合も、**公開済み記事の更新は承認を必須とする。** 未編集と判定された場合も例外としない。

### スキーマへの影響

`wordpress_posts` に以下を追加する。

| 列 | 型 | 制約 |
|---|---|---|
| `user_edited_at` | `timestamptz` | nullable |

**適用済み**（C-5-schema、2026-08-08）。9章の変更手順に従い、実装（C-5）とは別のPRで入れた。`NULL` は「利用者の編集を検出していない」を表す。
