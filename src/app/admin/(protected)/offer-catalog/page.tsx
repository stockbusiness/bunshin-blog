import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';
import { BackLink, Card, Page, PageHeader } from '../_components/ui';
import { CatalogEditor } from './_components/catalog-editor';

/**
 * `/admin/offer-catalog` 案件カタログ（Q-055、段8）。
 *
 * ## なぜ運営が作るのか
 *
 * **「案件を決めるのが大変」**と実地で言われた。30ブログが同じ案件を
 * 別々に調べるより、**運営が1回調べて配る**ほうが正確で速い。
 *
 * `link_mode`・`sub_id_param`・`blog_posting_prohibited` は
 * **もともとADMINが決める列**（ASPの規約判断だから）。ここがその置き場所。
 *
 * ## ここが間違うと全モニターの記事が間違う
 *
 * `facts` は記事に書ける数値の出どころ（SPEC 9.6）。
 * **`ACTIVE` にする前に必ず人が確かめる。**
 */

export const dynamic = 'force-dynamic';

export default async function AdminOfferCatalogPage() {
  // **レイアウトの判定だけに頼らない**（B-6・`genres/page.tsx` と同じ）
  const admin = await requireAdmin((await headers()).get('cookie')).catch(
    () => null,
  );

  if (admin === null) {
    return null;
  }

  return (
    <Page>
      <PageHeader
        title="案件カタログ"
        lead="モニターが段8で選ぶ案件です。ここに登録したものから選んでもらいます。"
      />

      <Card tone="warn">
        <p className="text-sm leading-relaxed text-slate-700">
          <strong>ここで入れた事実が、全モニターの記事に載ります。</strong>
          記事に書ける数値は案件の「事実」から取ります（SPEC 9.6）。
          <strong>「選べる」にする前に、必ず確かめてください。</strong>
        </p>
      </Card>

      <CatalogEditor />

      <BackLink />
    </Page>
  );
}
