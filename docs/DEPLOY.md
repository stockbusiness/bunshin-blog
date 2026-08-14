# デプロイ手順書

TASKS I-7。完了条件は「**実行先の設定・環境変数・cron・DB・`ENCRYPTION_KEY`
の作り方が文書化されている**」。

**実行先は Google Cloud Run**（Q-045・2026-08-14 に決定済み）。
DB・アプリ・cron のすべてが**同じ Google Cloud のプロジェクト**に入る。

この文書は**手順書**である。**上から順に実行できる形**で書く。

復旧は `docs/BACKUP.md`、日々の運用は `docs/MANUAL.md`。

---

## 0. 先に読むこと

### 0.1 鍵を先に作り、先に保管する

`ENCRYPTION_KEY` は **WordPress の認証情報と AI の APIキーを復号する鍵**
（SPEC 5.4・14.2）。

**作ってから保管するのではなく、保管先を決めてから作る。**
Cloud Run の環境変数だけに置くと、サービスを消したときに一緒に消える。

**この鍵は二度と変えられない。** 変えると保存済みの値を復号できず、
**全モニターに WordPress の再接続を頼むことになる**（`docs/BACKUP.md` 0章）。

### 0.2 順序を守る

**DB → マイグレーション → サービスの箱 → 環境変数 → デプロイ → cron → 管理者 → 管理画面の設定** の順。

**LINE・AI・メールの設定は最後**（3.3）。**LINE のチャネルは先に作らなくてよい** — LIFF のエンドポイントにはアプリの公開URLが要るので、**アプリが先**（Q-046）。

入れ替えると次のように失敗する。

| 誤った順序 | 何が起きるか |
|---|---|
| マイグレーションより先にデプロイ | 起動はするが、最初のリクエストで**テーブルが無い**と落ちる |
| **環境変数より先に本番の像を出す** | **コンテナが起動せずデプロイが失敗する**（`src/lib/env.ts`）。だから**仮の像で箱を先に作る**（4.3） |
| cron を先に有効化 | ジョブが空振りし続ける（害は無いが、失敗のログで本当の異常が埋もれる） |
| 管理者を先に作る | `users` テーブルがまだ無い |

---

## 1. 用意するもの

| | 何 | 備考 |
|---|---|---|
| 1 | **Google Cloud のプロジェクト（1つ）** | DB・アプリ・cron を全部ここに入れる（Q-045） |
| 2 | **Cloud SQL for PostgreSQL（東京）** | **提供元は決まっている**（Q-028）。2章 |
| 3 | **Cloud Run（東京）** | アプリ。4章 |
| 4 | LINE Developers のチャネル | Login と Messaging API の**2つ**（3.2） |
| 5 | Resend のアカウント | 管理者ログインのメール（B-11） |
| 6 | Anthropic の APIキー | 記事生成（E-3） |
| 7 | Google のサービスアカウント | Search Console（G-2）。**後からでよい** |

**Vercel は使わない**（Q-045）。接続元のIPが固定されないため、Cloud SQL の
**承認済みネットワークに実質 `0.0.0.0/0` を入れる**ことになり、
**DBの守りがパスワード1つだけ**になるため。Cloud Run は Cloud SQL Auth
Proxy で繋ぐので、**承認済みネットワークを空のままにできる**（2.2）。

---

## 2. データベース

### 2.1 作る

**Google Cloud SQL for PostgreSQL、東京リージョン（`asia-northeast1`）。**
**提供元は選び直さない**（Q-028・2026-08-11 に決定済み）。

**東京にしたのは速さではなく保管場所のため。** DBには `line_user_id` と
記事本文が入る（SPEC 14.2）。**提供元の乗り換えは `pg_dump` で済むが、
保管場所を国外から国内へ移すのは同意の取り直しになりうる**
（SPEC 6.1 のオンボーディング3）。**後から変えると高くつく選択がこれだけ。**

PostgreSQL **16**。データベース名は任意（例 `bunshin_blog`）。

**契約時に、次の3つが実際にその値になっていることを確かめる**（Q-028 の
「残る確認事項」。`docs/BACKUP.md` 2.1）。

| | 値 |
|---|---|
| 自動バックアップ | **7日以上** |
| PITR（ポイントインタイム リカバリ） | **有効。7日以上遡れること** |
| 取得時刻 | **JST 03:00〜04:00**（最も動きが少ない時間帯） |

