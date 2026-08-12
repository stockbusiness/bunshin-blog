# BUNSHIN BLOG Phase 0 実装仕様書 v2.1

作成日：2026-08-06  

対象：Claude Code / Cloud Code 実装用  

プロジェクト種別：10名モニター・30ブログ運営実験  

プロダクト定義：個人アフィリエイター向け LINE承認型AI編集長

改訂：2026-08-06（v2.0 → v2.1）

改訂：**2026-08-12（v2.1 → v2.2）**。公開ペースの上限を週4本から**週3〜5本の範囲**へ改める（2.2・9.2.7。OPEN_QUESTIONS Q-036）。**インデックス率による調整（G-8）が上限を+1できるようにするため。** 既定は週4本のままで、**モニターが任意に設定できるのも3〜5本の範囲内に限る。**

v2.1の変更点：

1. 9.2に構成表ジェネレーター（STEP 1〜4・制約充足・再生成ループ）を新設し、以降の節番号を繰り下げ

2. 初期記事数を10本から30本へ変更、公開ペース上限（週4本）を基本方針に明記

3. 実験グループの管理UIとAPIを削除（記録は維持）

4. モニター投入を2名→5名→10名の段階投入へ変更

5. Phase 0のAI予算制御を停止から警告のみへ変更

6. 記事生成出力にアンサーカプセルを追加

7. 未確定事項のうち2件をPhase A着手前決定へ格上げ

8. content_itemsに内部リンク計画用のカラムを追加

---

## 0. 文書の目的

本書は、BUNSHIN BLOG Phase 0をClaude Code / Cloud Codeで段階的に実装するための、コンセプト・要件・データモデル・API・画面・処理・テスト・実装順序を統合した仕様書である。

実装者は、本書に記載されていない高度機能を独自判断で追加してはならない。  

不明点は暫定実装せず、`docs/OPEN_QUESTIONS.md`へ記録する。

---

# 1. プロダクト概要

## 1.1 コンセプト

BUNSHIN BLOGは、記事生成ツールではない。

> AIがブログ運営方針を考え、記事・改善案を作成し、利用者がLINEから確認・承認することで、複数ブログを継続運営できる「LINE承認型AI編集長」である。

日常操作では、利用者に管理画面を自主的に開かせない。

基本導線は以下とする。

```text

AIがブログ運営タスクを選定

↓

記事または改善案を生成

↓

LINEへ提案通知

↓

利用者がLIFFで確認

↓

承認・修正依頼・見送り

↓

WordPressへ下書き反映

↓

必要に応じて公開承認

↓

成果データを計測

↓

次回提案へ反映

```

## 1.2 Phase 0の目的

Phase 0では、以下を検証する。

1. LINE承認型でブログ運営を継続できるか

2. 1ユーザーが3ブログを同時運営できるか

3. AI生成記事が実用水準に達するか

4. どのジャンルが伸びやすいか

5. どの運営戦略が成果につながるか

6. 通常記事・収益記事・広告バナーの組み合わせが機能するか

7. AI費用と成果のバランスが成立するか

## 1.3 実験規模

- モニター：10名

- 1ユーザー当たりブログ：最大3件

- 最大ブログ数：30件

- 全ブログ：新規WordPress、0記事から開始

- 1ブログ当たり初期記事数：30記事（収益記事7本＋集客記事23本）

- 公開ペース：**既定は週4本、範囲は週3〜5本**（2.2。30本の公開完了までに約8週間）

- 投入方法：段階投入（第1段階2名 → 第2段階5名 → 第3段階10名）

- 検証期間：

  - 操作・継続性：8週間

  - 流入・収益：3〜6か月

- 対象：既存の個人アフィリエイター

## 1.4 Phase 0で作らないもの

- SNS自動投稿

- YouTube・動画生成

- メルマガ配信

- 一般公開課金

- Stripe決済

- 企業向け多段階承認

- ホワイトラベル

- ASP全社API統合

- 完全自動公開

- 高度な機械学習モデル

- 自動A/Bテスト

- WordPressサイト自動構築

- ドメイン取得代行

将来対応できる構造にはするが、Phase 0のUI・APIには出さない。

---

# 2. 基本方針

## 2.1 ブログ運用方針

原則として、記事10本のうち直接的な収益記事は1本程度とする。

```text

通常記事・体験・解説・Q&A：80〜90%

収益記事・比較・商品紹介：10〜20%

```

通常記事から、内部リンクで収益記事へ誘導する。

```text

通常記事

↓

比較・選び方記事

↓

収益記事

↓

アフィリエイト案件

```

## 2.2 公開ペースの上限

1ブログ当たりの公開は**週3〜5本の範囲**とする。**週5本を超えて公開する処理を実装してはならない。**

既定は週4本とし、**実測に基づく調整のみでこの範囲を動かす**（9.2.7・G-8）。モニターが任意に設定できるのもこの範囲内に限る。

30ブログが同時期に大量公開した場合、スケールされたコンテンツとして扱われる可能性がある。生成速度は本プロダクトの価値ではない。

**下限を3本としたのは、インデックス率が低いブログの公開を止めるためではない。** 更新が途切れたブログは評価が落ちるため、通常運転の下限として3本を置く。**インデックス率が著しく低い場合（50%未満）は0本にして管理者へ通知する**（G-8）。0本は通常の設定値ではなく、異常時の停止である。

初期30記事の公開順序は9.2.7に従う。

改訂履歴：**2026-08-12、上限を週4本から週3〜5本の範囲へ改める**（OPEN_QUESTIONS Q-036）。インデックス率による調整（G-8）が上限を+1できるようにするため。

## 2.3 収益源

Phase 0では以下を扱う。

1. アフィリエイトリンク

2. 広告バナー

3. 手入力による成果・収益記録

将来候補として、LINE登録、自社商品、問い合わせ、スポンサーを想定するが、Phase 0には含めない。

## 2.4 完全自動ではなく承認型

Phase 0では必ず利用者承認を挟む。

