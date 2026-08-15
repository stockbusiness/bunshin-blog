/**
 * `/api/genres` をブラウザから呼ぶ（段7・Q-049）。
 *
 * **読むだけ。** ジャンルを足すのも、ブログへ付けるのも ADMIN の操作で、
 * ここからは呼べない（`ymyl_risk` を自己申告にすると、停止条件を
 * 申告で回避できる）。
 */

export interface GenreJson {
  id: string;
  name: string;
  category: string;
  ymylRisk: 'HIGH' | 'MEDIUM' | 'LOW';
  status: 'CANDIDATE' | 'APPROVED' | 'REJECTED';
}

/** 画面に出せる失敗。原因を推測せず、サーバーの文言をそのまま使う */
export class GenreApiError extends Error {
  override readonly name = 'GenreApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const NETWORK_MESSAGE = '通信に失敗しました。電波の良い場所でお試しください';
const UNEXPECTED_MESSAGE = '処理できませんでした。時間をおいてお試しください';

interface ErrorBody {
  error?: { message?: string };
}

export async function fetchGenres(): Promise<{ genres: GenreJson[] }> {
  let response: Response;

  try {
    response = await fetch('/api/genres');
  } catch {
    throw new GenreApiError(0, NETWORK_MESSAGE);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const message = (body as ErrorBody | undefined)?.error?.message;

    throw new GenreApiError(
      response.status,
      message === undefined || message === '' ? UNEXPECTED_MESSAGE : message,
    );
  }

  return body as { genres: GenreJson[] };
}
