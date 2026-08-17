import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';
import { RichMenuEditor } from './_components/rich-menu-editor';
import { BackLink, Card, Page, PageHeader } from '../_components/ui';

/**
 * `/admin/rich-menu` LINEのリッチメニュー（Q-054、TASKS H-6）。
 *
 * ## なぜここで作るのか
 *
 * `docs/MANUAL.md` は「LINEのメニューから開く」と書いているのに、
 * **実物が無い。** モニターを迎える前に要る。
 *
 * LINE公式アカウントマネージャーでも作れるが、**行き先が
 * `LIFF_BASE_URL` を含むURL**である。IDが変わると**全部のボタンが
 * 黙って壊れる**（押しても何も起きない）。ここから作れば押し直すだけで済む。
 *
 * ## 引き換えに失うもの
 *
 * **APIで作ったリッチメニューは、LINE公式アカウントマネージャーの
 * 画面から編集できなくなる**（LINE の仕様）。画面にもそう書く —
 * 後から知ると、直せない状態で気づくことになる。
 */

export const dynamic = 'force-dynamic';

export default async function AdminRichMenuPage() {
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
        title="LINEのメニュー"
        lead="トークの下に出るメニューです。モニター全員に同じものが出ます。"
      />

      <Card tone="warn">
        <p className="text-sm leading-relaxed text-slate-700">
          <strong>
            ここで作ると、LINE公式アカウントマネージャーからは編集できなくなります。
          </strong>
          LINEの仕様です。両方から触ることはできません。
        </p>
      </Card>

      <RichMenuEditor />

      <BackLink />
    </Page>
  );
}