**PITR が要るのは、誤った `UPDATE` を1回流しただけでその日の承認が
全部消えるのを防ぐため**（承認の記録は実験の一次データ・SPEC 1.2）。

### 2.2 承認済みネットワークを空にする

**守るのは「承認済みネットワーク」であって、パブリックIPの有無ではない。**

「接続」タブ:

| | 値 |
|---|---|
| **パブリックIP** | **有効**（チェックを入れる） |
| **承認済みネットワーク** | **空。1つも追加しない** |
| プライベートIP | **不要**（VPC の設定が要る。Phase 0 では使わない） |

**パブリックIPを外せない。** Cloud SQL は**どちらかのIPが必須**で、
両方外すと「接続タイプを選択してください」と言われて保存できない。

**承認済みネットワークが空なら、インターネットから直接は誰も繋がらない。**
Cloud SQL Auth Proxy は**この経路を通らない** — IAM の認証と一時証明書で
繋ぐ別の道で、**承認済みネットワークの設定を必要としない。**
Cloud Run の「Cloud SQL 接続」（4.3）もこれを使う。

つまり**パスワードを知っていても、IAM の権限が無ければ繋がらない。**

**`0.0.0.0/0` を入れない。** 入れた瞬間、DBの守りが**パスワード1つだけ**に
なる。中には `line_user_id`・記事本文・**暗号化した WordPress の
認証情報**がある（SPEC 14.2）。

**手元から `psql` や `prisma migrate deploy` を流すときも、
Cloud SQL Auth Proxy を自分の端末で動かす**（2.4）。
**自分のIPを承認済みネットワークへ入れる必要は無い。**

### 2.3 接続文字列の書き方

**アプリと手元とで書き方が違う。** 中身（利用者・パスワード・DB名）は同じ。

| どこから | `DATABASE_URL` |
|---|---|
| **Cloud Run** | `postgresql://<user>:<pass>@localhost/<db>?host=/cloudsql/<接続名>` |
| **手元**（Auth Proxy 経由） | `postgresql://<user>:<pass>@127.0.0.1:5432/<db>` |

`<接続名>` は Cloud SQL の画面にある `プロジェクトID:リージョン:インスタンス名`。

**`?host=` を付けるとホスト名は無視される。** `localhost` はソケット接続の
ための飾りで、実際の宛先は `/cloudsql/...` のソケット。

**アプリのコードは何も変わらない。** Prisma もアプリもソケットかTCPかを
知らない。

**接続プールはいま挟まない**（Q-028）。インスタンスが同時に何本も
立ち上がるため、利用者が増えると接続数を使い切るが、**30ブログでは
起きない。** 起きたら PgBouncer を挟む — **これは「足す」変更であって
「移す」変更ではない。**

将来プールを挟んだときは、**マイグレーションをプールを通さない直結の
接続文字列で流す**（プール経由だと通らない操作がある）。

### 2.4 マイグレーションを流す

**手元から Cloud SQL Auth Proxy を動かして流す。**

```sh
# 別の端末で proxy を上げておく
cloud-sql-proxy <プロジェクトID>:asia-northeast1:<インスタンス名>

# 流す
DATABASE_URL="postgresql://...@127.0.0.1:5432/bunshin_blog" npx prisma migrate deploy
```

**像の中で流さない**（4.1）。ビルドは何度も走るので、入れると
**その全部が本番DBを触る。**

**`prisma migrate dev` を本番へ向けない。** 開発用で、差分から新しい
マイグレーションを作ってしまう。

**`prisma migrate reset` は絶対に使わない。** 全テーブルを落とす。

### 2.5 流れたことを確かめる

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
| `DATABASE_URL` | 2.3（**Cloud Run 用の書き方**） |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32`（**0.1 を読んでから**） |

**`NODE_ENV` は像が `production` を持っている**（`Dockerfile`）。手で設定しない。

#### 起動は止めないが、無いと動かない機能がある

| 変数 | 無いとどうなるか |
|---|---|
| `APP_BASE_URL` | **管理者がログインできない**（メールのリンクを組み立てられない）。`https://` から始まる公開URL |
| `CRON_SECRET` | **ジョブワーカーが動かない**（fail closed）。`openssl rand -hex 32`。4.4 |