- AI生成直後の自動公開は禁止

- WordPress反映は原則`draft`

- 公開は設定により以下のいずれか

  - WordPress上で利用者が公開

  - LINE/LIFFで2回目の公開承認

- 初期モニター期間は、1回目承認だけで公開しない

## 2.5 3ブログの扱い

3ブログは単純に3倍生成する対象ではなく、1人の「ブログポートフォリオ」として扱う。

AIは3ブログを横断し、その日の優先タスクを選定する。

```text

ブログA：優先度 90／案件リンク切れ

ブログB：優先度 72／新規記事

ブログC：優先度 55／広告位置改善

→ 原則として上位1〜2件だけLINEへ通知

```

---

# 3. ユーザー種別と権限

## 3.1 ロール

### ADMIN

運営者。

- モニター管理

- 全ブログ管理

- AI生成確認

- 実験条件管理

- WordPress接続状態確認

- LINE配信確認

- エラー再実行

- プロンプトバージョン管理

- 成果比較

- 手動介入

### MONITOR

モニター利用者。

- 自分のアカウント管理

- 最大3ブログ登録

- WordPress接続

- ブログ設定

- 案件登録

- 広告バナー登録

- LINE通知設定

- 記事確認

- 承認・修正依頼・見送り

- 自分の成果確認

他ユーザーのデータには一切アクセスできない。

## 3.2 認証

### ユーザー側

- LINE Login / LIFFを利用

- LIFFから取得したIDトークンをサーバーで検証

- `line_user_id`を内部ユーザーに紐付ける

- クライアントが送信したユーザーIDを信用しない

### 管理者側

Phase 0では以下のいずれかを採用する。

推奨：

- Supabase Auth

- メール＋ワンタイムリンク

- ADMINロールによる制御

Basic認証のみの運用は廃止する。

---

# 4. システム構成

## 4.1 推奨技術スタック

```text

Frontend / BFF:

- Next.js

- TypeScript

- App Router

- Tailwind CSS

- LIFF SDK

Backend:

- Next.js Route Handlers または NestJS

- Phase 0ではNext.js統合構成を推奨

- 将来分離可能なモジュール構造にする

Database:

- PostgreSQL

- Supabase

- Prisma ORM

Queue / Jobs:

- Inngest、Trigger.dev、Supabase Edge Functions等

- Vercelリクエスト内で長時間AI生成を実行しない

AI:

- プロバイダー抽象化

- 初期はAnthropicまたはOpenAIを1社利用

- モデル名をコードに直書きしない

Integrations:

- WordPress REST API

- LINE Messaging API

- LIFF

- Google Search Console

- Google Analytics 4（後期）

```

## 4.2 モジュール

```text

src/

├─ modules/

│  ├─ auth/

│  ├─ users/

│  ├─ blogs/

│  ├─ wordpress/

│  ├─ personas/

│  ├─ affiliate/

│  ├─ banners/

│  ├─ experiments/

│  ├─ content-planning/

│  ├─ content-generation/

│  ├─ approvals/

│  ├─ line/

│  ├─ analytics/

│  ├─ ai-costs/

│  ├─ jobs/

│  └─ audit/

├─ app/

│  ├─ admin/

│  ├─ liff/

│  └─ api/

├─ lib/

└─ tests/

```

## 4.3 非同期処理

以下は必ずジョブ化する。

- 初期ブログ分析

- 構成案生成

- 記事生成

- 再生成

- WordPress投稿

- WordPress同期

- Search Console取得

- GA4取得

- 定期提案選定

- LINE通知送信

- リンク切れ確認

各ジョブは冪等性を持ち、同一処理の重複実行で二重投稿しない。

---

# 5. データモデル

## 5.1 users

```text

id                  uuid PK

role                enum ADMIN | MONITOR

display_name        text

email               text nullable

line_user_id        text unique nullable

status              enum INVITED | ACTIVE | PAUSED | WITHDRAWN

timezone            text default Asia/Tokyo

terms_accepted_at   timestamptz nullable

data_use_consent_at timestamptz nullable

created_at          timestamptz

updated_at          timestamptz

```

## 5.2 monitor_profiles

```text

id                  uuid PK

user_id             uuid unique FK

affiliate_experience_years integer nullable

monthly_goal_yen    integer nullable

primary_asp_names   text[]

notification_days   integer[]

notification_time   time

max_daily_proposals integer default 1

onboarding_status   enum NOT_STARTED | IN_PROGRESS | COMPLETED

created_at

updated_at

```

## 5.3 blogs

```text

id                  uuid PK

user_id             uuid FK

name                text

slug                text

genre_id            uuid FK

pen_name            text nullable

target_reader       text

purpose             enum AFFILIATE | DISPLAY_AD | MIXED

status              enum SETUP | ACTIVE | PAUSED | CLOSED

slot_number         integer 1..3

launch_date         date nullable

article_ratio       jsonb

experiment_group_id uuid nullable

created_at

updated_at

UNIQUE(user_id, slot_number)

CHECK(slot_number BETWEEN 1 AND 3)

```

## 5.4 wordpress_connections

```text

id                    uuid PK

blog_id               uuid unique FK

site_url              text

wp_username_encrypted text

app_password_encrypted text

api_base_url          text

connection_status     enum UNTESTED | CONNECTED | FAILED | REVOKED

can_create_posts      boolean

can_edit_posts        boolean

can_upload_media      boolean

last_tested_at        timestamptz

last_synced_at        timestamptz

last_error_code       text nullable

last_error_message    text nullable

created_at

updated_at

```

認証情報はAES-GCM等で暗号化し、復号キーは環境変数で管理する。  

APIレスポンス、ログ、エラートラッキングへ認証情報を出力しない。

## 5.5 genres

```text

id                  uuid PK

name                text

category            text

competition_level   enum HIGH | MEDIUM | LOW | UNKNOWN

ymyl_risk           enum HIGH | MEDIUM | LOW

notes               text

status              enum CANDIDATE | APPROVED | REJECTED

created_at

updated_at

```

