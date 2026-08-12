-- 記憶の所属を分身へ移し切る（A-2-R-4-schema）。
--
-- **記憶は媒体ではなく人格に溜まる。** 同じ分身が将来べつの媒体
-- （SNS・動画）へ広がっても引き継げるようにする。
--
-- ## 順序
--
-- **コードは A-2-R-4 で外し終えている。** 取得・作成・更新・削除はすべて
-- `persona_id` を基準にし、所有は `persona.user_id` を辿って確かめている。
-- 逆順にすると typecheck が落ち、このPRが赤のままマージできない
-- （A-2-R-2f → A-2-R-3 と同じ）。
--
-- ## `persona_id` を NOT NULL にする
--
-- **NULL の行が1つでもあれば失敗する。** それが正しい振る舞いで、
-- **どの分身の記憶か分からない行を、推測で誰かに割り当てない。**
--
-- 落ちた場合は、対象を調べて手で割り当ててから再実行する。
--
--   select id, user_id, blog_id, left(content, 40) from persona_facts
--    where persona_id is null;
--
-- A-2-R-4 以降に作られた行は必ず分身を持つ（作成の入力で必須）。
--
-- ## `user_id` と `blog_id` を落とす
--
-- | 列 | 代わり |
-- |---|---|
-- | `user_id` | `persona.user_id`（所有の確認は分身を辿る） |
-- | `blog_id` | 無し。**「ブログ固有」と「全ブログ共通」を分けるのをやめた**（A-2-R-4） |
--
-- `persona_facts_user_id_verification_idx` も落とす。**この列で絞らなくなった
-- ので、索引を残しても書き込みが遅くなるだけ。** 所有つきの取得は
-- `persona_facts_persona_id_verification_idx` と `personas(user_id)` で足りる。

-- DropForeignKey
ALTER TABLE "persona_facts" DROP CONSTRAINT "persona_facts_blog_id_fkey";

-- DropForeignKey
ALTER TABLE "persona_facts" DROP CONSTRAINT "persona_facts_user_id_fkey";

-- DropIndex
DROP INDEX "persona_facts_blog_id_idx";

-- DropIndex
DROP INDEX "persona_facts_user_id_verification_idx";

-- AlterTable（**NULL があれば失敗する。** それが正しい）
ALTER TABLE "persona_facts" DROP COLUMN "blog_id",
DROP COLUMN "user_id",
ALTER COLUMN "persona_id" SET NOT NULL;