**`NEXT_PUBLIC_LIFF_ID` はここに置いても効かない。**
ブラウザ向けの値は**ビルド時にバンドルへ焼き付く**ので、
**Cloud Build の代入変数**として渡す（4.2）。
Cloud Run の環境変数に入れても LIFF画面は設定漏れの案内を出したままになる。

`RESEND_API_KEY` と `MAIL_FROM` は**環境変数でも管理画面でもよい。**
管理画面に置くなら、**先に環境変数で1回入れて管理者ログインを通す**
（入れ子になるため）。

### 3.2 LINE のチャネルは2つ要る

| チャネル | 使うもの | どこに入れるか |
|---|---|---|
| **LINE Login** | チャネルID | **管理画面**（`LINE_LOGIN_CHANNEL_ID`。Q-046） |
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
| LINE | `LINE_LOGIN_CHANNEL_ID` | **LIFF に誰もログインできない**（503 と専用のコードが返る・Q-046） |
| LINE | `LINE_CHANNEL_ACCESS_TOKEN` `LINE_CHANNEL_SECRET` `LIFF_BASE_URL` | **提案が届かない。Webhook が 401 になる** |
| SEARCH_CONSOLE | `GOOGLE_SERVICE_ACCOUNT_KEY` | 検索データが取れない（**後からでよい**） |

**秘密は保存後に読み出せない**（`ENCRYPTION_KEY` で暗号化される）。
画面は「設定済みか」だけを示す。

---

## 4. Cloud Run

### 4.1 像の置き場を作る

Artifact Registry に Docker のリポジトリを1つ。
**リージョンは `asia-northeast1`**、名前は `bunshin-blog`。

```sh
gcloud artifacts repositories create bunshin-blog \
  --repository-format=docker --location=asia-northeast1
```

ビルドの手順は `Dockerfile` にある。**編集しなくてよい。**

**マイグレーションは像に入っていない**（2.4 で手で流す）。ビルドは何度も
走るので、入れると**その全部が本番DBを触る**。

### 4.1b 最初の1回は手で像を作る

**トリガーを作る前に、手で1回通しておく。** GitHub の接続（OAuth）が
要らないので、**`Dockerfile` が通ることだけを先に確かめられる。**

```sh
gcloud builds submit --region=asia-northeast1 \
  --tag asia-northeast1-docker.pkg.dev/<プロジェクトID>/bunshin-blog/bunshin-blog:manual-1 .

gcloud run deploy bunshin-blog \
  --image=asia-northeast1-docker.pkg.dev/<プロジェクトID>/bunshin-blog/bunshin-blog:manual-1 \
  --region=asia-northeast1
```

**ビルドのサービスアカウントに権限が要る**（既定の Compute SA）。

| 権限 | 無いとどうなるか |
|---|---|
| `roles/logging.logWriter` | **ビルドが即座に失敗する**（ログを書けない） |
| `roles/artifactregistry.writer` | 像を置けない |
| `roles/run.admin` | Cloud Run へ出せない |
| `roles/iam.serviceAccountUser` | 同上 |

### 4.2 自動デプロイ（Cloud Build のトリガー）

**GitHub の `main` への push で、像を作って Cloud Run へ出す。**
設定は `cloudbuild.yaml` にある。**普段の作業は `main` にマージするだけ。**

トリガーを作るときに指定するもの:

| | 値 |
|---|---|
| リポジトリ | `stockbusiness/bunshin-blog` |
| ブランチ | `^main$` |
| 構成 | **Cloud Build 構成ファイル** → `cloudbuild.yaml` |
| 代入変数 `_NEXT_PUBLIC_LIFF_ID` | **LIFF ID**（3.1。ビルド時に焼き付く） |

**`_NEXT_PUBLIC_LIFF_ID` を入れ忘れると、LIFF画面が設定漏れの案内を
出したままになる。** Cloud Run の環境変数に入れても直らない
（ブラウザ向けの値はビルド時に決まる）。**入れ直したら再ビルドが要る。**

**Cloud Build のサービスアカウントに要る権限:** Artifact Registry への書き込み、
Cloud Run へのデプロイ（`roles/run.admin`）、
Cloud Run のサービスアカウントへの `roles/iam.serviceAccountUser`。

**`gcloud run deploy` には `--image` しか渡していない。**
環境変数・Cloud SQL の接続・リクエスト上限は**画面で設定したものが残る。**
（渡すようにすると、**画面で入れた秘密が毎回消える。**）

### 4.3 サービスの設定