## 5.6 personas

ユーザー共通人格とブログ別設定を分離する。

### user_personas

```text

id                uuid PK

user_id           uuid unique FK

base_profile      jsonb

tone              jsonb

values            jsonb

ng_expressions    text[]

created_at

updated_at

```

### blog_persona_settings

```text

id                  uuid PK

blog_id             uuid unique FK

pen_name            text

tone_override       jsonb

target_reader       jsonb

allowed_experiences uuid[]

ng_topics           text[]

writing_rules       jsonb

created_at

updated_at

```

## 5.7 persona_facts

本人の経験や意見を管理する。

```text

id                uuid PK

user_id           uuid FK

blog_id           uuid nullable FK

fact_type         enum EXPERIENCE | OPINION | PROFILE | FAILURE | PRODUCT_REVIEW

content           text

source            enum USER_INPUT | ADMIN_INTERVIEW | EXISTING_CONTENT | AI_INFERENCE

verification      enum VERIFIED | UNVERIFIED | REJECTED

usable_first_person boolean default false

created_at

updated_at

```

`AI_INFERENCE`かつ`UNVERIFIED`の情報は、一人称体験として記事へ使用しない。

## 5.8 affiliate_offers

```text

id                  uuid PK

blog_id             uuid FK

name                text

asp_name            text

advertiser_name     text nullable

landing_page_url    text

affiliate_url       text

reward_yen          integer nullable

conversion_type     enum FREE_SIGNUP | REQUEST | TRIAL | PURCHASE | OTHER

facts               jsonb

user_experience     enum USED | NOT_USED | UNKNOWN

user_rating         integer nullable

status              enum DRAFT | ACTIVE | PAUSED | ENDED | NEEDS_REVIEW

starts_at           date nullable

ends_at             date nullable

created_at

updated_at

```

## 5.9 banners

```text

id                  uuid PK

blog_id             uuid FK

name                text

image_url           text

destination_url     text

affiliate_offer_id  uuid nullable FK

slot                enum TOP | AFTER_FIRST_HEADING | MIDDLE | BOTTOM | SIDEBAR

target_categories   text[]

status              enum ACTIVE | PAUSED | ENDED

starts_at           timestamptz nullable

ends_at             timestamptz nullable

created_at

updated_at

```

## 5.10 experiment_groups

```text

id                  uuid PK

name                text

description         text

strategy_type       enum STANDARD | HIGH_VOLUME | HIGH_QUALITY | REVENUE_FOCUSED | CUSTOM

settings            jsonb

start_date          date

end_date            date nullable

created_at

updated_at

```

本テーブルへの登録・変更はADMINがSQLまたはシードで行う。管理UIは作らない（10.3参照）。

## 5.11 content_plans

```text

id                  uuid PK

blog_id             uuid FK

plan_type           enum INITIAL | MONTHLY | AD_HOC

version             integer

status              enum DRAFT | APPROVED | ACTIVE | ARCHIVED

strategy_snapshot   jsonb

generated_by_job_id uuid nullable

created_at

updated_at

```

## 5.12 content_items

記事企画を表す。

```text

id                    uuid PK

content_plan_id       uuid FK

blog_id               uuid FK

sequence_no           integer

content_type          enum INFORMATIONAL | EXPERIENCE | FAQ | COMPARISON | AFFILIATE

title                 text

primary_keyword       text nullable

search_intent         text

objective             enum TRAFFIC | TRUST | REVENUE | INTERNAL_LINK

affiliate_offer_id    uuid nullable

target_revenue_item_id uuid nullable

publish_priority      integer

planned_publish_date  date nullable

planned_publish_week  integer

inbound_link_item_ids uuid[]

outbound_link_item_ids uuid[]

status                enum PLANNED | GENERATING | READY_FOR_REVIEW | APPROVED | POSTED | PUBLISHED | REJECTED

created_at

updated_at

```

制約：

- 初期30記事の内訳は`AFFILIATE`7件、それ以外23件とする

- `outbound_link_item_ids`に指定できるのは`content_type = AFFILIATE`の記事のみ

- `content_type = AFFILIATE`の記事は`outbound_link_item_ids`を空とする

- `outbound_link_item_ids`の要素数は2以下

- `content_type = AFFILIATE`の記事は`inbound_link_item_ids`を3件以上持つ

- 同一ブログ内でキーワード重複を検出する

- 上記の判定手順は9.2.6に従う

## 5.13 article_versions

```text

id                    uuid PK

content_item_id       uuid FK

version_no            integer

title                 text

excerpt               text

body_html             text

faq_json              jsonb

structured_data_json  jsonb

fact_check_status     enum NOT_CHECKED | PASSED | WARNING | FAILED

risk_flags            jsonb

model_provider        text

model_name            text

prompt_version        text

input_tokens          integer

output_tokens         integer

estimated_cost_usd    numeric

content_hash          text

created_at

```

## 5.14 approvals

```text

id                  uuid PK

user_id             uuid FK

blog_id             uuid FK

content_item_id     uuid FK

article_version_id  uuid FK

status              enum PENDING | VIEWED | APPROVED | REVISION_REQUESTED | SKIPPED | EXPIRED

proposal_type       enum NEW_ARTICLE | REWRITE | TITLE | CTA | INTERNAL_LINK | BANNER

priority_score      integer

proposal_reason     text

sent_at             timestamptz nullable

viewed_at           timestamptz nullable

responded_at        timestamptz nullable

created_at

updated_at

```

## 5.15 revision_requests

```text

id                  uuid PK

approval_id         uuid FK

request_type        enum SHORTER | SOFTER | CHANGE_TITLE | CHANGE_PRODUCT | FACT_ERROR | FREE_TEXT

comment             text nullable

created_at

```

## 5.16 wordpress_posts

```text

id                  uuid PK

blog_id             uuid FK

content_item_id     uuid unique FK

wp_post_id          integer

wp_post_url         text nullable

wp_edit_url         text nullable

wp_status           enum DRAFT | PENDING | PUBLISH | TRASH

last_content_hash   text

posted_at           timestamptz

published_at        timestamptz nullable

last_synced_at      timestamptz nullable

created_at

updated_at

```

