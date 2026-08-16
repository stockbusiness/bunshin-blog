-- 運営が用意する案件の元（Q-055、段8）
--
-- **「案件を決めるのが大変」**と実地で言われた。30ブログが同じ案件を
-- 別々に調べるより、**運営が1回調べて配る**ほうが正確で速い。
--
-- **事実の出どころを1つにする。** 同じ商品が複数ブログにあると、
-- 片方だけ古い価格が残り、それが「確かめ済み」として記事に出る（SPEC 9.6）。
-- ここを元にして、古いままのブログへ「確かめてください」と出す。
-- **勝手に書き換えない** — 確かめるのは人（D-13・Q-022）。

-- CreateEnum
CREATE TYPE "OfferCatalogStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');

-- CreateTable
CREATE TABLE "offer_catalog_items" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "asp_name" TEXT NOT NULL,
    "advertiser_name" TEXT,
    "landing_page_url" TEXT NOT NULL,
    "reward_yen" INTEGER,
    "conversion_type" "ConversionType" NOT NULL,
    "facts" JSONB NOT NULL DEFAULT '[]',
    "facts_updated_at" TIMESTAMPTZ(6),
    "deny_conditions" TEXT[],
    "link_mode" "LinkMode" NOT NULL DEFAULT 'DIRECT',
    "sub_id_param" TEXT,
    "blog_posting_prohibited" BOOLEAN NOT NULL DEFAULT false,
    "lp_form_fields" INTEGER,
    "lp_mobile_ready" BOOLEAN,
    "genre_hints" TEXT[],
    "notes" TEXT,
    "status" "OfferCatalogStatus" NOT NULL DEFAULT 'DRAFT',
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offer_catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offer_catalog_items_status_idx" ON "offer_catalog_items"("status");

-- **同じものを二度登録しない。** ASPと紹介先が同じなら同じ案件
CREATE UNIQUE INDEX "offer_catalog_items_asp_name_landing_page_url_key" ON "offer_catalog_items"("asp_name", "landing_page_url");

-- AlterTable
-- **手で入れた案件は NULL のまま。** 元が消えても案件は残す（SET NULL）
ALTER TABLE "affiliate_offers" ADD COLUMN     "catalog_item_id" UUID;

-- AddForeignKey
ALTER TABLE "affiliate_offers" ADD CONSTRAINT "affiliate_offers_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "offer_catalog_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_catalog_items" ADD CONSTRAINT "offer_catalog_items_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- **`facts` は配列。** オブジェクトや文字列を入れさせない（`rich_menus` と同じ）
ALTER TABLE "offer_catalog_items"
  ADD CONSTRAINT "offer_catalog_items_facts_is_array"
  CHECK (jsonb_typeof("facts") = 'array');

-- **報酬額に負の数を入れない**
ALTER TABLE "offer_catalog_items"
  ADD CONSTRAINT "offer_catalog_items_reward_yen_non_negative"
  CHECK ("reward_yen" IS NULL OR "reward_yen" >= 0);

-- **事実が空のまま「確かめた」ことにしない。**
-- `facts_updated_at` が入る＝確かめた（D-13・Q-022）。
-- 空の配列に時刻だけ入ると、「確かめた結果、書ける数値が無い」と
-- 「まだ確かめていない」の区別がつかなくなる
ALTER TABLE "offer_catalog_items"
  ADD CONSTRAINT "offer_catalog_items_facts_checked_has_facts"
  CHECK ("facts_updated_at" IS NULL OR jsonb_array_length("facts") > 0);

-- **モニターに出すものは事実を確かめてある。**
-- DRAFT のあいだは調べている途中でよい
ALTER TABLE "offer_catalog_items"
  ADD CONSTRAINT "offer_catalog_items_active_is_checked"
  CHECK ("status" <> 'ACTIVE' OR "facts_updated_at" IS NOT NULL);
