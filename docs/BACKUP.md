# バックアップと復旧

TASKS H-5。完了条件は「**日次バックアップと復旧手順が文書化されている**」。

この文書は**手順書**である。障害の最中に読むものとして書く。

---

## 0. 先に読むこと：鍵が無いと戻らないものがある

**データベースだけを戻しても、システムは元に戻らない。**

`ENCRYPTION_KEY`（AES-256-GCM）で暗号化して保存している列がある。
**鍵を失うと、DBが無傷でもこれらは二度と読めない。**

| テーブル | 列 | 失うと何が起きるか |
|---|---|---|
| `wordpress_connections` | `wp_username_encrypted` / `app_password_encrypted` | **全モニターのWordPressへ投稿できなくなる。** 再接続には各モニターにアプリパスワードを再発行してもらう必要がある |
| `search_console_connections` | `refresh_token_encrypted` | Search Console の再連携（OAuth）をやり直す |
| `app_settings` | `value_encrypted` | AIのAPIキー等を入れ直す（管理画面から可能） |

**`ENCRYPTION_KEY` はDBのバックアップとは別の場所に、別の手段で保管する。**
同じ場所に置くと、その場所を失ったときに両方が消える。

**鍵を変えてはならない。** 変えると保存済みの値を復号できなくなる
（`src/lib/env.ts` の注記と同じ）。鍵の入れ替えが必要になった場合は、
**再暗号化の手順を別に用意してから**行う（未実装）。

---

## 1. 守る対象

### 1.1 データベース

PostgreSQL 16。**これが本体。** すべての業務データが入る。

### 1.2 秘密（環境変数）

| 変数 | 失ったときの影響 |
|---|---|
| `ENCRYPTION_KEY` | **上記のとおり致命的。** 最優先で別途保管 |
| `SESSION_SECRET` | 全員がログアウトする。作り直せる（`openssl rand -base64 32`） |
| `DATABASE_URL` | 接続先。復旧先に合わせて書き換える |
| `LINE_LOGIN_CHANNEL_ID` | LINEの管理画面から再取得できる |

`app_settings` に入る値（AIのAPIキー、LINEのチャネルアクセストークン、
Resend のAPIキー）は**DBの中**にあるので、DBのバックアップに含まれる。
ただし復号には `ENCRYPTION_KEY` が要る。

### 1.3 守らないもの

- **アプリケーションのコード。** Git にある
- **WordPress の中身。** モニター自身のサイトで、こちらの管理外
  （SPEC 1.2「ブログはモニター自身のドメインで動く」）

---

## 2. 日次バックアップ

### 2.1 マネージドの自動バックアップ

**データベースの提供元が持つ自動バックアップを有効にし、それを一次手段とする。**
Phase 0 の運用先は未確定（Q-028）。決まり次第ここに、

- 保持期間の設定値
- ポイントインタイムリカバリの可否と遡れる範囲
- スナップショットの取得時刻（**JSTで何時か**）

を書き足す。

### 2.2 自前のダンプ（提供元に依存しない控え）

マネージドのバックアップは**提供元のアカウントを失うと一緒に消える。**
週1回でよいので、別の場所へ置いた控えを持つ。

```bash
# 取得（カスタム形式。並列復元ができる）
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="bunshin-$(TZ=Asia/Tokyo date +%Y%m%d-%H%M).dump" \
  "$DATABASE_URL"
```

**`--no-owner --no-privileges` を付ける。** 復旧先のロール名が違っても
そのまま入る。障害の最中にロールを作り直す作業を増やさない。

**取得したファイルは暗号化して保管する。** 中身には利用者の
`line_user_id` と記事の本文が入る（SPEC 14.2）。

```bash
# 例：GPGで暗号化してから保管先へ置く
gpg --symmetric --cipher-algo AES256 "bunshin-YYYYMMDD-HHMM.dump"
```

### 2.3 保持期間

