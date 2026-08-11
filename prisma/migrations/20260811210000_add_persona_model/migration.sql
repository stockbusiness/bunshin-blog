-- 人格中心モデルへの第一歩（TASKS A-2-R-1、ROADMAP 2章）。
--
-- **足すだけ。** `user_personas` は残し、`blogs.persona_id` は nullable で入れる。
-- いま必須にすると既存のブログ作成の全経路とテストが落ち、CIが赤のままになる
-- （OPEN_QUESTIONS Q-033）。必須化と旧モデルの削除は A-2-R-3 で行う。

CREATE TYPE "PersonaType" AS ENUM ('SELF', 'IDEAL', 'CHARACTER');
CREATE TYPE "PersonaStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

CREATE TABLE "personas" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "persona_type" "PersonaType" NOT NULL,
    "identity" JSONB NOT NULL,
    "expertise" JSONB NOT NULL,
    "audience" JSONB NOT NULL,
    "business" JSONB NOT NULL,
    "status" "PersonaStatus" NOT NULL DEFAULT 'DRAFT',
    -- 段階解放の起点（ROADMAP 5章）
    "activated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "personas_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "personas_user_id_status_idx" ON "personas"("user_id", "status");

ALTER TABLE "personas" ADD CONSTRAINT "personas_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- **Restrict。** 分身を消してもブログを道連れにしない
ALTER TABLE "blogs" ADD COLUMN "persona_id" UUID;

ALTER TABLE "blogs" ADD CONSTRAINT "blogs_persona_id_fkey"
    FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
