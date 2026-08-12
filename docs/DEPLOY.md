# デプロイ手順書

TASKS I-7。完了条件は「**Vercel の設定・環境変数・cron・DB・`ENCRYPTION_KEY`
の作り方が文書化されている**」。

この文書は**手順書**である。**上から順に実行できる形**で書く。

復旧は `docs/BACKUP.md`、日々の運用は `docs/MANUAL.md`。

---

## 0. 先に読むこと

### 0.1 鍵を先に作り、先に保管する

`ENCRYPTION_KEY` は **WordPress の認証情報と AI の APIキーを復号する鍵**
（SPEC 5.4・14.2）。

**作ってから保管するのではなく、保管先を決めてから作る。**
Vercel の環境変数だけに置くと、プロジェクトを消したときに一緒に消える。

**この鍵は二度と変えられない。** 変えると保存済みの値を復号できず、
**全モニターに WordPress の再接続を頼むことになる**（`docs/BACKUP.md` 0章）。

### 0.2 順序を守る

**DB → 環境変数 → マイグレーション → デプロイ → cron → 管理者** の順。

入れ替えると次のように失敗する。

| 誤った順序 | 何が起きるか |
|---|---|
| マイグレーションより先にデプロイ | 起動はするが、最初のリクエストで**テーブルが無い**と落ちる |
| cron を先に有効化 | ジョブが空振りし続ける（害は無いが、失敗のログで本当の異常が埋もれる） |
| 管理者を先に作る | `users` テーブルがまだ無い |

---

## 1. 用意するもの

| | 何 | 備考 |
|---|---|---|
| 1 | Vercel のアカウント（**Pro**） | 関数の実行時間の上限が要る（4章） |
| 2 | PostgreSQL 16 | Vercel Postgres / Neon / Supabase いずれでも可 |
| 3 | LINE Developers のチャネル | Login と Messaging API の**2つ**（3.2） |
| 4 | Resend のアカウント | 管理者ログインのメール（B-11） |
| 5 | Anthropic の APIキー | 記事生成（E-3） |
| 6 | Google のサービスアカウント | Search Console（G-2）。**後からでよい** |

---

## 2. データベース

### 2.1 作る

PostgreSQL **16**。データベース名は任意（例 `bunshin_blog`）。

接続文字列は `DATABASE_URL` の1つ。アプリと `prisma migrate deploy` の
両方がこれを読む。

接続プールを挟む場合（Vercel Postgres・Supabase の pgBouncer 等）、
**マイグレーションはプールを通さない直結の接続文字列で流す。**
プール経由だと `CREATE INDEX CONCURRENTLY` 等が通らないことがある。

### 2.2 マイグレーションを流す

```sh
DATABASE_URL="postgresql://..." npx prisma migrate deploy
```

**`prisma migrate dev` を本番へ向けない。** 開発用で、差分から新しい
マイグレーションを作ってしまう。

**`prisma migrate reset` は絶対に使わない。** 全テーブルを落とす。

### 2.3 流れたことを確かめる

```sh
DATABASE_URL="postgresql://..." npx prisma migrate status
```

`Database schema is up to date!` が出ること。

---

## 3. 秘密と設定

### 3.1 環境変数に置くもの

**アプリが動き出す前に要るものだけを環境変数に置く**（Q-017）。
残りは管理画面（3.3）。

#### 起動に必須（欠けると起動しない・`src/lib/env.ts`）

| 変数 | 作り方 |
|---|---|
| `DATABASE_URL` | 2.1 |
| `LINE_LOGIN_CHANNEL_ID` | LINE Developers → Login チャネル → チャネルID（数字のみ） |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32`（**0.1 を読んでから**） |

**`NODE_ENV` は Vercel が `production` を入れる。** 手で設定しない。

#### 起動は止めないが、無いと動かない機能がある

| 変数 | 無いとどうなるか |
|---|---|
| `APP_BASE_URL` | **管理者がログインできない**（メールのリンクを組み立てられない）。`https://` から始まる公開URL |
| `CRON_SECRET` | **ジョブワーカーが動かない**（fail closed）。`openssl rand -hex 32`。4.2 |
| `NEXT_PUBLIC_LIFF_ID` | LIFF画面が設定漏れの案内を出す。**ビルド時に焼き付く**ので、変えたら再デプロイが要る |

