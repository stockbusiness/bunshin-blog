-- LINEのリッチメニュー（Q-054、TASKS H-6）
--
-- **1行しか持たない。** リッチメニューは全モニター共通で、個別に
-- 出し分ける必要が Phase 0 に無い。`singleton` の一意制約＋CHECK で保つ。
--
-- **制約をアプリ側の書き方に依存させない**（`app_settings` と同じ）。
-- LINE が断る値を、そもそも保存できないようにする。

-- CreateEnum
CREATE TYPE "RichMenuCanvas" AS ENUM ('LARGE', 'COMPACT');

-- CreateTable
CREATE TABLE "rich_menus" (
    "id" UUID NOT NULL,
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "name" TEXT NOT NULL,
    "chat_bar_text" TEXT NOT NULL,
    "canvas" "RichMenuCanvas" NOT NULL DEFAULT 'LARGE',
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "areas" JSONB NOT NULL DEFAULT '[]',
    "image_data" BYTEA,
    "image_mime_type" TEXT,
    "image_width" INTEGER,
    "image_height" INTEGER,
    "line_rich_menu_id" TEXT,
    "applied_at" TIMESTAMPTZ(6),
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rich_menus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rich_menus_singleton_key" ON "rich_menus"("singleton");

-- AddForeignKey
ALTER TABLE "rich_menus" ADD CONSTRAINT "rich_menus_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- **1行だけ。** 一意制約と合わせて、2行目を入れられなくする
ALTER TABLE "rich_menus"
  ADD CONSTRAINT "rich_menus_singleton_true" CHECK ("singleton");

-- **LINE の上限をDBで持つ。** 14字を超えると LINE が断る
ALTER TABLE "rich_menus"
  ADD CONSTRAINT "rich_menus_chat_bar_text_length"
  CHECK (char_length("chat_bar_text") BETWEEN 1 AND 14);

ALTER TABLE "rich_menus"
  ADD CONSTRAINT "rich_menus_name_length"
  CHECK (char_length("name") BETWEEN 1 AND 300);

-- **画像は4列そろって入るか、そろって空か。**
-- 大きさだけ残って中身が無い、という状態を作らせない
ALTER TABLE "rich_menus"
  ADD CONSTRAINT "rich_menus_image_all_or_nothing"
  CHECK (
    ("image_data" IS NULL) = ("image_mime_type" IS NULL)
    AND ("image_data" IS NULL) = ("image_width" IS NULL)
    AND ("image_data" IS NULL) = ("image_height" IS NULL)
  );

-- **LINE の上限は1MB。** 超えるものを持たない
ALTER TABLE "rich_menus"
  ADD CONSTRAINT "rich_menus_image_size"
  CHECK ("image_data" IS NULL OR octet_length("image_data") <= 1048576);

ALTER TABLE "rich_menus"
  ADD CONSTRAINT "rich_menus_image_mime_type"
  CHECK ("image_mime_type" IS NULL OR "image_mime_type" IN ('image/png', 'image/jpeg'));

-- **「適用した」は2列そろって初めて成り立つ。**
-- 出ていないのに出ていることになっている、を防ぐ
ALTER TABLE "rich_menus"
  ADD CONSTRAINT "rich_menus_applied_all_or_nothing"
  CHECK (("line_rich_menu_id" IS NULL) = ("applied_at" IS NULL));

-- **押す場所は配列。** オブジェクトや文字列を入れさせない
ALTER TABLE "rich_menus"
  ADD CONSTRAINT "rich_menus_areas_is_array"
  CHECK (jsonb_typeof("areas") = 'array');
