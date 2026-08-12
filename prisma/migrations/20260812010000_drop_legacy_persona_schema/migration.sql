-- 人格中心モデルへの移行の最終段（A-2-R-3、Q-033 の「消す」）。
--
-- ## 順序
--
-- **コードは A-2-R-2f で外し終えている。** 逆順にすると Prisma クライアント
-- から `userPersona` が消えて typecheck と build が落ち、このPRが赤のまま
-- マージできない。
--
-- | 段階 | 内容 |
-- |---|---|
-- | A-2-R-1 | `personas` を足す（`blogs.persona_id` は nullable） |
-- | A-2-R-2a〜2f | 参照を移す |
-- | **A-2-R-3** | **旧いものを消す（本ファイル）** |
--
-- ## `blogs.persona_id` を NOT NULL にする
--
-- **NULL の行が1つでもあれば、このマイグレーションは失敗する。**
-- それが正しい振る舞いである — 分身の割り当てが無いブログに、
-- **推測で既定の分身を当てると、誰が書いた記事なのかが分からなくなる。**
--
-- 落ちた場合は、対象を調べて手で割り当ててから再実行する。
--
--   select id, name, slug, user_id from blogs where persona_id is null;
--
-- A-2-R-2c 以降に作られたブログは必ず分身を持つ（作成の入力で必須）。
--
-- ## `blog_persona_settings` は媒体別の上書きだけになる
--
-- | 列 | 移り先 |
-- |---|---|
-- | `target_reader` | `personas.audience`（A-2-R-2d）。**読者像は分身が持つ** |
-- | `allowed_experiences` | 無し（A-2-R-2e）。記憶は分身に溜まり、その分身の媒体は1件なので、選び直す対象が1組しかない |
--
-- ## `persona_facts` はまだ触らない
--
-- `user_id` / `blog_id` の削除と `persona_id` の NOT NULL 化は **A-2-R-4**。
-- 参照しているコードがまだ残っており、ここで落とすと typecheck が通らない。

-- DropForeignKey
ALTER TABLE "user_personas" DROP CONSTRAINT "user_personas_user_id_fkey";

-- AlterTable（媒体別の上書きだけを残す）
ALTER TABLE "blog_persona_settings" DROP COLUMN "allowed_experiences",
DROP COLUMN "target_reader";

-- AlterTable（**NULL があれば失敗する。** それが正しい）
ALTER TABLE "blogs" ALTER COLUMN "persona_id" SET NOT NULL;

-- DropTable
DROP TABLE "user_personas";
