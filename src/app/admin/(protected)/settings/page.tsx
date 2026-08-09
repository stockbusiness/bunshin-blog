import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';
import {
  CONNECTION_TARGET_LABELS,
  SETTING_GROUP_LABELS,
  listSettingsForAdmin,
  type ConnectionTarget,
  type SettingGroup,
} from '@/modules/settings';
import {
  SettingsPanel,
  type SettingsGroup,
} from './_components/settings-panel';

/**
 * `/admin/settings` 設定（TASKS H-9、OPEN_QUESTIONS Q-017）。
 *
 * 完了条件は「画面から設定と接続テストができる。秘密は末尾4文字しか
 * 表示しない」。
 *
 * **平文はここに来ない。** `listSettingsForAdmin` が伏せ字にした値だけを
 * 返す（H-7）。この画面が秘密を持つ経路は無い。
 *
 * **すべての設定を画面に置けるわけではない。** `DATABASE_URL` や
 * `ENCRYPTION_KEY` は設定を読む前に要るため環境変数のまま（Q-017）。
 * その説明を画面にも出す — 「探したのに無い」で止まらないように。
 */

export const dynamic = 'force-dynamic';

/** 群ごとの接続テストの相手。試せない群は持たない */
const TEST_TARGETS: Readonly<Partial<Record<SettingGroup, ConnectionTarget>>> =
  {
    AI: 'AI',
    MAIL: 'MAIL',
  };

/** 画面に置けない設定と、その理由 */
const ENV_ONLY: readonly { name: string; reason: string }[] = [
  { name: 'DATABASE_URL', reason: 'これが無いと設定そのものを読めません' },
  { name: 'ENCRYPTION_KEY', reason: '保存された秘密を復号する鍵です' },
  { name: 'SESSION_SECRET', reason: 'この画面へ入る認証に使います' },
  { name: 'APP_BASE_URL', reason: 'ログインのリンクを組み立てます' },
  { name: 'LINE_LOGIN_CHANNEL_ID', reason: 'LIFF の認証に使います' },
  { name: 'CRON_SECRET', reason: 'アプリの外（cron）から使います' },
  {
    name: 'NEXT_PUBLIC_LIFF_ID',
    reason: 'ブラウザ向けはビルド時に埋め込まれます',
  },
];

export default async function AdminSettingsPage() {
  // レイアウトでも弾いているが、**レイアウトの判定だけに頼らない**（B-6）。
  // 理由の表示はレイアウトの仕事なので、ここでは何も描かずに戻る
  const admin = await requireAdmin((await headers()).get('cookie')).catch(
    () => null,
  );
  if (admin === null) {
    return null;
  }

  const settings = await listSettingsForAdmin();
  const groups = new Map<SettingGroup, SettingsGroup>();

  for (const setting of settings) {
    const existing = groups.get(setting.group);
    const row = {
      ...setting,
      choices: setting.choices === null ? null : [...setting.choices],
      updatedAt: setting.updatedAt?.toISOString() ?? null,
    };

    if (existing === undefined) {
      groups.set(setting.group, {
        group: setting.group,
        label: SETTING_GROUP_LABELS[setting.group],
        target: TEST_TARGETS[setting.group] ?? null,
        settings: [row],
      });
      continue;
    }

    existing.settings.push(row);
  }

  return (
    <div>
      <h1 className="text-lg font-bold">設定</h1>
      <p className="mt-2 text-sm leading-relaxed">
        ここで保存した値が環境変数より優先されます。
        <strong className="font-bold">
          APIキーは保存すると読み返せません。
        </strong>
        末尾4文字だけを表示します。差し替えるときは新しい値を入力して保存します。
      </p>
      <p className="mt-1 text-sm leading-relaxed">
        保存する前に
        <strong className="font-bold">接続テスト</strong>
        を実行できます（入力しただけの値で試します）。
        {Object.values(CONNECTION_TARGET_LABELS).join(' と ')}
        を確かめられます。
      </p>

      <SettingsPanel groups={[...groups.values()]} />

      <section className="mt-12 border-t pt-4">
        <h2 className="text-base font-bold">この画面に置けない設定</h2>
        <p className="mt-1 text-sm leading-relaxed">
          設定はデータベースにあり、データベースを読むには設定が要ります。
          次の値は環境変数（Vercel の設定）で変更してください。
        </p>
        <dl className="mt-3 flex flex-col gap-2 text-sm">
          {ENV_ONLY.map((item) => (
            <div key={item.name} className="flex flex-wrap gap-x-2">
              <dt className="font-bold">{item.name}</dt>
              <dd>{item.reason}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