## 5.17 metrics_daily

```text

id                    uuid PK

blog_id               uuid FK

content_item_id       uuid nullable FK

metric_date            date

impressions            integer

search_clicks          integer

average_position       numeric nullable

page_views             integer nullable

affiliate_clicks       integer

banner_impressions     integer

banner_clicks          integer

conversions            integer

revenue_yen            integer

indexed                boolean nullable

created_at

updated_at

UNIQUE(blog_id, content_item_id, metric_date)

```

## 5.18 ai_usage_logs

```text

id                  uuid PK

user_id             uuid FK

blog_id             uuid nullable FK

content_item_id     uuid nullable FK

job_id              uuid nullable FK

provider            text

model               text

operation           text

input_tokens        integer

output_tokens       integer

cost_usd            numeric

created_at

```

## 5.19 jobs

```text

id                  uuid PK

job_type            text

user_id             uuid nullable

blog_id             uuid nullable

target_id           uuid nullable

status              enum QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELLED

attempt_count       integer

idempotency_key     text unique

input_json          jsonb

output_json         jsonb nullable

error_code          text nullable

error_message       text nullable

started_at          timestamptz nullable

completed_at        timestamptz nullable

created_at

updated_at

```

## 5.20 audit_logs

```text

id                  uuid PK

actor_user_id       uuid nullable

action              text

entity_type         text

entity_id           uuid nullable

metadata            jsonb

created_at

```

---

# 6. 主要画面

## 6.1 LIFFユーザー画面

### `/liff/home`

表示：

- 全3ブログの概要

- 承認待ち件数

- 今月公開数

- アフィリエイトクリック

- 広告クリック

- ブログ別状態

- 接続エラー

- 今日の優先提案

### `/liff/onboarding`

初期登録フロー。

1. LINE連携

2. 利用規約同意

3. データ利用同意

4. 目標登録

5. 1〜3ブログ枠作成

6. WordPress接続

7. ジャンル設定

8. ASP・案件登録

9. 通知曜日・時刻設定

10. 完了

### `/liff/blogs`

- ブログ一覧

- 追加

- 休止

- 切替

- 最大3件制御

### `/liff/blogs/[blogId]/wordpress`

- サイトURL

- WordPressユーザー名

- アプリケーションパスワード

- 接続テスト

- 接続状態

- 最終同期

- エラー

- 接続サポート依頼

### `/liff/blogs/[blogId]/settings`

- ブログ名

- ジャンル

- ペンネーム

- 想定読者

- 収益方針

- 投稿頻度

- 通知設定

- 新規記事・改善提案比率

### `/liff/blogs/[blogId]/offers`

- 案件一覧

- 案件追加

- 案件停止

- アフィリエイトURL

- LP URL

- 報酬

- 本人利用経験

- 商品評価

### `/liff/blogs/[blogId]/banners`

- バナー一覧

- 画像登録

- URL設定

- 表示位置

- 対象カテゴリー

- 有効期間

### `/liff/approvals`

- 承認待ち

- 承認済み

- 修正依頼

- 見送り

### `/liff/approvals/[approvalId]`

表示：

- ブログ名

- 提案種別

- 提案理由

- タイトル

- 記事全文

- 重要な変更点

- 使用する案件

- アフィリエイトURL

- バナー

- 未確認事実

- リスク警告

- AI生成情報

操作：

- 承認

- 修正依頼

- 見送り

- 後で確認

### `/liff/results`

- ブログ横断集計

- ブログ別集計

- 公開数

- 検索表示

- 検索クリック

- アフィリエイトクリック

- バナークリック

- 成果件数

- 収益

- AI費用

## 6.2 管理者Web画面

### `/admin/dashboard`

- モニター数

- ブログ数

- WordPress接続数

- 承認待ち

- AI生成エラー

- LINE送信エラー

- 1日・月間AIコスト

- 公開記事数

### `/admin/users`

- モニター一覧

- 招待

- 利用停止

- 3ブログ状態

- オンボーディング状況

- サポート依頼

### `/admin/blogs`

- 30ブログ一覧

- ジャンル

- 実験グループ

- 公開本数

- 流入

- 収益

- AI費用

- 接続状態

- エラー

### `/admin/content`

- 生成予定

- 生成中

- 承認待ち

- 公開済み

- 品質警告

- 手動確認

### `/admin/jobs`

- ジョブ一覧

- エラー詳細

- 再実行

- キャンセル

### `/admin/prompts`

- プロンプト一覧

- バージョン

- 有効化

- ロールバック

- テスト結果

### `/admin/analytics`

- ジャンル別

- 戦略別

- ユーザー別

- ブログ別

- 記事種別

- AI原価

- 収益

---

# 7. WordPress連携

## 7.1 接続方式

WordPress REST API＋アプリケーションパスワード。

## 7.2 接続テスト

接続時に以下を確認する。

1. URL形式

2. REST API到達

3. 認証成功

4. 投稿一覧取得

5. 下書き作成権限

6. 編集権限

7. メディア権限

8. テスト投稿は作成後に削除または下書き保持

## 7.3 投稿

初期モニター期間：

```json

{

  "status": "draft"

}

```

必須制御：

- `blog_id`を経由して接続情報を取得

- リクエストに任意の接続情報を直接渡させない

- `content_item_id`ごとの冪等性キー

- `wp_post_id`が存在する場合は新規投稿しない

- 再実行は既存下書き更新

- content hashが同一なら更新しない

- テナント越境を統合テストする

## 7.4 公開

Phase 0初期はWordPress上で公開する。

将来、LIFFから公開する場合は2段階承認とする。

---

# 8. LINE・LIFF連携

## 8.1 LINE公式アカウント

利用目的：

- 記事提案

- 修正完了通知

- WordPress反映通知

- エラー通知

- 簡単な質問

- 週次成果報告

