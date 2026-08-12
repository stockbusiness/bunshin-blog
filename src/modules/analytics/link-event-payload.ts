/**
 * 受信APIが受け取る電文の検証（TASKS D-12、Q-001 の再決定）。
 *
 * DBもネットワークも触らない純粋な処理。
 *
 * ## 送られてくるもの
 *
 * 各ブログのWordPressに入れたスニペットが `/go/{code}` を処理し、
 * **クリックの記録だけ**をまとめて送ってくる。
 *
 * ```json
 * { "events": [
 *   { "eventId": "...", "code": "...", "clickedAt": "2026-08-12T03:00:00.000Z",
 *     "referrerHost": "example.com", "userAgentHash": "<sha256 hex>" }
 * ] }
 * ```
 *
 * ## 生のUAとURLは受け取らない
 *
 * **ホスト名とUAのハッシュだけ**を受ける（`click.ts` と同じ方針）。
 * 生の値を送らせると、**送信の途中と受信側のログに個人に近い値が残る。**
 * ハッシュは塩無しの sha256 なので、WordPress 側でも同じ値を作れる。
 *
 * ## 壊れた1件で全部を落とさない
 *
 * **送信元は再送する。** 1件でも弾いて 400 を返すと、**その1件のせいで
 * 同じ電文が延々と送られ続ける。** 通るものだけ通し、落としたものは数える。
 */

import { REFERRER_HOST_MAX_LENGTH } from './click';

/** 1回の電文で受ける上限。**これを超える分は落とす**（送信元は次回に回す） */
export const MAX_EVENTS_PER_REQUEST = 500;

/** 識別子の長さの上限。UUID でも 36 文字 */
export const EVENT_ID_MAX_LENGTH = 64;

/**
 * 受け入れる時刻の幅。
 *
 * **未来は受けない**（送信元の時計がずれていても、集計の日付が飛ばない）。
 * 過去は再送を見込んで広めに取る。
 */
export const MAX_FUTURE_MS = 5 * 60 * 1000;
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const HOST_PATTERN = /^[a-z0-9.-]+$/;

/** 検証を通った1件。`code` の解決（案件かバナーか）は呼び出し側 */
export interface ParsedLinkEvent {
  eventId: string;
  code: string;
  clickedAt: Date;
  referrerHost: string | null;
  userAgentHash: string | null;
}

export interface ParsedLinkEvents {
  events: ParsedLinkEvent[];
  /** 形が通らずに落とした件数。**黙って捨てない**（応答に載せる） */
  rejected: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEventId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (
    trimmed === '' ||
    trimmed.length > EVENT_ID_MAX_LENGTH ||
    !EVENT_ID_PATTERN.test(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

/**
 * 時刻を読む。
 *
 * **未来と古すぎるものは落とす。** 送信元の時計は当てにできない。
 * 受け入れると、集計（G-6）が存在しない日に数を積む。
 */
function parseClickedAt(value: unknown, now: Date): Date | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const diff = parsed.getTime() - now.getTime();

  if (diff > MAX_FUTURE_MS || -diff > MAX_AGE_MS) {
    return null;
  }

  return parsed;
}

/** ホスト名。**取れないのは異常ではない**（`Referer` は付かないことがある） */
function parseHost(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const host = value.trim().toLowerCase();

  if (
    host === '' ||
    host.length > REFERRER_HOST_MAX_LENGTH ||
    !HOST_PATTERN.test(host)
  ) {
    return null;
  }

  return host;
}

/**
 * UAのハッシュ。
 *
 * **形を確かめる。** 任意の文字列を通すと、送信元が生のUAを入れてきても
 * そのまま保存してしまう（`link_clicks` に戻せる値を残さない）。
 */
function parseUserAgentHash(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const hash = value.trim().toLowerCase();

  return SHA256_HEX_PATTERN.test(hash) ? hash : null;
}

/**
 * 電文を検証する。
 *
 * **`code` の形はここで見ない。** 案件のコードとバナーのコードで長さが
 * 違いうるため、実在するかどうかと合わせて呼び出し側が確かめる。
 */
export function parseLinkEvents(
  body: unknown,
  now: Date = new Date(),
): ParsedLinkEvents {
  if (!isRecord(body) || !Array.isArray(body['events'])) {
    return { events: [], rejected: 0 };
  }

  const raw = body['events'];
  // **上限を超えた分は落とす。** 送信元は残りを次回に回す
  const target = raw.slice(0, MAX_EVENTS_PER_REQUEST);
  const events: ParsedLinkEvent[] = [];
  const seen = new Set<string>();

  for (const item of target) {
    if (!isRecord(item)) {
      continue;
    }

    const eventId = parseEventId(item['eventId']);
    const clickedAt = parseClickedAt(item['clickedAt'], now);
    const code = typeof item['code'] === 'string' ? item['code'].trim() : '';

    if (eventId === null || clickedAt === null || code === '') {
      continue;
    }

    // **同じ電文の中の重複もここで落とす。** DBの unique に任せると、
    // 1回の `createMany` が丸ごと失敗する
    if (seen.has(eventId)) {
      continue;
    }
    seen.add(eventId);

    events.push({
      eventId,
      code,
      clickedAt,
      referrerHost: parseHost(item['referrerHost']),
      userAgentHash: parseUserAgentHash(item['userAgentHash']),
    });
  }

  return { events, rejected: raw.length - events.length };
}
