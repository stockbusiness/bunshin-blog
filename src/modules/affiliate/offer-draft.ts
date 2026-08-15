/**
 * 紹介先のページから案件の下書きを作る（Q-053、段8）。
 *
 * ## なぜ作るのか
 *
 * **段8の入力が面倒だと実地で言われた**（2026-08-15）。段4（分身の
 * 24項目・Q-047）と同じ形の詰まりで、**モニターを迎える前に潰す**。
 *
 * ## AIに決めさせない
 *
 * ここが返すのは**下書き**である。**保存はしない。** 画面へ出して、
 * **人が見て直してから**登録する（CONTENT_PLANNING 1.1「AIは案を出す係」）。
 *
 * **とくに `facts` は下書きのまま通してはいけない。** `facts` は
 * **記事に書ける数値の出どころ**で（SPEC 9.6）、登録すると
 * `facts_updated_at` が入る＝「確かめた」ことになる（D-13・Q-022）。
 * **確かめるのは人。** 画面がそう書く。
 *
 * ## ASP のものは拾えない
 *
 * **ASPの名前とアフィリエイトリンクは LP に無い。** ASPの管理画面に
 * しかないので、**手入力のまま残す。** 拾えないものを拾ったふりをしない。
 *
 * ## 取得は必ず `safeFetch`
 *
 * 宛先はモニターが入力したURL（C-7、SPEC 14.3）。`lp-evaluation` と
 * 同じ制限（時間・バイト数・Content-Type）で読む。
 */

import { safeFetch } from '@/lib/http';
import { z } from 'zod';
import type { AiOperation, AiProvider } from '@/lib/ai';
import { lpFetchFailedError, LP_ERROR_CODES } from './errors';
import { LP_CONTENT_TYPES, LP_MAX_BYTES, LP_TIMEOUT_MS } from './lp-evaluation';
import { CONVERSION_TYPES, type ConversionType } from './types';

/**
 * AIへ渡す本文の上限（文字）。
 *
 * **LPは長い。** 全部渡すと費用が跳ねるうえ、後半は問い合わせフォームや
 * 会社概要で、**事実はたいてい前半にある。**
 */
const MAX_TEXT_LENGTH = 6000;

/** 事実として拾う上限。多すぎると人が確かめきれない */
const MAX_FACTS = 12;

/** 抽出なので 0。案を出す場面ではない（CONTENT_PLANNING 1.2） */
const TEMPERATURE_EXTRACTION = 0;

/** 低コストの段でよい。判断ではなく書き写し（SPEC 9.8） */
const OPERATION: AiOperation = 'FACT_CLAIM_EXTRACT';

export const OFFER_DRAFT_PROMPT_KEY = 'affiliate.offer_draft';

const draftSchema = z.object({
  name: z.string().trim().min(1).max(200),
  conversionType: z.enum(CONVERSION_TYPES as unknown as [string, ...string[]]),
  facts: z.array(z.string().trim().min(1).max(200)).max(MAX_FACTS).default([]),
});

export interface OfferDraft {
  name: string;
  conversionType: ConversionType;
  /** 1行に1つ（Q-050）。**下書き。人が確かめる** */
  facts: string[];
}

/**
 * HTMLを本文らしい文字列へ均す。
 *
 * **見た目を保たない。** AIへ渡すのは中身だけでよく、
 * タグを残すとその分だけ費用になる。
 *
 * `script` と `style` は**中身ごと落とす。** JavaScript の文字列が
 * 「事実」として拾われる。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

export interface DraftOfferDeps {
  provider: AiProvider;
  /** 差し替え用。既定は `safeFetch`（C-7） */
  fetchFn?: typeof safeFetch;
}

/**
 * LPを読んで下書きを作る。
 *
 * @throws {AppError} LPを取得できなかった場合
 * @throws {AppError} AIの応答が読めなかった場合
 */
export async function draftOfferFromLandingPage(
  landingPageUrl: string,
  deps: DraftOfferDeps,
): Promise<OfferDraft> {
  const fetchFn = deps.fetchFn ?? safeFetch;

  let response;
  try {
    response = await fetchFn(landingPageUrl, {
      method: 'GET',
      timeoutMs: LP_TIMEOUT_MS,
      maxBytes: LP_MAX_BYTES,
      allowedContentTypes: LP_CONTENT_TYPES,
    });
  } catch {
    // **到達できない理由を細かく返さない**（SPEC 14.3・`lp-evaluation` と同じ）
    throw lpFetchFailedError(
      LP_ERROR_CODES.lpUnavailable,
      'ページを読み取れませんでした。URLを確かめるか、手で入力してください',
    );
  }

  if (response.status >= 400) {
    throw lpFetchFailedError(
      LP_ERROR_CODES.lpUnavailable,
      `ページを読み取れませんでした（HTTP ${response.status}）。手で入力してください`,
    );
  }

  const text = htmlToText(response.body);

  if (text === '') {
    throw lpFetchFailedError(
      LP_ERROR_CODES.lpUnavailable,
      'ページに読み取れる文字がありませんでした。手で入力してください',
    );
  }

  const result = await deps.provider.complete({
    operation: OPERATION,
    system: [
      'あなたはアフィリエイト案件の登録を手伝う係です。',
      '渡されたランディングページの本文から、次を書き出してください。',
      '',
      '- name: 商品・サービスの名前（200字以内）',
      `- conversionType: 成果になる条件。${CONVERSION_TYPES.join(' / ')} のいずれか`,
      '- facts: 価格・条件・機能などの事実。1件ずつ短く。最大12件',
      '',
      '**本文に書いていないことを足さないでください。**',
      '**推測しないでください。** 分からない項目は facts に入れないでください。',
      '**数値は本文のとおりに写してください**（丸めない・単位を変えない）。',
      'JSONだけを返してください。前置き・後書き・コードフェンスを付けないでください。',
    ].join('\n'),
    messages: [{ role: 'user', content: text }],
    maxOutputTokens: 1200,
    temperature: TEMPERATURE_EXTRACTION,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(result.text));
  } catch {
    // **応答本文を例外へ載せない**（SPEC 14.2）
    throw lpFetchFailedError(
      LP_ERROR_CODES.lpUnavailable,
      '読み取れませんでした。手で入力してください',
    );
  }

  const draft = draftSchema.safeParse(parsed);
  if (!draft.success) {
    throw lpFetchFailedError(
      LP_ERROR_CODES.lpUnavailable,
      '読み取れませんでした。手で入力してください',
    );
  }

  return {
    name: draft.data.name,
    conversionType: draft.data.conversionType as ConversionType,
    // **重複を落とす。** 同じ記述が2つあっても人が確かめる手間が増えるだけ
    facts: [...new Set(draft.data.facts)],
  };
}

/** コードフェンスが付いてきた場合に剥がす（`content-planning` と同じ理由） */
function stripFence(text: string): string {
  const trimmed = text.trim();

  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}
