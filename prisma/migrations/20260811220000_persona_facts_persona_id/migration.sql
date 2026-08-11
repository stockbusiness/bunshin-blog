-- 記憶の所属を人格へ移す準備（TASKS A-2-R-2）。
--
-- **足すだけ。** `user_id` と `blog_id` は残す。いま落とすと参照している
-- コードが一斉に壊れ、CIが赤のままになる（OPEN_QUESTIONS Q-033）。
-- 必須化と旧列の削除は A-2-R-3 で行う。
--
-- 記憶は媒体ではなく人格に溜まる。同じ分身が将来べつの媒体へ広がっても
-- 引き継げるようにするため。

ALTER TABLE "persona_facts" ADD COLUMN "persona_id" UUID;

-- 分身を消したら、その分身の記憶も消える（人格に属するため）
ALTER TABLE "persona_facts" ADD CONSTRAINT "persona_facts_persona_id_fkey"
    FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "persona_facts_persona_id_verification_idx"
    ON "persona_facts"("persona_id", "verification");