## 8.2 通知フォーマット

```text

【ブログ名】

本日の提案：

新規記事を作成しました。

タイトル：

○○を始める前に知っておきたい5つのこと

目的：

通常記事から収益記事へ読者を誘導します。

確認時間：約3分

```

ボタン：

- 内容を確認

- 今回は見送る

詳細確認はLIFFへ遷移する。

## 8.3 通知数制御

- デフォルト：1日1件

- 最大：1日2件

- 3ブログ合計で制限

- 緊急通知は別枠

  - リンク切れ

  - 案件終了

  - WordPress接続切れ

同一提案を連続通知しない。

## 8.4 LINE返信

Phase 0では以下を扱う。

- 簡単な自由回答

- 商品の感想

- 初心者への助言

- 修正希望

返信内容は`persona_facts`または`revision_requests`へ保存する。

---

# 9. AI編集長

## 9.1 役割

AI編集長は以下を実行する。

1. ブログの目的とジャンルを理解

2. 案件と広告を理解

3. 記事構成を設計

4. 記事を生成

5. 事実を確認

6. リスクを判定

7. 3ブログ横断で優先順位を付ける

8. LINE提案文を作る

9. 承認・修正結果を保存する

10. 成果を次の提案へ反映する

## 9.2 構成表ジェネレーター

初期コンテンツ計画は、記事を個別に企画するのではなく、サイト全体の構成表を制約充足問題として生成する。

### 9.2.1 処理順序

```text

STEP 1  ジャンル審査（判定）

　↓ 通過

STEP 2  案件選定（スコア）

　↓ 60点以上が1件以上

STEP 3  収益記事の設計（案件から逆算）

　↓

STEP 4  集客記事とリンク設計

　↓

制約チェック → 不合格なら STEP 3-4 を再実行（最大3回）

　↓

公開順序の付与

```

STEP 2が完了するまでSTEP 3を実行してはならない。案件名が確定しないと収益記事のタイトルが生成できない。

### 9.2.2 STEP 1：ジャンル審査

停止条件（1つでも該当したら進めない）

- YMYL該当（医療・健康効果・投資・融資・保険・法律・就労）

- 該当ASPに案件が0件

- 検索上位10件のうち公式・大手比較サイトが8件以上

警告条件（進めるが利用者に明示する）

- 上位10件のうち個人ブログが2件以下

- 利用経験なし

- 案件が1件のみ

差し戻しは2回まで。3回目は「リスクを理解して進める」を選択可能とし、その選択を`audit_logs`へ記録する。

フォールバック：検索APIを利用しない場合、上位10件の判定はADMINが手動入力する。STEP 2〜4は影響を受けない。

### 9.2.3 STEP 2：案件選定

足切り（除外する案件）

- 掲載終了・提携終了

- `PURCHASE`かつ報酬3,000円未満

- `FREE_SIGNUP`でも報酬800円未満

- 否認条件が3つ以上

- LPがスマートフォン非対応

- ブログ掲載禁止

スコア（100点満点）

```text

成果地点の浅さ   30点  FREE_SIGNUP 30／REQUEST 20／TRIAL 15／PURCHASE 10

報酬額           20点  段階評価

LPの質           20点  フォーム項目5個以下=20／6〜10=10／11以上=0

検索需要         15点  商品名の検索有無

利用経験         10点  user_experience の値

否認条件の少なさ  5点  条件数の逆数

```

LP評価は自動化する。`landing_page_url`をHTMLで取得し、input要素数・ページ長・viewport指定の有無を機械判定する。取得は14.3のSSRF対策に従う。

採用は上位3件まで。60点以上が0件の場合はSTEP 1へ差し戻す。

### 9.2.4 STEP 3：収益記事の設計

- 記事数 ＝ 採用案件数 × 2 ＋ 1（比較記事）／上限10本

- 案件ごとに「口コミ・評判」「料金・解約」の2本

- 全体で「比較」1本

### 9.2.5 STEP 4：集客記事とリンク設計

- 記事数 ＝ 収益記事数 × 3（重複考慮で実数は23前後）

- 各収益記事へ流入する集客記事 3本以上

- 1つの集客記事がリンクする収益記事 2本以下

- 収益記事どうしはリンクしない

- キーワード重複禁止

必須バリデーション：`outbound_link_item_ids`および`target_revenue_item_id`に、`content_type`が`AFFILIATE`以外の記事を指定することを禁止する。手作業による検証では30本中9本でこの誤りが発生した。

必須の割り当てルール：「料金・解約」系の収益記事には、費用・補助金・相場系の集客記事を意図的に割り当てる。悩み系の集客記事は口コミ記事に偏るため、放置すると料金記事への流入が3本を下回る。

### 9.2.6 制約チェック

```text

記事総数              30

収益記事数            採用案件数 × 2 ＋ 1

各収益記事への流入    3本以上

1集客記事のリンク先   2本以下

キーワード重複        0

リンク先の記事種別    AFFILIATE のみ

```

不合格ならSTEP 3-4を再実行する。最大3回で収束しない場合はジョブを`FAILED`とし、ADMINへ通知する。暫定的な構成表を承認依頼へ送ってはならない。

### 9.2.7 公開順序

- 1〜2週目：収益記事を全本公開

- 3週目以降：集客記事をそのブログの週上限まで、収益記事に近いものから

- **週5本を超えて公開する処理を実装してはならない**

週上限の既定は4本、範囲は3〜5本（2.2）。実測に基づく調整はG-8が行う。

## 9.3 初期コンテンツ計画

各ブログの初期構成表は30記事とする。内訳は9.2の算出に従う。

標準構成（採用案件3件の場合）：

```text

収益記事（AFFILIATE）：7

　案件ごとの口コミ・評判：3

　案件ごとの料金・解約：3

　全体の比較記事：1

集客記事：23

　実体験・ノウハウ：8

　Q&A・悩み解決：6

　選び方・基礎解説：5

　独自情報・運営者記事：4

```

