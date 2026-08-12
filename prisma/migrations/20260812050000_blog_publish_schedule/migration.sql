-- ブログごとの公開スケジュールとURL様式（TASKS C-9、作業指示書 W-8）。
--
-- ## なぜブログごとに散らすのか
--
-- **全ブログの投稿ジョブが同一時刻に集中しないこと**（完了条件）。
-- 理由は2つある。
--
-- 1. **同一運営者による大量サイトの痕跡を残さない**（W-8 の根拠）。
--    30ブログが毎週同じ曜日の同じ時刻に更新されると、外から並べたときに
--    同じ仕組みで動いていることが分かる
-- 2. ジョブが一斉に走ると、AIの呼び出しもWordPressへの投稿も同時に詰まる
--
-- `publish_jitter_min` は**実行時刻のゆらぎ**（分）。曜日と時刻を散らしても、
-- 同じ時刻を引いたブログ同士は重なるため、最後にもう一段ずらす。
--
-- ## パーマリンクを列挙型にする理由
--
-- 自由文字列にすると、`%postname%` の綴り違いのような打ち間違いが、
-- **実際のブログの設定と食い違ったまま残る。** 選べるのは4つ（W-8）。
--
-- **初回設定後に変更しない。** 変えるとURLが全部変わり、それまでの
-- 被リンクと評価が切れる。必要になったらリダイレクトを伴う別タスクで扱う。
--
-- ## 週の上限はここに足さない
--
-- W-8 は `weekly_post_cap` を挙げているが、**`blogs.article_ratio` の
-- `weeklyPublishCap` が既にある**（B-5・Q-011）。同じことを2か所に持つと、
-- どちらが正か分からなくなる。
--
-- **範囲（3〜5）への変更も、ここではしない。** いまは1〜4で、
-- SPEC 2.2 が「週4本を超えて公開する処理を実装してはならない」と定めている。
-- **仕様を実装タスクで書き換えない**（TASKS 0章）ので、範囲の変更は
-- SPEC の修正と G-8 に委ねる（OPEN_QUESTIONS Q-036）。
--
-- ## 既存行の埋め方と、まだ NOT NULL にしない理由
--
-- `publish_time` に**共通の既定値を置かない。** 散らすものに既定値を置くと、
-- **割り当てを忘れた行が「9時のブログ」として紛れる。**
--
-- 割り当てる処理はコード側（C-9）なので、ここでは nullable のまま足す。
-- 埋まったあとに `NOT NULL` にする（C-9-schema-2）。A-2-R で
-- 「足す → 移す → 消す」に分けたのと同じ形。
--
-- 既存行には `id` から決まる値を入れる — **ランダムにすると、同じ移行を
-- 2回流したときに別の値になる。**

-- CreateEnum
CREATE TYPE "PermalinkPattern" AS ENUM ('POSTNAME', 'CATEGORY_POSTNAME', 'BLOG_POSTNAME', 'ARCHIVES_POST_ID');

-- AlterTable（まず nullable で足す）
ALTER TABLE "blogs" ADD COLUMN     "initial_article_count" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "permalink_pattern" "PermalinkPattern" NOT NULL DEFAULT 'POSTNAME',
ADD COLUMN     "publish_jitter_min" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "publish_time" TIME(6),
ADD COLUMN     "publish_weekdays" INTEGER[];

-- 既存行を `id` から決まる値で埋める（**同じ移行を2回流しても同じ値**）
UPDATE "blogs"
   SET "publish_weekdays" = CASE (hashtext("id"::text) % 3 + 3) % 3
                              WHEN 0 THEN ARRAY[1, 4]
                              WHEN 1 THEN ARRAY[2, 5]
                              ELSE ARRAY[3, 6]
                            END,
       "publish_time" = (
         '09:00:00'::time + ((hashtext("id"::text || 'h') % 6 + 6) % 6) * interval '1 hour'
       ),
       "publish_jitter_min" = ((hashtext("id"::text || 'j') % 46 + 46) % 46),
       "initial_article_count" = 28 + ((hashtext("id"::text || 'n') % 7 + 7) % 7)
 WHERE "publish_time" IS NULL;

