-- 投稿とその記事が同じブログに属することを、DBで強制する（C-6・SPEC 14.1）。
--
-- **C-6 のテナント越境テストで見つかった穴を塞ぐ。**
--
-- これまで `wordpress_posts` は `content_item_id` だけで `content_items` を
-- 参照していた。`blog_id` は別の外部キーで、両者が同じブログを指すという
-- 保証が無かった。
--
-- そのため、**他人の（まだ投稿されていない）`content_item_id` を、自分の
-- ブログの投稿として登録できた。** `content_item_id` は unique なので、
-- 一度登録されると本来の持ち主はその記事を二度と投稿できない
-- （所有権の判定は「既存行の `blog_id` が違う」で 404 になる）。
--
-- 実装側で確かめようとすると `wordpress` モジュールが `content_items` を
-- 直接読むことになり、MODULE_RULES 1（他モジュールのテーブルに直接
-- アクセスしない）に反する。**制約はDBに置くのが唯一の筋の通し方**で、
-- どのモジュールから書いても迂回できない。
--
-- `content_items(id, blog_id)` の unique は `id` が単独で一意なため制約と
-- しては冗長だが、複合外部キーの参照先に unique が要る。
-- `wordpress_posts(content_item_id, blog_id)` の unique も同じ理由
-- （Prisma が1対1関係の定義側に要求する）。

-- DropForeignKey
ALTER TABLE "wordpress_posts" DROP CONSTRAINT "wordpress_posts_content_item_id_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "content_items_id_blog_id_key" ON "content_items"("id", "blog_id");

-- CreateIndex
CREATE UNIQUE INDEX "wordpress_posts_content_item_id_blog_id_key" ON "wordpress_posts"("content_item_id", "blog_id");

-- AddForeignKey
ALTER TABLE "wordpress_posts" ADD CONSTRAINT "wordpress_posts_content_item_id_blog_id_fkey" FOREIGN KEY ("content_item_id", "blog_id") REFERENCES "content_items"("id", "blog_id") ON DELETE CASCADE ON UPDATE CASCADE;