ジャンルによって集客記事の内訳は変更できるが、収益記事の本数は9.2.4の算出値を超えてはならない。

10記事のみでは検索順位が付かず、流入・収益の検証が成立しない。初期構成表は必ず30記事で生成する。

## 9.4 記事生成入力

- ブログ設定

- ブログ人格

- 本人確認済み体験

- 記事企画

- 使用案件

- 案件facts

- 同ブログの記事一覧

- 内部リンク計画

- 禁止表現

- プロンプトバージョン

## 9.5 記事生成出力

- タイトル

- 要約

- アンサーカプセル（H1直後に配置する結論。80〜120字。数値・条件・対象読者を明示し、曖昧表現を用いない）

- 本文HTML

- FAQ（見出しを疑問形にする。3〜5問）

- 構造化データ

- 内部リンク候補

- CTA

- バナー枠

- 使用した事実

- 未確認事実

- リスクフラグ

## 9.6 禁止事項

AIは以下を生成してはならない。

- 未確認の一人称体験

- 根拠のないランキング

- 架空の口コミ

- factsにない価格・条件

- 効果の断定

- 誇大表現

- PR表記の欠落

- 他ブログ人格の混入

- 他ユーザー案件の混入

- 医療・投資等の高リスク助言

## 9.7 事実チェック

単純な数値文字列照合だけではなく、記事内主張を抽出し、案件factsや本人情報と対応付ける。

結果：

```text

PASSED

WARNING

FAILED

```

`FAILED`は承認依頼へ送らない。  

`WARNING`はリスク表示付きで管理者確認を必須にできる。

## 9.8 モデルルーティング

低コストモデル：

- 分類

- 要約

- 通知文

- キーワード重複判定

- 事実主張抽出

標準モデル：

- 記事本文

- リライト

- 内部リンク

- CTA

高性能モデル：

- 重要な収益記事

- 品質チェック失敗

- 複雑な比較

- 月次戦略分析

モデル名・料金は設定テーブルまたは環境変数で管理する。

---

# 10. 実験管理

## 10.1 目的

30ブログを単に運営するのではなく、ジャンル・戦略・頻度・記事種別と成果の関係を計測する。

## 10.2 記録する条件

- ジャンル

- 競争レベル

- YMYLリスク

- 運営戦略

- 更新頻度

- 記事数

- 記事平均文字数

- 収益記事比率

- リライト数

- 内部リンク数

- バナー位置

- 承認率

- 修正率

- AI費用

- 検索表示

- 検索クリック

- 広告クリック

- アフィリエイトクリック

- 成果・収益

## 10.3 初期グループ例

実際のジャンル確定後に調整する。

```text

Group A：標準運用

Group B：少数高品質

Group C：更新頻度高め

```

注意：

30ブログでは統計的に強い断定はできない。  

Phase 0は傾向把握と次の仮説形成を目的とする。

このため実験グループの作成・割当・比較を行う管理UIは実装しない。条件の記録は行い、集計はSQLで実施する。

## 10.4 比較上の注意

ジャンルと戦略を同時に変えすぎると原因が分からないため、実験条件を固定して記録する。

---

# 11. 計測

## 11.1 短期KPI

- LINE通知成功率

- LIFF閲覧率

- 承認率

- 修正依頼率

- 見送り率

- 反応時間

- WordPress投稿成功率

- 1記事当たり確認時間

- 8週間継続率

## 11.2 中長期KPI

- インデックス率

- Search Console表示回数

- 検索クリック

- 平均順位

- PV

- アフィリエイトクリック

- バナーCTR

- 成果件数

- 収益

- AI原価

- ブログ別粗利益

## 11.3 Search Console

- ブログ単位でOAuth連携

- Search Analytics API

- URL Inspectionは別ジョブ

- 取得失敗時は再試行

- API上限を考慮

## 11.4 AI検索流入

GA4または独自クリック計測から取得する。

表記は「判別可能なAIサービス経由流入数」とする。  

referrerが欠落する場合があるため、完全値として扱わない。

## 11.5 収益

Phase 0では手入力を許可する。

- 発生件数

- 承認件数

- 報酬額

ASP API自動取得は後回し。

---

# 12. AI費用管理

## 12.1 必須記録

- ユーザー別

- ブログ別

- 記事別

- モデル別

- 処理別

- 入力トークン

- 出力トークン

- Web検索回数

- 再生成回数

- 月間AI費用

## 12.2 予算制御

- ユーザー月間上限

- ブログ月間上限

- 1記事再生成回数

- 高性能モデル利用回数

- 予算80%・100%・150%でADMINへ通知

Phase 0では予算超過時も生成を停止しない。検証期間中に停止するとデータが欠落し、Phase 0の目的を損なうためである。

停止機能および低価格モデルへの切替機能は実装するが、既定値を無効とし、ADMINが明示的に有効化する設定とする。

## 12.3 Phase 0目安

設計上の予算枠：

```text

1ユーザー・3ブログ：

月500〜1,500円程度を想定

10ユーザー：

月5,000〜15,000円程度を想定

```

上記は初期の仮置きである。実額は利用モデル、記事長、再生成数で変動するため、Phase A〜Fの実測値をもって改訂する。

---

# 13. API概要

## 13.1 LIFF認証

```text

POST /api/auth/liff

```

入力：

- ID token

処理：

- LINEサーバーで検証

- line_user_id取得

- 内部ユーザーへ紐付け

- セッション発行

## 13.2 ブログ

```text

GET    /api/blogs

POST   /api/blogs

GET    /api/blogs/:id

PATCH  /api/blogs/:id

DELETE /api/blogs/:id

```

制約：

- MONITORは自分のブログのみ

- 最大3件

- 削除は物理削除せずCLOSED

## 13.3 WordPress

```text

POST /api/blogs/:id/wordpress/connect

POST /api/blogs/:id/wordpress/test

POST /api/blogs/:id/wordpress/sync

DELETE /api/blogs/:id/wordpress/disconnect

```

## 13.4 案件