`RESEND_API_KEY` と `MAIL_FROM` は**環境変数でも管理画面でもよい。**
管理画面に置くなら、**先に環境変数で1回入れて管理者ログインを通す**
（入れ子になるため）。

### 3.2 LINE のチャネルは2つ要る

| チャネル | 使うもの | どこに入れるか |
|---|---|---|
| **LINE Login** | チャネルID | 環境変数 `LINE_LOGIN_CHANNEL_ID` |
| **Messaging API** | チャネルアクセストークン・チャネルシークレット | 管理画面（`LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET`） |

**Login のチャネルシークレットは使わない。** 署名の検証に使うのは
**Messaging API のほう**（D-7b）。取り違えると Webhook が全て 401 になる。

設定する先:

- **Webhook URL**: `https://<公開URL>/api/line/webhook`
- **LIFF エンドポイント**: `https://<公開URL>/liff`
- **応答メッセージ**: オフ（**Bot の自動応答を止める**。承認の文面と混ざる）
- **Webhook の利用**: オン

### 3.3 管理画面から入れるもの（H-7）

デプロイして管理者でログインしたあと、`/admin/settings` から入れる。
**ここに無い名前は保存できない**（管理画面が「環境変数を何でも書き換え
られる入口」にならないように）。

| 群 | 主な項目 | 無いとどうなるか |
|---|---|---|
| AI | `AI_PROVIDER` `ANTHROPIC_API_KEY` | **記事生成が動かない** |
| AI | `AI_PRICE_*` | 費用が計算されず、予算通知（E-15）が鳴らない。**入力と出力の両方**を入れる |
| AI | `AI_BUDGET_*` | 未設定なら通知しない。**Phase 0 は超過しても停止しない**（SPEC 12.2） |
| MAIL | `RESEND_API_KEY` `MAIL_FROM` `ADMIN_ALERT_EMAIL` | 管理者ログインと各種通知 |
| LINE | `LINE_CHANNEL_ACCESS_TOKEN` `LINE_CHANNEL_SECRET` `LIFF_BASE_URL` | **提案が届かない。Webhook が 401 になる** |
| SEARCH_CONSOLE | `GOOGLE_SERVICE_ACCOUNT_KEY` | 検索データが取れない（**後からでよい**） |

**秘密は保存後に読み出せない**（`ENCRYPTION_KEY` で暗号化される）。
画面は「設定済みか」だけを示す。

---

## 4. Vercel

### 4.1 プロジェクト

- **Framework Preset**: Next.js
- **Build Command**: 既定のまま（`next build`）
- **Node.js**: 22

**ビルドの前にマイグレーションを流さない。** ビルドは何度も走るので、
**プレビューのビルドが本番DBを触る**ことになる。2.2 を手で行う。

### 4.2 cron

`vercel.json` に定義済み。**編集しない。**

```json
{ "crons": [{ "path": "/api/jobs/run", "schedule": "* * * * *" }] }
```

**cron はこの1つだけ。** 間隔ごとに cron を増やさず、**間隔を冪等キーに
持たせて**ここから積む（I-1・I-2・G-8b）。

| 積まれるもの | 間隔 | 冪等キー |
|---|---|---|
| `DAILY_SCHEDULE` | 1日1回 | JSTの暦日 |
| `PROPOSAL_NOTIFY` | 1時間に1回 | JSTの暦日＋時 |
| `PUBLISH_PACE_REVIEW` | 2週間に1回 | 基準時刻からの回 |

**`CRON_SECRET` を環境変数に入れると、Vercel Cron が自動で
`Authorization: Bearer` を付ける。** 手で何かを設定する必要は無い。

**未設定なら誰も起動できない**（fail closed）。`/api/jobs/run` を叩いても
401 が返るだけで、アプリの他の機能は動く。

### 4.3 関数の実行時間

`/api/jobs/run` は `maxDuration = 60`（秒）で、**締め切りを持って抜ける。**
残ったジョブは次の起動で処理される。

**Hobby プランでは足りない。** 上限が短く、記事生成の途中で殺されて
実行結果が記録されない。**Pro が要る。**

