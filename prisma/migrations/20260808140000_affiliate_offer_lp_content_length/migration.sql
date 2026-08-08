-- LPのページ長（D-2・SPEC 9.2.3）。
--
-- SPEC 9.2.3 は「`landing_page_url` をHTMLで取得し、input要素数・ページ長・
-- viewport指定の有無を機械判定する」と定めている。このうち **input要素数と
-- viewport には保存先があるのに、ページ長だけ無かった**。
--
-- ページ長はスコア（9.2.3 の100点）にも足切りにも使われない。
-- それでも残すのは、**判定した値が消えると「なぜこの案件が落ちたのか」を
-- 後から確かめられない**ため。
--
-- 値は取得したHTMLのバイト数。NULL は「まだ評価していない」。

-- AlterTable
ALTER TABLE "affiliate_offers" ADD COLUMN     "lp_content_length" INTEGER;