```text

GET    /api/blogs/:id/offers

POST   /api/blogs/:id/offers

PATCH  /api/offers/:offerId

DELETE /api/offers/:offerId

```

## 13.5 バナー

```text

GET    /api/blogs/:id/banners

POST   /api/blogs/:id/banners

PATCH  /api/banners/:bannerId

DELETE /api/banners/:bannerId

```

## 13.6 承認

```text

GET  /api/approvals

GET  /api/approvals/:id

POST /api/approvals/:id/view

POST /api/approvals/:id/approve

POST /api/approvals/:id/revision

POST /api/approvals/:id/skip

```

承認処理はトランザクションと冪等性を持たせる。

## 13.7 管理者

```text

GET  /api/admin/users

GET  /api/admin/blogs

GET  /api/admin/jobs

POST /api/admin/jobs/:id/retry

```

実験グループはADMINがSQLまたはシードで管理するため、APIは提供しない。

---

# 14. セキュリティ要件

## 14.1 テナント分離

すべてのMONITOR向けクエリで`user_id`所有権を検証する。

禁止：

```text

IDだけでblogを取得

IDだけでapprovalを取得

クライアント指定のuser_idを信用

```

必須：

```text

WHERE id = :id AND user_id = :sessionUserId

```

## 14.2 秘密情報

- WordPress認証情報は暗号化

- LINEチャネルシークレットは環境変数

- AI APIキーは環境変数

- Google OAuthトークンは暗号化

- ログへ秘密情報を出力しない

- クライアントへ秘密情報を返さない

## 14.3 LP・外部URL取得

SSRF対策：

- http/httpsのみ

- localhost禁止

- private IP禁止

- link-local禁止

- リダイレクト先再検証

- タイムアウト

- 最大レスポンスサイズ

- Content-Type確認

## 14.4 監査ログ

以下を記録：

- ログイン

- WordPress接続変更

- 案件URL変更

- 承認

- 公開

- 管理者介入

- ジョブ再実行

- AIプロンプト変更

---

# 15. テスト計画

## 15.1 単体テスト

- ブログ最大3件

- 所有権検証

- 記事比率

- キーワード重複

- 事実チェック

- 承認状態遷移

- 冪等性

- AI費用計算

## 15.2 統合テスト

### WordPress

- 2ユーザー・各2ブログ

- 別ユーザーサイトへ投稿されない

- draft投稿

- 再実行で二重投稿されない

- 認証失効エラー

### LINE

- 通知送信

- LIFF deep link

- 別ユーザーのapprovalを開けない

- 見送り

- 修正依頼

- 重複送信防止

### AI

- 分身混線なし

- 案件混線なし

- facts外数値の検知

- 収益記事比率

- PR表記

- 一人称体験制御

## 15.3 E2E

```text

管理者がモニター招待

↓

モニターがLIFF登録

↓

ブログ登録

↓

WordPress接続

↓

案件登録

↓

初期記事計画生成

↓

記事生成

↓

LINE通知

↓

LIFF確認

↓

承認

↓

WordPress下書き

↓

状態反映

```

## 15.4 負荷テスト

Phase 0最低条件：

- 10ユーザー

- 30ブログ

- 30件同時記事生成ジョブ

- 1日60件通知

- 月300〜600記事処理履歴

- ジョブ再実行時の重複なし

---

# 16. 受入基準

## 16.1 MVP開始条件

- 10ユーザー登録可能

- 1ユーザー3ブログ登録可能

- 30ブログWordPress接続可能

- LIFFログイン可能

- 記事企画生成可能

- 記事本文生成可能

- LINE通知可能

- LIFF承認可能

- WordPress下書き投稿可能

- 監査ログあり

- ブログ越境テスト合格

- AI原価記録可能

## 16.2 8週間検証の目標

- オンボーディング完了率：80%以上

- 8週間継続率：70%以上

- LINE提案反応率：70%以上

- 承認率：60%以上

- 重大な事実誤認：承認・公開前に100%検知

- WordPress投稿成功率：95%以上

- 1件の確認時間：平均5分以内

- AI費用：予算上限内

成果については、短期で断定せず3〜6か月追跡する。

---

# 17. 実装フェーズ

## Phase A：リポジトリ基盤

成果物：

- Next.js / TypeScript

- Prisma / PostgreSQL

- 認証基盤

- 共通エラーハンドリング

- ロガー

- テスト基盤

- CI

- `.env.example`

- `README.md`

- `docs/ARCHITECTURE.md`

- `docs/OPEN_QUESTIONS.md`

完了条件：

- lint

- typecheck

- unit test

- build

- migration

すべて成功。

## Phase B：ユーザー・LIFF・ブログ

実装：

- LINE Login

- LIFF初期化

- ユーザー登録

- 同意

- ブログ最大3件

- ブログ設定

- 管理者ユーザー一覧

完了条件：

- LIFFで本人識別

- 他ユーザーデータへアクセス不可

- 4件目登録拒否

## Phase C：WordPress

実装：

- 接続情報暗号化

- 接続テスト

- 下書き投稿

- 投稿更新

- 冪等性

- 接続状態表示

完了条件：

- 4サイト以上で接続確認

- 越境投稿なし

- 二重投稿なし

## Phase D：案件・バナー・分身

実装：

- 案件CRUD

- バナーCRUD

- user_persona

- blog_persona_settings

- persona_facts

- LINE回答保存

完了条件：

- ブログ別案件分離

- 未確認体験を記事に使用しない

## Phase E：コンテンツ計画・生成

実装：

- 構成表ジェネレーター（9.2のSTEP 1〜4）

- 制約チェックと再生成ループ

- 初期構成表30記事の生成

- 記事生成

- 事実チェック

- リスクフラグ

- AI費用ログ

- ジョブ管理

完了条件：

- 3ジャンル固定テストで構成表30記事が生成できる

- 9.2.6の制約チェックが全項目OKになる

- 再生成ループが3回以内で収束する

- リンク先にAFFILIATE以外の記事が混入しない

- 連続10記事で致命的な混線ゼロ

