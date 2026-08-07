import { describe, expect, it, vi } from 'vitest';
import {
  MailNotConfiguredError,
  MailSendError,
  RESEND_ENDPOINT,
  createResendMailer,
  createUnconfiguredMailer,
  readResendConfig,
} from '@/lib/mailer';

/**
 * メール送信（TASKS B-11、OPEN_QUESTIONS Q-013）。
 *
 * **実際には送らない。** `fetch` を差し替えて、送る内容と失敗の扱いだけを
 * 確かめる。
 */

const CONFIG = {
  apiKey: 're_test_key',
  from: 'BUNSHIN <no-reply@example.test>',
};

const MESSAGE = {
  to: 'admin@example.test',
  subject: '件名',
  text: '本文',
};

/** 送信が失敗したときの例外を取り出す */
async function catchSendError<T extends Error>(
  promise: Promise<void>,
): Promise<T> {
  return promise.then(
    () => {
      throw new Error('例外が投げられませんでした');
    },
    (thrown: unknown) => thrown as T,
  );
}

describe('readResendConfig', () => {
  it('両方そろっていれば読める', () => {
    const result = readResendConfig({
      RESEND_API_KEY: 're_x',
      MAIL_FROM: 'a@example.test',
    });

    expect(result).toEqual({
      ok: true,
      config: { apiKey: 're_x', from: 'a@example.test' },
    });
  });

  it('前後の空白を取り除く', () => {
    const result = readResendConfig({
      RESEND_API_KEY: ' re_x ',
      MAIL_FROM: ' a@example.test ',
    });

    expect(result).toEqual({
      ok: true,
      config: { apiKey: 're_x', from: 'a@example.test' },
    });
  });

  it.each([
    [{}, ['RESEND_API_KEY', 'MAIL_FROM']],
    [{ RESEND_API_KEY: 're_x' }, ['MAIL_FROM']],
    [{ MAIL_FROM: 'a@example.test' }, ['RESEND_API_KEY']],
    [{ RESEND_API_KEY: '  ', MAIL_FROM: '' }, ['RESEND_API_KEY', 'MAIL_FROM']],
  ])('不足している変数名を返す', (source, missing) => {
    const result = readResendConfig(source);

    expect(result).toEqual({ ok: false, missing });
  });

  it('**設定値そのものを返さない**（不足時）', () => {
    const result = readResendConfig({ RESEND_API_KEY: '  ' });

    expect(JSON.stringify(result)).not.toContain('re_');
  });
});

describe('createResendMailer', () => {
  it('Resend のエンドポイントへ送る', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await createResendMailer(CONFIG, {
      fetchFn: fetchFn as unknown as typeof fetch,
    }).send(MESSAGE);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe('POST');
  });

  it('APIキーを Authorization ヘッダーで送る（本文に入れない）', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await createResendMailer(CONFIG, {
      fetchFn: fetchFn as unknown as typeof fetch,
    }).send(MESSAGE);

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${CONFIG.apiKey}`);
    expect(String(init.body)).not.toContain(CONFIG.apiKey);
  });

  it('宛先・件名・本文・送信元を送る', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await createResendMailer(CONFIG, {
      fetchFn: fetchFn as unknown as typeof fetch,
    }).send(MESSAGE);

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      from: CONFIG.from,
      to: [MESSAGE.to],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    });
  });

  it.each([400, 401, 422, 429, 500])(
    'APIが %s を返すと失敗として扱う',
    async (status) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(new Response('{"error":"x"}', { status }));

      await expect(
        createResendMailer(CONFIG, {
          fetchFn: fetchFn as unknown as typeof fetch,
        }).send(MESSAGE),
      ).rejects.toBeInstanceOf(MailSendError);
    },
  );

  it('通信そのものに失敗しても例外の中身を漏らさない', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1'));

    const error = await catchSendError<Error>(
      createResendMailer(CONFIG, {
        fetchFn: fetchFn as unknown as typeof fetch,
      }).send(MESSAGE),
    );

    expect(error).toBeInstanceOf(MailSendError);
    expect(error.message).not.toContain('10.0.0.1');
  });
});

describe('createUnconfiguredMailer', () => {
  it('呼ばれた時点で設定不足として失敗する', async () => {
    const error = await catchSendError<MailNotConfiguredError>(
      createUnconfiguredMailer(['RESEND_API_KEY']).send(MESSAGE),
    );

    expect(error).toBeInstanceOf(MailNotConfiguredError);
    expect(error.missing).toEqual(['RESEND_API_KEY']);
  });

  it('不足している変数名をメッセージに載せる', async () => {
    const error = await catchSendError<MailNotConfiguredError>(
      createUnconfiguredMailer(['MAIL_FROM']).send(MESSAGE),
    );

    expect(error.message).toContain('MAIL_FROM');
  });
});
