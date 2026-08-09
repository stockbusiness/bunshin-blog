-- リンクの案件と記事が同じブログに属することを、DBで強制する（D-11、Q-020）。
--
-- ## なぜアプリ層で塞げないか
--
-- D-8 の時点で「`affiliate_links.content_item_id` が案件と同じブログの記事か
-- 確かめられない」と記録し、`content-planning` ができたら塞ぐとしていた。
-- E-7 で確かめたところ、**アプリ層では塞げない。**
--
-- `affiliate.ensureRedirectLinkForUser` から記事の持ち主を確かめるには
-- `affiliate → content-planning` の import が要るが、依存の向きは
-- **`content-planning → affiliate`**（MODULE_RULES）で循環する。
--
-- C-6 とまったく同じ形で、答えも同じ — **制約はDBに置く。** どのモジュールから
-- 書いても迂回できない。
--
-- ## `blog_id` は案件から埋める
--
-- 既存行は `affiliate_offers.blog_id` を写す。**リンクは必ず案件を持つ**
-- （`affiliate_offer_id` は NOT NULL）ので、埋まらない行は出ない。
--
-- ## 記事側を SET NULL から CASCADE へ変える
--
-- 複合外部キーの `ON DELETE SET NULL` は**参照している列を全て NULL にする**。
-- `blog_id` は NOT NULL なので成立しない（PostgreSQL 15 以降の列指定は
-- Prisma が表現できず、スキーマとの乖離になる）。
--
-- **実際の挙動は変わらない。** `content_items` が単独で消えることは無く、
-- 消えるのはブログごと削除されるときだけで、そのとき `affiliate_links` も
-- 案件経由で CASCADE で消える。

-- DropForeignKey
ALTER TABLE "affiliate_links" DROP CONSTRAINT "affiliate_links_affiliate_offer_id_fkey";

-- DropForeignKey
ALTER TABLE "affiliate_links" DROP CONSTRAINT "affiliate_links_content_item_id_fkey";

-- AlterTable（既存行は案件のブログで埋める）
ALTER TABLE "affiliate_links" ADD COLUMN "blog_id" UUID;

UPDATE "affiliate_links" AS l
   SET "blog_id" = o."blog_id"
  FROM "affiliate_offers" AS o
 WHERE o."id" = l."affiliate_offer_id";

ALTER TABLE "affiliate_links" ALTER COLUMN "blog_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "affiliate_links_blog_id_idx" ON "affiliate_links"("blog_id");

-- CreateIndex（複合外部キーの参照先。`id` 単独でも一意なので制約としては冗長）
CREATE UNIQUE INDEX "affiliate_offers_id_blog_id_key" ON "affiliate_offers"("id", "blog_id");

-- AddForeignKey
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_affiliate_offer_id_blog_id_fkey" FOREIGN KEY ("affiliate_offer_id", "blog_id") REFERENCES "affiliate_offers"("id", "blog_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey（**これが本題。** 他人の記事IDを紐づけられなくなる）
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_content_item_id_blog_id_fkey" FOREIGN KEY ("content_item_id", "blog_id") REFERENCES "content_items"("id", "blog_id") ON DELETE CASCADE ON UPDATE CASCADE;
