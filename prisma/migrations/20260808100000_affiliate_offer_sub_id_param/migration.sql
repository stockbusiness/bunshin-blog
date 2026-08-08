-- サブIDのパラメータ名（D-10・OPEN_QUESTIONS Q-014）。
--
-- ASPによって名前が違う（sub / s1 / argument など）。名前をデータで持ち、
-- **NULL ならサブIDを付けない。**
--
-- 既定を NULL にすることで、ASPの情報がゼロでも案件は登録できる。
-- サブIDが付かないだけで、分かったものから ADMIN が SQL で埋める。

-- AlterTable
ALTER TABLE "affiliate_offers" ADD COLUMN     "sub_id_param" TEXT;

