import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SettingsPanel,
  type SettingsGroup,
} from '@/app/admin/(protected)/settings/_components/settings-panel';
import {
  SettingsApiError,
  clearSetting,
  saveSetting,
  testConnection,
  type SettingJson,
} from '@/app/admin/(protected)/settings/_lib/settings-api';

/**
 * 設定画面の操作（TASKS H-9、Q-017）の描画（TASKS B-9 の基盤）。
 *
 * 確かめるのは3点。
 *
 * 1. **秘密の平文が画面に出ない**
 * 2. **空のまま保存できない**（伏せ字を送り返して鍵を壊さない）
 * 3. **接続テストが入力途中の値を渡す**（保存してから試す順序にしない）
 */

vi.mock(
  '@/app/admin/(protected)/settings/_lib/settings-api',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/app/admin/(protected)/settings/_lib/settings-api')
      >();

    return {
      ...actual,
      saveSetting: vi.fn(),
      clearSetting: vi.fn(),
      testConnection: vi.fn(),
    };
  },
);

function setting(overrides: Partial<SettingJson> = {}): SettingJson {
  return {
    key: 'ANTHROPIC_API_KEY',
    group: 'AI',
    label: 'Anthropic APIキー',
    description: '保存すると読み返せません',
    secret: true,
    choices: null,
    source: 'UNSET',
    display: null,
    updatedAt: null,
    updatedByUserId: null,
    ...overrides,
  };
}

function groups(settings: SettingJson[]): SettingsGroup[] {
  return [{ group: 'AI', label: 'AI（生成）', target: 'AI', settings }];
}

beforeEach(() => {
  vi.mocked(saveSetting).mockResolvedValue(
    setting({ source: 'DB', display: '••••••••ABCD' }),
  );
  vi.mocked(clearSetting).mockResolvedValue(setting());
  vi.mocked(testConnection).mockResolvedValue({
    target: 'AI',
    ok: true,
    message: '鍵が通り、設定したモデルも見つかりました',
    code: null,
    detail: { モデル数: 3 },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('秘密の表示', () => {
  /** **これが完了条件。** 末尾4文字しか出さない */
  it('伏せ字だけを出す', () => {
    render(
      <SettingsPanel
        groups={groups([setting({ source: 'DB', display: '••••••••ABCD' })])}
      />,
    );

    expect(screen.getByText(/••••••••ABCD/)).toBeInTheDocument();
  });

  it('入力欄は空から始まる', () => {
    render(
      <SettingsPanel
        groups={groups([setting({ source: 'DB', display: '••••••••ABCD' })])}
      />,
    );

    expect(screen.getByLabelText('Anthropic APIキー')).toHaveValue('');
  });

  /** どこから来た値かが分からないと「設定したのに効かない」を追えない */
  it.each([
    ['DB', 'この画面'],
    ['ENV', '環境変数'],
    ['UNSET', '未設定'],
    ['UNREADABLE', '復号できません'],
  ])('%s の値は「%s」と出す', (source, label) => {
    render(
      <SettingsPanel
        groups={groups([setting({ source: source as SettingJson['source'] })])}
      />,
    );

    expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
  });
});

describe('保存', () => {
  /**
   * **空のまま保存させない。** 秘密は伏せ字で出るため、空の送信を通すと
   * 「見えている値を保存し直したつもり」で鍵を壊す
   */
  it('入力が空なら保存できない', () => {
    render(
      <SettingsPanel
        groups={groups([setting({ source: 'DB', display: '••••••••ABCD' })])}
      />,
    );

    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('入力すると保存できる', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel groups={groups([setting()])} />);

    await user.type(
      screen.getByLabelText('Anthropic APIキー'),
      'sk-ant-0123456789',
    );
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(saveSetting).toHaveBeenCalledWith(
      'ANTHROPIC_API_KEY',
      'sk-ant-0123456789',
    );
    expect(await screen.findByText('保存しました')).toBeInTheDocument();
  });

  /** 消せるのはこの画面で設定したものだけ。環境変数は消しようがない */
  it('環境変数の値は解除できない', () => {
    render(
      <SettingsPanel
        groups={groups([setting({ source: 'ENV', display: '••••••••WXYZ' })])}
      />,
    );

    expect(screen.getByRole('button', { name: '解除' })).toBeDisabled();
  });

  it('この画面で設定した値は解除できる', async () => {
    const user = userEvent.setup();
    render(
      <SettingsPanel
        groups={groups([setting({ source: 'DB', display: '••••••••ABCD' })])}
      />,
    );

    await user.click(screen.getByRole('button', { name: '解除' }));

    expect(clearSetting).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
    expect(await screen.findByText('解除しました')).toBeInTheDocument();
  });

  it('失敗の理由をそのまま出す', async () => {
    vi.mocked(saveSetting).mockRejectedValue(
      new SettingsApiError(
        'ANTHROPIC_API_KEY の値を確認してください：APIキーが短すぎます',
        'SETTING_INVALID_VALUE',
      ),
    );

    const user = userEvent.setup();
    render(<SettingsPanel groups={groups([setting()])} />);

    await user.type(screen.getByLabelText('Anthropic APIキー'), 'short');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/APIキーが短すぎます/)).toBeInTheDocument();
  });
});

describe('接続テスト', () => {
  /** **これが完了条件。** 保存してから試す順序にしない（H-8） */
  it('入力途中の値を渡す', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel groups={groups([setting()])} />);

    await user.type(
      screen.getByLabelText('Anthropic APIキー'),
      'sk-ant-typed-only',
    );
    await user.click(screen.getByRole('button', { name: '接続テスト' }));

    await waitFor(() => {
      expect(testConnection).toHaveBeenCalledWith('AI', {
        ANTHROPIC_API_KEY: 'sk-ant-typed-only',
      });
    });

    // **保存はしていない**
    expect(saveSetting).not.toHaveBeenCalled();
  });

  it('結果と参考情報を出す', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel groups={groups([setting()])} />);

    await user.click(screen.getByRole('button', { name: '接続テスト' }));

    expect(await screen.findByText('接続できました')).toBeInTheDocument();
    expect(
      screen.getByText('鍵が通り、設定したモデルも見つかりました'),
    ).toBeInTheDocument();
    expect(screen.getByText('モデル数:')).toBeInTheDocument();
  });

  it('繋がらない理由を出す', async () => {
    vi.mocked(testConnection).mockResolvedValue({
      target: 'AI',
      ok: false,
      message: '鍵は通りましたが、設定したモデルが見つかりません：claude-x',
      code: 'CONNECTION_NOT_FOUND',
      detail: {},
    });

    const user = userEvent.setup();
    render(<SettingsPanel groups={groups([setting()])} />);

    await user.click(screen.getByRole('button', { name: '接続テスト' }));

    expect(await screen.findByText('接続できませんでした')).toBeInTheDocument();
    expect(screen.getByText(/claude-x/)).toBeInTheDocument();
  });
});

describe('選べる値', () => {
  it('候補があれば選択肢にする', () => {
    render(
      <SettingsPanel
        groups={groups([
          setting({
            key: 'AI_PROVIDER',
            label: 'プロバイダー',
            secret: false,
            choices: ['anthropic', 'openai'],
          }),
        ])}
      />,
    );

    expect(screen.getByLabelText('プロバイダー')).toHaveProperty(
      'tagName',
      'SELECT',
    );
    expect(
      screen.getByRole('option', { name: 'anthropic' }),
    ).toBeInTheDocument();
  });
});