- facts外数値を検出

## Phase F：LINE承認

実装：

- 提案優先順位

- LINE通知

- LIFF承認画面

- 承認

- 修正依頼

- 見送り

- WordPress投稿ジョブ連携

完了条件：

- 通知→承認→下書き投稿がE2Eで成功

## Phase G：計測・分析

実装：

- KPI記録

- Search Console

- 手動収益入力

- AI原価比較

- 管理ダッシュボード

実験グループの作成・割当・比較を行うUIは実装しない。`experiment_groups`への登録はSQLまたはシードで行う。

完了条件：

- 10.2の記録条件が全て保存されている

- ジャンル別・戦略別・ブログ別の集計がSQLで取得できる

## Phase H：モニター運用準備

実装：

- 招待フロー

- オンボーディング

- エラー通知

- サポート依頼

- 操作マニュアル

- データ利用同意文

- 退会・停止処理

- バックアップ

完了条件（段階投入）：

```text

第1段階：2名（最大6ブログ）／4週間

　重大事故ゼロ

　オンボーディング完了

　承認→WordPress下書き投稿がE2Eで安定

第2段階：+3名（累計5名／最大15ブログ）／4週間

　AI費用が想定内

　修正率が第1段階より低下

第3段階：+5名（累計10名／最大30ブログ）

```

ドメイン取得時期も段階ごとに分散させる。30件の新規ドメインを同時期に立ち上げない。

---

# 18. Claude Code / Cloud Codeへの実装ルール

## 18.1 1タスク1PR

各Phaseをさらに小さなタスクへ分ける。

例：

```text

Phase B-1：LIFF認証

Phase B-2：ユーザー登録

Phase B-3：ブログCRUD

Phase B-4：最大3ブログ制約

```

一つのPRで複数Phaseをまとめない。

## 18.2 各PRに必要な内容

- 目的

- 実装内容

- 変更ファイル

- DB変更

- セキュリティ影響

- テスト内容

- 手動確認手順

- 未対応事項

- ロールバック方法

## 18.3 実装前の確認

Claude Codeは各タスク開始時に以下を実施する。

1. リポジトリ構造確認

2. 既存実装確認

3. 仕様との差分確認

4. 実装計画作成

5. 影響範囲確認

6. 変更開始

## 18.4 完了報告

各タスク完了時に以下を更新する。

```text

docs/IMPLEMENTATION_STATUS.md

docs/IMPLEMENTATION_HISTORY.md

docs/OPEN_QUESTIONS.md

```

## 18.5 禁止事項

- 型エラーを無視

- lint無効化

- テスト削除

- APIキー直書き

- モデル名直書き

- 秘密情報ログ出力

- 管理者権限でWordPress接続

- 自動公開

- テナント所有権検証の省略

- 仕様外機能の勝手な追加

- 失敗を成功扱いして完了報告

---

# 19. 初回Claude Code指示

以下を最初のタスクとして実行する。

```text

BUNSHIN BLOG Phase 0の開発基盤を構築してください。

参照仕様：

docs/BUNSHIN_BLOG_PHASE0_IMPLEMENTATION_SPEC_V2_1.md

今回の範囲：

Phase Aのみ

必須作業：

1. Next.js + TypeScriptの基盤を確認または作成

2. Prisma + PostgreSQL接続

3. 基本ディレクトリ構成

4. 環境変数バリデーション

5. 共通ロガー

6. 共通エラーレスポンス

7. Vitest等のテスト基盤

8. ESLint、typecheck、test、buildのCI

9. 初期Prisma schemaの設計

10. README、ARCHITECTURE、IMPLEMENTATION_STATUS、IMPLEMENTATION_HISTORY、OPEN_QUESTIONSを作成

制約：

- Phase B以降の機能は実装しない

- LINE、WordPress、AI APIの実通信はまだ行わない

- 外部サービスはinterfaceとstubまで

- 秘密情報をコミットしない

- lint/typecheck/test/buildをすべて成功させる

完了報告：

- 実装内容

- 変更ファイル

- 実行したテスト

- 残課題

- 次タスク案

```

---

# 20. 未確定事項

## 20.1 Phase A着手前に必ず決定する項目

以下2件は後決定にすると手戻りが発生するため、Phase A着手前に確定させる。

1. アフィリエイトリンクのリダイレクト方式

　自前リダイレクタを後から導入すると、公開済み記事のリンクを全て貼り替えることになる。クリック計測の根幹であり、Phase C着手前に確定が必要。

2. ドメイン・サーバー費用の負担者

　モニター募集条件そのものであり、決まらないと参加者を集められない。

## 20.2 該当Phase開始前に決定する項目

1. AIプロバイダーと初期モデル

2. ジャンル30件の割当

3. WordPressテーマとプラグイン標準

4. Search Console OAuthの管理方式

5. GA4必須化の有無

6. 広告クリックの計測方式

7. モニターへのデータ利用同意文

8. WordPress公開をLINE承認にする時期

9. モニターへ3ブログ同時開始を必須にするか

10. 画像の扱い

11. YMYLジャンルの除外基準

12. 月間AI予算上限

投稿頻度は2.2で確定済みのため、未確定事項から除外した（既定週4本・範囲3〜5本。2026-08-12改訂）。

未確定事項は推測実装せず、`docs/OPEN_QUESTIONS.md`へ記録する。

---

# 21. 最終定義

BUNSHIN BLOG Phase 0は、

> 10名の個人アフィリエイターが、1人最大3件・合計最大30件の新規WordPressブログを、LINE上の提案とLIFF上の承認によって運営する実験システムである。

AIは記事を生成するだけでなく、

- どのブログを優先するか

- 何を書くか

- どの収益記事へつなぐか

- どの広告を使うか

- どの運営戦略が成果につながるか

を記録・比較する。

Phase 0の最大成果は記事数ではなく、

> どのジャンル・運営戦略・記事構成が、継続・流入・クリック・収益につながるかを判断できるデータ基盤を構築すること

である。