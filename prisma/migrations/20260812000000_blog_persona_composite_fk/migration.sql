-- ブログと分身が同じモニターのものであることを、DBで強制する（A-2-R-2c-schema）。
--
-- ## なぜアプリ層で塞げないか
--
-- 依存の向きは **`personas → blogs`**（MODULE_RULES「現時点で想定している
-- 依存の向き」）。`blogs` から `personas` を import すると循環する。
-- つまり **`createBlogForUser` は、渡された `personaId` の持ち主を確かめられない。**
--
-- 「上位へ寄せる」（MODULE_RULES 3）で `src/app/` の Route Handler が
-- `requirePersonaForUser` を通してから渡す形にはできるが、
-- **確認を呼び出し側の作法に頼ることになる。** 経路が増えたときに
-- 抜けても、レビューでしか気づけない。
--
-- C-6・D-11 とまったく同じ形で、答えも同じ — **制約はDBに置く。**
-- どのモジュールから書いても迂回できない。
--
-- ## 既存行の移行は要らない
--
-- `blogs.persona_id` は A-2-R-1 で nullable として足したもので、
-- **まだ全行 NULL**（埋める経路は A-2-R-2c で入れる）。
--
-- PostgreSQL の複合外部キーは既定で MATCH SIMPLE であり、
-- **参照側の列が1つでも NULL なら検査しない。** よって
-- `persona_id` が NULL のあいだは何も起きず、値が入った行だけが
-- 「その分身は自分のものか」を問われる。
-- `user_id` は NOT NULL なので、片方だけ NULL にして検査を
-- すり抜ける余地は無い。

-- DropForeignKey
ALTER TABLE "blogs" DROP CONSTRAINT "blogs_persona_id_fkey";

-- CreateIndex（複合外部キーの参照先。`id` 単独でも一意なので制約としては冗長）
CREATE UNIQUE INDEX "personas_id_user_id_key" ON "personas"("id", "user_id");

-- AddForeignKey（**これが本題。** 他人の分身IDを紐づけられなくなる）
ALTER TABLE "blogs" ADD CONSTRAINT "blogs_persona_id_user_id_fkey" FOREIGN KEY ("persona_id", "user_id") REFERENCES "personas"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
