'use client';

import { useId, useState } from 'react';
import {
  SettingsApiError,
  clearSetting,
  saveSetting,
  testConnection,
  type ConnectionTestJson,
  type SettingJson,
} from '../_lib/settings-api';

/**
 * `/admin/settings` の操作部分（TASKS H-9、OPEN_QUESTIONS Q-017）。
 *
 * **秘密は表示しない。** 受け取るのは伏せ字だけで、この画面が平文を
 * 持つことはない。入力欄は常に空から始まり、**空のまま保存はしない** —
 * 伏せ字を送り返して保存済みの鍵を壊さないため。
 *
 * **接続テストは入力途中の値で行う。** 保存してから試す順序にしない（H-8）。
 */

const SOURCE_LABELS: Record<SettingJson['source'], string> = {
  DB: 'この画面',
  ENV: '環境変数',
  UNSET: '未設定',
  UNREADABLE: '復号できません',
};

export interface SettingsGroup {
  group: string;
  label: string;
  /** 接続テストの相手。試せない群なら `null` */
  target: string | null;
  settings: SettingJson[];
}

export function SettingsPanel({ groups }: { groups: SettingsGroup[] }) {
  return (
    <div className="mt-6 flex flex-col gap-10">
      {groups.map((group) => (
        <SettingsGroupSection key={group.group} group={group} />
      ))}
    </div>
  );
}

function SettingsGroupSection({ group }: { group: SettingsGroup }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTestJson | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  async function runTest() {
    if (group.target === null) {
      return;
    }

    setTesting(true);
    setResult(null);
    setTestError(null);

    try {
      setResult(await testConnection(group.target, drafts));
    } catch (error) {
      setTestError(
        error instanceof SettingsApiError
          ? error.message
          : '接続テストを実行できませんでした',
      );
    } finally {
      setTesting(false);
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-2">
        <h2 className="text-base font-bold">{group.label}</h2>
        {group.target === null ? null : (
          <button
            type="button"
            onClick={runTest}
            disabled={testing}
            className="border px-3 py-1 text-sm disabled:opacity-50"
          >
            {testing ? '試しています…' : '接続テスト'}
          </button>
        )}
      </div>

      {testError === null ? null : (
        <p className="mt-3 text-sm font-bold">{testError}</p>
      )}
      {result === null ? null : <TestResult result={result} />}

      <div className="mt-4 flex flex-col gap-6">
        {group.settings.map((setting) => (
          <SettingRow
            key={setting.key}
            setting={setting}
            draft={drafts[setting.key] ?? ''}
            onDraftChange={(value) => {
              setDrafts((current) => ({ ...current, [setting.key]: value }));
            }}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * 接続テストの結果。
 *
 * **応答本文は出ない**（H-8 がこちらの文言だけを返す）。参考情報として
 * モデル数や認証済みドメイン数を添える。
 */
function TestResult({ result }: { result: ConnectionTestJson }) {
  const entries = Object.entries(result.detail);

  return (
    <div className="mt-3 border p-3 text-sm">
      <p className="font-bold">
        {result.ok ? '接続できました' : '接続できませんでした'}
      </p>
      <p className="mt-1 leading-relaxed">{result.message}</p>
      {entries.length === 0 ? null : (
        <dl className="mt-2 flex flex-wrap gap-x-4 text-xs">
          {entries.map(([label, value]) => (
            <div key={label} className="flex gap-1">
              <dt>{label}:</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function SettingRow({
  setting,
  draft,
  onDraftChange,
}: {
  setting: SettingJson;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const inputId = useId();
  const [current, setCurrent] = useState(setting);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: () => Promise<SettingJson>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      setCurrent(await action());
      onDraftChange('');
      setNotice(message);
    } catch (caught) {
      setError(
        caught instanceof SettingsApiError
          ? caught.message
          : '処理できませんでした',
      );
    } finally {
      setBusy(false);
    }
  }

  // **空のまま保存させない。** 秘密は伏せ字で表示されるため、空の送信を
  // 通すと「見えている値を保存し直したつもり」で消してしまう
  const canSave = draft.trim() !== '' && !busy;
  const canClear = current.source === 'DB' && !busy;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-bold">
        {current.label}
      </label>
      <p className="text-xs leading-relaxed">{current.description}</p>

      <p className="text-xs">
        いまの値：
        {current.display ?? '—'}
        <span className="ml-2">（{SOURCE_LABELS[current.source]}）</span>
      </p>

      <div className="mt-1 flex flex-wrap items-center gap-2">
        {current.choices === null ? (
          <input
            id={inputId}
            type={current.secret ? 'password' : 'text'}
            value={draft}
            autoComplete="off"
            placeholder={current.secret ? '新しい値を入力' : ''}
            onChange={(event) => onDraftChange(event.target.value)}
            className="min-w-0 flex-1 border px-2 py-1 text-sm"
          />
        ) : (
          <select
            id={inputId}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            className="border px-2 py-1 text-sm"
          >
            <option value="">選択してください</option>
            {current.choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          disabled={!canSave}
          onClick={() => {
            void run(() => saveSetting(current.key, draft), '保存しました');
          }}
          className="border px-3 py-1 text-sm disabled:opacity-50"
        >
          保存
        </button>

        <button
          type="button"
          disabled={!canClear}
          onClick={() => {
            void run(() => clearSetting(current.key), '解除しました');
          }}
          className="border px-3 py-1 text-sm disabled:opacity-50"
        >
          解除
        </button>
      </div>

      {error === null ? null : <p className="text-xs font-bold">{error}</p>}
      {notice === null ? null : <p className="text-xs">{notice}</p>}
    </div>
  );
}
