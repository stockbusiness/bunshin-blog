-- ブログ掲載禁止のフラグ（E-5-schema、OPEN_QUESTIONS Q-019）。
--
-- SPEC 9.2.3 は「ブログ掲載禁止」を案件の足切り条件に挙げているが、
-- **判定できる列が無かった。**
--
-- `deny_conditions`（文字列の配列）の文言から機械判定しない。
-- 「ブログ掲載不可」「ブログNG」「自社メディアのみ」など表記が揺れ、
-- **黙って通す（禁止なのに採用する）のも、黙って落とす（禁止でないのに
-- 除外する）のも起きる。** 前者は規約違反、後者は成果の機会損失で、
-- どちらも気づきにくい。
--
-- ASPの規約の判断なので ADMIN が設定する（`link_mode`・`sub_id_param` と
-- 同じ扱い。SPEC 10.3）。既定は `false` — **ここだけは安全側に倒さない。**
-- 既定を `true` にすると、設定されるまで全案件が足切りされ、
-- STEP 2 が常に0件になって STEP 1 へ差し戻され続ける。

-- AlterTable
ALTER TABLE "affiliate_offers" ADD COLUMN "blog_posting_prohibited" BOOLEAN NOT NULL DEFAULT false;