延ばす場合は、`LEASE_SECONDS`（中断されたジョブを戻すまでの時間）が
これより十分に長いことを確認する。

### 4.4 リージョン

**東京（`hnd1`）を選ぶ。** DBと近い場所に置く。ジョブは1件ずつDBを
何度も往復するので、往復の遅れがそのまま実行時間になる。

---

## 5. 最初の管理者

**画面からは作れない。** 管理者ログインは
「`role = 'ADMIN'` の行が既にあるアドレス」にしかリンクを送らない
（B-11。MONITOR のアドレスに管理画面のリンクを送らないため）。

DBへ直接入れる。

```sql
INSERT INTO users (id, display_name, email, role, status, updated_at)
VALUES (
  gen_random_uuid(), '管理者', 'admin@example.com',
  'ADMIN', 'ACTIVE', CURRENT_TIMESTAMP
);
```

**`updated_at` を明示する。** Prisma の `@updatedAt` はアプリ側で
値を入れるもので、**DBには既定値が無い**（省くと NOT NULL 違反になる）。

**`line_user_id` は入れない。** 管理者は LINE を使わない。

そのあと `https://<公開URL>/admin/login` からメールでログインする。

---

## 6. 動いていることを確かめる

**上から順に。** 前が通らないと次は通らない。

| | 確かめること | どうやって |
|---|---|---|
| 1 | 起動している | `https://<公開URL>/` が開く |
| 2 | DBに繋がっている | `/admin/login` にメールを入れてリンクが届く |
| 3 | 設定が入っている | `/admin/settings` に「設定済み」が並ぶ |
| 4 | **ジョブが動いている** | `/admin/jobs` に `DAILY_SCHEDULE` が1日1件、`PROPOSAL_NOTIFY` が1時間に1件積まれている |
| 5 | LINE が繋がっている | Bot を友だち追加し、LINE Developers の Webhook 検証が 200 を返す |

**4が最も見落としやすい。** `CRON_SECRET` が未設定でもアプリは正常に
見える（ジョブだけが動かない）。**画面には何も起きていないように見える。**

---

## 7. 更新するとき

1. `main` にマージする（Vercel が自動でデプロイする）
2. **マイグレーションが増えていれば、デプロイの前に 2.2 を流す**

**列を落とすマイグレーションは、それを読むコードを消したデプロイの
後に流す**（DATA_MODEL 9章）。逆順にすると、動いている本番が無い列を
読みにいく。

**`ENCRYPTION_KEY` は変えない**（0.1）。

---

## 8. まだできていないこと

**この手順書は本番環境で実行して確かめていない。**
実行した結果と食い違ったら、**この文書のほうを直す。**

**いちばん大きいのは、AI・WordPress・LINE を一度も実物で呼んでいないこと。**
試験はすべて差し替えた相手に対するもので、**実物との最初の接触は本番になる。**

| | 状態 |
|---|---|
| 実AI・実WordPress・実LINEアプリでの確認 | **未実施。** 差し替えた相手としか話していない |
| 実ブラウザでの画面確認 | 未実施 |
| この手順書自体の実行 | 未実施 |

**10人へ配る前に、1人・1ブログで通しておくことを強く勧める。**
自分たちで WordPress を1つ立て、実AIで1本書かせ、実LINEに流し、
承認して投稿されるところまでを見る。**E2E の通し試験（I-5）では
代替できない** — 差し替えた相手は、こちらの想定どおりにしか答えない。

実際に出やすいのは、LINE のメッセージが実機で崩れる、WordPress の
REST API が特定のプラグインで 403 を返す、AI の応答が想定の JSON から
ずれる、といったもの。**どれも本番でしか出ない。**

### 実装として残っているもの

| | 状態 |
|---|---|
| `/api/admin/blogs`（SPEC 13.7） | 未実装 |
| 記事を作り直す経路（`ARTICLE_REGENERATION`） | 未実装（Q-042） |
| 見逃した事実誤認の記録先 | 未実装（Q-044。**検証開始前に要る**） |

**構成表の生成（`PLAN_GENERATION`）・E2E の通し試験・負荷試験は、
いずれも完了した**（I-10・I-5・I-6。2026-08-12）。