**最初の1回だけ、仮の像でサービスを先に作る。**

`cloudbuild.yaml` は `--image` しか渡さない（4.2）。**サービスがまだ
無い状態で最初のビルドを走らせると、環境変数も Cloud SQL 接続も無いまま
本番の像が起動し、`src/lib/env.ts` が止めてデプロイが失敗する。**

```sh
gcloud run deploy bunshin-blog \
  --image=gcr.io/cloudrun/hello \
  --region=asia-northeast1 \
  --allow-unauthenticated
```

**仮の像は環境変数を読まないので、必ず起動する。**
このあと下の表と 3.1 の環境変数を画面で入れ、**それから**最初のビルドを
走らせる。以後のビルドは**像だけを差し替える**ので、入れた設定は残る。

| | 値 |
|---|---|
| リージョン | **`asia-northeast1`（東京）** — DBと同じ場所 |
| 認証 | **未認証の呼び出しを許可** — LINE Webhook・LIFF・公開ページが要る |
| Cloud SQL 接続 | 「接続」タブ → **作ったインスタンスを追加**（2.2） |
| リクエストの上限 | **300秒** — `DRAIN_BUDGET_MS`（50秒）より十分に長ければよい |
| 最小インスタンス | **0** — cron が毎分叩くので、実質は落ちない |
| 最大インスタンス | **2** で足りる（10名×3ブログ） |

**「Cloud SQL 接続」を追加して初めて `/cloudsql/<接続名>` が現れる。**
追加を忘れると、`DATABASE_URL` が正しくても**起動して最初のクエリで落ちる。**

**サービスアカウントに `roles/cloudsql.client` が要る。**
新しいプロジェクトでは**既定の Compute サービスアカウントに何も
付いていない。** 接続設定も `DATABASE_URL` も正しいのに繋がらない、
という形で出るので気づきにくい。

```sh
gcloud projects add-iam-policy-binding <プロジェクトID> \
  --member="serviceAccount:<プロジェクト番号>-compute@developer.gserviceaccount.com" \
  --role="roles/cloudsql.client"
```

**環境変数が欠けているとコンテナが起動しない**（`src/lib/env.ts`）。
Cloud Run は「コンテナが待ち受けを開始しませんでした」と出す。
**変数名はログに出る**（値は出さない）。

**まとめて入れるなら、秘密を画面に出さずに済む。**

```sh
umask 077 && cat > /tmp/env.yaml <<EOF
DATABASE_URL: "$URL"
SESSION_SECRET: "$S1"
ENCRYPTION_KEY: "$S2"
CRON_SECRET: "$S3"
APP_BASE_URL: "https://<公開URL>"
EOF
gcloud run services update <サービス名> --region=asia-northeast1 \
  --env-vars-file=/tmp/env.yaml \
  --add-cloudsql-instances=<接続名> \
  --timeout=300 --min-instances=0 --max-instances=2
rm -f /tmp/env.yaml
```

値は `read -s` で変数へ入れる。**画面にも履歴にも残らない。**

**`--env-vars-file` は全ての環境変数を置き換える。** 後から1つ足すときは
`--update-env-vars` を使う。ファイルで入れ直すと**前の分が消える。**

### 4.4 cron（Cloud Scheduler）

**ジョブを1つだけ作る。**

| | 値 |
|---|---|
| 頻度 | `* * * * *`（毎分） |
| タイムゾーン | 何でもよい（毎分なので） |
| 対象 | **HTTP** |
| URL | `https://<公開URL>/api/jobs/run` |
| メソッド | **GET** |
| ヘッダ | `Authorization` = `Bearer <CRON_SECRET>` |

**OIDC 認証を選ばない。** 選ぶと `Authorization` に Google の
トークンが入り、`CRON_SECRET` を載せる場所が無くなる。

**cron はこの1つだけ。** 間隔ごとに cron を増やさず、**間隔を冪等キーに
持たせて**ここから積む（I-1・I-2・G-8b）。

| 積まれるもの | 間隔 | 冪等キー |
|---|---|---|
| `DAILY_SCHEDULE` | 1日1回 | JSTの暦日 |
| `PROPOSAL_NOTIFY` | 1時間に1回 | JSTの暦日＋時 |
| `PUBLISH_PACE_REVIEW` | 2週間に1回 | 基準時刻からの回 |