| 種類 | 保持 | 理由 |
|---|---|---|
| マネージドの日次 | 7日以上 | 「先週おかしくなった」に戻れる |
| 自前の週次ダンプ | 30日以上 | Phase 0 は約3か月（SPEC 1.2）。実験期間中の任意の週へ戻せる |

**実験の終了後もダンプを1つ残す。** 結果の検証（G-7）をやり直せるようにする。
残す期間はデータ利用の同意（SPEC 6.1 のオンボーディング3）の範囲を超えない。

---

## 3. 復旧手順

### 3.1 判断：どこまで戻すか

| 状況 | 手段 |
|---|---|
| 誤った `UPDATE` / `DELETE` を1回流した | **ポイントインタイムリカバリ**で直前へ |
| DBが壊れた・消えた | 直近のスナップショット、無ければ自前のダンプ |
| マイグレーションの適用に失敗した | 3.4 |

**戻す前に、今のDBのダンプを取る。** 壊れていても、戻した結果が
思っていたものと違ったときに比べる材料になる。

### 3.2 全体を戻す

```bash
# 1) 空のデータベースを用意する
createdb bunshin_restore

# 2) 戻す（並列で速くする）
pg_restore \
  --dbname="postgresql://.../bunshin_restore" \
  --no-owner \
  --no-privileges \
  --jobs=4 \
  bunshin-YYYYMMDD-HHMM.dump

# 3) 行数を確かめる（**主要なテーブルが空でないこと**）
psql "postgresql://.../bunshin_restore" -c "
  select 'users' as t, count(*) from users
  union all select 'blogs', count(*) from blogs
  union all select 'content_items', count(*) from content_items
  union all select 'article_versions', count(*) from article_versions
  union all select 'approvals', count(*) from approvals;"
```

### 3.3 アプリを繋ぎ替える

1. `DATABASE_URL` を復旧先へ向ける
2. **`ENCRYPTION_KEY` が復旧したデータと同じものであることを確かめる**（0章）
3. マイグレーションの状態を確かめる

```bash
npx prisma migrate status
```

4. **復号できることを確かめる。** WordPress の接続テスト（C-2）を
   1ブログで実行する。ここが通れば鍵が合っている

### 3.4 マイグレーションで失敗したとき

**`prisma migrate reset` を使わない。** 全データが消える。

失敗した1件を戻すSQLを書き、`_prisma_migrations` の該当行を削除してから
`prisma migrate deploy` をやり直す。**本番で直接やらず、復旧先で試してから**行う。

### 3.5 ジョブの扱い

復旧すると、`RUNNING` のまま止まったジョブが残ることがある。

```sql
-- **`QUEUED` へ戻す。** ジョブは冪等（C-4）なので、やり直しても二重に起きない
update jobs set status = 'QUEUED' where status = 'RUNNING';
```

`WORDPRESS_POST` は `wordpress_posts` を見て二重投稿しない（C-4・F-7）。
`ARTICLE_GENERATION` はやり直すとAI費用がかかる（E-14 に記録される）。

---

## 4. 復旧できることを確かめる

**一度も戻したことのないバックアップは、バックアップではない。**

**実験の開始前に1回、開始後は月1回**、次を行う。

1. 直近のダンプを別のデータベースへ復元する（3.2）
2. 行数を確かめる（3.2 の3）
3. `prisma migrate status` が最新であることを確かめる
4. **WordPress の接続テストを1件通す**（鍵が合っていることの確認）
5. 復元先を破棄する

**結果を `docs/IMPLEMENTATION_HISTORY.md` に日付とともに残す。**
「やったつもり」を防ぐ。

---

## 5. 未決事項

- **運用先のデータベースが未確定**（Q-028）。2.1 は決まり次第書き足す
- **鍵の入れ替え手順が無い。** `ENCRYPTION_KEY` を変える必要が生じた場合の
  再暗号化は未実装
- **自動での復旧確認は無い。** 4章は手作業
