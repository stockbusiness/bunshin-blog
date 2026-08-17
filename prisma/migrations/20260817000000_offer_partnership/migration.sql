-- 提携状態（Q-060、構想書13章）
--
-- 構想書13章の受け入れ条件に「**未提携・否認の案件は記事候補から
-- 除外される**」がある。いまの実装には提携という概念が無い。
--
-- ## なぜ「リンクがある＝提携済み」で足りないのか
--
-- **提携は途中で切れる。** ASPが案件を終了したり、提携を解除したりする。
-- そのときリンクは残ったままなので、**切れた案件の記事が出続ける。**
-- リンクの有無では、この状態を表せない。
--
-- ## なぜ `affiliate_url` を NULL 可にするのか
--
-- **提携の申請から承認までに数日かかる。** その間リンクは発行できない。
-- いまの作りでは、**承認されるまで案件を登録できない** — モニターは
-- 「あの案件を申請した」ことをどこにも置けず、覚えておくしかない
-- （Q-058 の「覚えておかせない」に反する）。
--
-- **承認済みならリンクが要る**という向きだけを制約にする。逆向き
-- （非承認ならリンクを消す）は入れない — 提携が一時的に切れただけで
-- **本人が発行したリンクを失う**ほうが困る。
--
-- ## 既存の行はすべて APPROVED
--
-- いまある行は全部リンクを持っている。**リンクは提携が承認されないと
-- 発行できない**ので、承認済みだったことが分かる。
--
-- ## 既定値を入れない
--
-- `partnership_status` に DEFAULT を置くと、**書き忘れた経路が
-- 黙って「提携済み」になる。** 記事候補に入るかどうかを決める値なので、
-- 入れるたびに明示させる。

-- CreateEnum
CREATE TYPE "PartnershipStatus" AS ENUM (
  'NOT_APPLIED',
  'APPLIED',
  'APPROVED',
  'REJECTED'
);

-- AlterTable
ALTER TABLE "affiliate_offers" ADD COLUMN "partnership_status" "PartnershipStatus";

-- **いまある行はすべて承認済み**（リンクを持っている）
UPDATE "affiliate_offers" SET "partnership_status" = 'APPROVED';

ALTER TABLE "affiliate_offers" ALTER COLUMN "partnership_status" SET NOT NULL;

-- **申請中はリンクを持てない**
ALTER TABLE "affiliate_offers" ALTER COLUMN "affiliate_url" DROP NOT NULL;

-- **承認済みならリンクが要る。** 逆は縛らない（上記）
ALTER TABLE "affiliate_offers"
  ADD CONSTRAINT "affiliate_offers_approved_needs_link_check"
  CHECK ("partnership_status" <> 'APPROVED' OR "affiliate_url" IS NOT NULL);

-- 記事候補を絞るときに引く
CREATE INDEX "affiliate_offers_blog_id_partnership_status_idx"
  ON "affiliate_offers"("blog_id", "partnership_status");