**`CRON_SECRET` が未設定なら誰も起動できない**（fail closed）。
`/api/jobs/run` を叩いても 401 が返るだけで、アプリの他の機能は動く。

### 4.5 消化の締め切り

`/api/jobs/run` は `DRAIN_BUDGET_MS = 50秒` で**締め切りを持って抜ける。**
残ったジョブは次の起動で処理される。

**これは Cloud Run の上限ではなく、cron の間隔に合わせた値**（Q-045）。
**延ばすと消化が重なり、AI呼び出しが同時に何本も走る。** 延ばすときは
`LEASE_SECONDS`（600秒）と 4.3 のリクエスト上限がこれより十分に長いことを
確認する。

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
| 6 | LIFF が繋がっている | `/liff` が設定漏れの案内を出していない（`_NEXT_PUBLIC_LIFF_ID`・4.2） |

**4が最も見落としやすい。** `CRON_SECRET` が未設定でもアプリは正常に
見える（ジョブだけが動かない）。**画面には何も起きていないように見える。**

**1が通らないときは、まず Cloud Run のログを見る。**
起動しない原因はだいたい次の2つで、**どちらもログに出る**。

| ログ | 原因 |
|---|---|
| 環境変数の名前が並んでいる | 3.1 の設定漏れ |
| `/cloudsql/...` が見つからない | 4.3 の「Cloud SQL 接続」の追加漏れ |

---

## 7. 更新するとき

1. `main` にマージする（**Cloud Build が自動でデプロイする**・4.2）
2. **マイグレーションが増えていれば、デプロイの前に 2.4 を流す**

**戻すときは像を選び直す。** Cloud Run の「リビジョン」から前の版へ
トラフィックを戻す。**再ビルドは要らない。**

**列を落とすマイグレーションは、それを読むコードを消したデプロイの
後に流す**（DATA_MODEL 9章）。逆順にすると、動いている本番が無い列を
読みにいく。

**`ENCRYPTION_KEY` は変えない**（0.1）。

---

## 8. まだできていないこと

**いちばん大きいのは、AI・WordPress・LINE を一度も実物で呼んでいないこと。**
試験はすべて差し替えた相手に対するもので、**実物との最初の接触は本番になる。**

| | 状態 |
|---|---|
| 実AI・実WordPress・実LINEアプリでの確認 | **未実施。** 差し替えた相手としか話していない |
| 実ブラウザでの画面確認 | 未実施 |
| 実物のAIでの記事生成 | 未実施 |

### 済んだところ（2026-08-14）

**2〜4章は実際に実行して確かめた。** 食い違いはその場で直した。

| | |
|---|---|
| Cloud SQL の作成と `migrate deploy` | **27本すべて適用。** 2回目は `No pending migrations` |
| `Dockerfile` の実ビルド | **`STATUS: SUCCESS`**（Cloud Build・3分） |
| Cloud Run への配置と起動 | **起動した。** 環境変数が欠けていれば起動しない |

**この過程で直したもの：**

- **「パブリックIP を無効にする」は誤りだった。** Cloud SQL は
  どちらかのIPが必須。**守るのは承認済みネットワークが空であること**（2.2）
- **サービスの箱を先に作る手順が抜けていた。** `cloudbuild.yaml` は
  像だけを差し替えるので、箱が無いと最初のビルドが失敗する（4.3）
- **`LINE_LOGIN_CHANNEL_ID` が起動必須だった**（Q-046）。LIFF の
  エンドポイントにはアプリの公開URLが要るため、**LINE の設定は
  アプリを立てた後**にしかできない。鶏と卵になっていた
- **Cloud Run のサービスアカウントに `roles/cloudsql.client` が要る。**
  新しいプロジェクトでは既定で付いていない

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

**構成表の生成（`PLAN_GENERATION`）・E2E の通し試験・負荷試験は、
いずれも完了した**（I-10・I-5・I-6。2026-08-12）。
**見逃した事実誤認の記録先も用意した**（J-7。`/admin/fact-issues`）。

### 検証を始める前に決めておくこと

`docs/VALIDATION.md` 4章。**後から取り直せないもの。**

| | 状態 |
|---|---|
| `AI_PRICE_*` がすべて入っている | 3.3 |
| **「8週間継続率」の継続の定義**（Q-043） | **未決** |
| **「公開後に誤りを見つけたら `fact_issues` に入れる」運用の約束** | **未取り決め** |
