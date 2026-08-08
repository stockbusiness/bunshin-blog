-- 記事本文へ埋めるアフィリエイトリンクの出し方（D-9・OPEN_QUESTIONS Q-001）。
--
-- ASPによって、別ドメインのリダイレクタ経由の掲載を許すところと
-- 許さないところがある。方式を1つに決めず、案件ごとに持つ。
--
-- **既定は DIRECT（安全側）。** 既存行もこの既定で埋まる。
-- 規約を確認できたASPだけ REDIRECT へ上げる。判断がつかないものを
-- 許可側へ倒すと、成果が無効になったときに取り返しがつかない。

-- CreateEnum
CREATE TYPE "LinkMode" AS ENUM ('REDIRECT', 'DIRECT');

-- AlterTable
ALTER TABLE "affiliate_offers" ADD COLUMN     "link_mode" "LinkMode" NOT NULL DEFAULT 'DIRECT';

